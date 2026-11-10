/**
 * Harvest runtime: search, OA resolution, sufficiency and REP persistence.
 *
 * A run is a deterministic record: topic, queries, per-round source counts and
 * errors, merged papers, sufficiency report. It is captured as one JSON
 * snapshot and registered as one REP evidence item (or written under
 * `<root>/runs/` when the REP service is not mounted). No LLM sits in this path.
 *
 * @module dsh-lit-harvest/runtime
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AddEvidenceInput,
  CaptureInput,
  CheckResult,
  Evidence,
  Snapshot,
  SourceRef,
} from '@perrylink/dsh-research-core'
import type { ResolvedConfig, SourceName } from './config.ts'
import { createHttpClient, type HttpClient } from './http.ts'
import { searchAll, type MergedPaper, type SearchResult } from './search.ts'
import { checkSufficiency, type SufficiencyReport } from './sufficiency.ts'
import { unpaywallLookup } from './providers.ts'
import { VERSION } from './version.ts'

/** The subset of the REP service this plugin needs. */
export interface EvidencePort {
  capture(input: CaptureInput): Promise<{ snapshot: Snapshot }>
  addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence }>
}

/** One harvest round. */
export interface HarvestRound {
  readonly round: number
  readonly query: string
  readonly found: number
  readonly newPapers: number
  readonly sufficient: boolean
  readonly gaps: readonly string[]
  readonly perSource: Readonly<Partial<Record<SourceName, number>>>
  readonly errors: readonly { readonly source: SourceName; readonly code: string; readonly message: string }[]
}

/** The persisted run record. */
export interface HarvestRunRecord {
  readonly schema: 'lit-harvest/run-v1'
  readonly runId: string
  readonly topic: string
  readonly subtopics: readonly string[]
  readonly generatedAt: string
  readonly plugin: { readonly name: string; readonly version: string }
  readonly settings: {
    readonly sources: readonly SourceName[]
    readonly perRound: number
    readonly maxRounds: number
    readonly minCore: number
    readonly minTotal: number
  }
  readonly rounds: readonly HarvestRound[]
  readonly papers: readonly MergedPaper[]
  readonly sufficiency: SufficiencyReport
}

/** Where the run landed. */
export type Persistence =
  | { readonly mode: 'rep'; readonly evidenceId: string; readonly snapshotId: string }
  | { readonly mode: 'file'; readonly path: string; readonly reason?: string }
  | { readonly mode: 'none'; readonly reason: string }

/** The result of one harvest loop. */
export interface HarvestOutcome {
  readonly record: HarvestRunRecord
  readonly persistence: Persistence
  readonly warnings: readonly string[]
}

/** Options for a harvest loop. */
export interface HarvestRequest {
  readonly topic: string
  readonly subtopics?: readonly string[]
  readonly sources?: readonly SourceName[]
  readonly maxRounds?: number
  readonly perRound?: number
  readonly minCore?: number
  readonly minTotal?: number
  readonly yearFrom?: number
  readonly yearTo?: number
  readonly oaOnly?: boolean
  readonly persist?: boolean
}

/** One OA resolution input. */
export interface OaItem {
  readonly doi?: string
  readonly title?: string
  readonly pdfUrl?: string
}

/** One OA resolution result. */
export interface OaResult {
  readonly doi?: string
  readonly title?: string
  readonly pdfUrls: readonly string[]
  readonly landingUrl?: string
  readonly isOa?: boolean
  readonly error?: { readonly code: string; readonly message: string }
}

/** Runtime construction options. */
export interface HarvestRuntimeOptions {
  readonly config: ResolvedConfig
  readonly client?: HttpClient
  readonly service?: EvidencePort
  readonly now?: () => Date
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function runIdOf(topic: string, subtopics: readonly string[], queries: readonly string[], papers: readonly MergedPaper[]): string {
  const seed = JSON.stringify({
    topic,
    subtopics,
    queries,
    papers: papers.map(paper => paper.doi ?? paper.arxivId ?? paper.title),
  })
  return sha256(seed).slice(0, 16)
}

function paperKey(paper: MergedPaper): string {
  const doi = paper.doi?.toLowerCase()
  if (doi !== undefined && doi !== '') return `doi:${doi}`
  if (paper.arxivId !== undefined) return `arxiv:${paper.arxivId}`
  return `title:${paper.title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`
}

/** The harvest runtime. */
export class HarvestRuntime {
  /** Resolved config. */
  readonly config: ResolvedConfig
  private readonly client: HttpClient
  private readonly service: EvidencePort | undefined
  private readonly now: () => Date

  constructor(options: HarvestRuntimeOptions) {
    this.config = options.config
    this.client = options.client ?? createHttpClient({
      timeoutMs: options.config.timeoutMs,
      minIntervalMs: options.config.minIntervalMs,
      retries: options.config.retries,
      userAgent: options.config.userAgent,
    })
    this.service = options.service
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Search the configured sources once.
   * @param query - bibliographic query.
   * @param options - sources, limits, filters.
   * @returns the merged search result.
   */
  async search(query: string, options: {
    sources?: readonly SourceName[]
    max?: number
    yearFrom?: number
    yearTo?: number
    oaOnly?: boolean
    sort?: 'relevance' | 'citations' | 'year'
  } = {}): Promise<SearchResult> {
    return searchAll(this.client, {
      query,
      max: options.max ?? this.config.maxResults,
      ...(options.sources === undefined ? {} : { sources: options.sources }),
      ...(options.yearFrom === undefined ? {} : { yearFrom: options.yearFrom }),
      ...(options.yearTo === undefined ? {} : { yearTo: options.yearTo }),
      ...(options.oaOnly === undefined ? {} : { oaOnly: options.oaOnly }),
      ...(options.sort === undefined ? {} : { sort: options.sort }),
      ...(this.config.mailto === undefined ? {} : { mailto: this.config.mailto }),
      now: this.now,
    })
  }

  /**
   * Resolve open-access links, using Unpaywall when a DOI and contact exist.
   * @param items - already-collected papers.
   * @returns one result per item.
   */
  async resolveOa(items: readonly OaItem[]): Promise<OaResult[]> {
    const results: OaResult[] = []
    for (const item of items) {
      const known = item.pdfUrl === undefined || item.pdfUrl === '' ? [] : [item.pdfUrl]
      if (item.doi === undefined || item.doi === '') {
        results.push({
          ...(item.title === undefined ? {} : { title: item.title }),
          pdfUrls: known,
        })
        continue
      }
      if (this.config.mailto === undefined) {
        results.push({
          doi: item.doi,
          ...(item.title === undefined ? {} : { title: item.title }),
          pdfUrls: known,
          error: { code: 'MAILTO_REQUIRED', message: 'set config.mailto before resolving DOIs through Unpaywall' },
        })
        continue
      }
      try {
        const lookup = await unpaywallLookup(this.client, item.doi, this.config.mailto)
        results.push({
          doi: item.doi,
          ...(item.title === undefined ? {} : { title: item.title }),
          pdfUrls: [...new Set([...known, ...lookup.pdfUrls])],
          ...(lookup.landingUrl === undefined ? {} : { landingUrl: lookup.landingUrl }),
          isOa: lookup.isOa,
        })
      } catch (error) {
        results.push({
          doi: item.doi,
          ...(item.title === undefined ? {} : { title: item.title }),
          pdfUrls: known,
          error: {
            code: (error as { code?: string }).code ?? 'LOOKUP_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
    return results
  }

  /**
   * Run the bounded harvest loop and persist the record.
   * @param request - topic, subtopics, quotas and persistence switch.
   * @returns the record, where it landed, and warnings.
   */
  async harvest(request: HarvestRequest): Promise<HarvestOutcome> {
    const topic = request.topic.trim()
    if (topic === '') throw new TypeError('topic must be a non-empty string')
    const subtopics = (request.subtopics ?? []).map(value => value.trim()).filter(value => value !== '')
    const maxRounds = request.maxRounds ?? this.config.maxRounds
    const perRound = request.perRound ?? this.config.perRound
    const minCore = request.minCore ?? this.config.minCore
    const minTotal = request.minTotal ?? this.config.minTotal
    const warnings: string[] = []
    if (this.config.mailto === undefined) warnings.push('config.mailto is unset: OpenAlex/Crossref polite-pool contact and Unpaywall lookups are unavailable')

    const queries: string[] = [topic]
    const rounds: HarvestRound[] = []
    const collected = new Map<string, MergedPaper>()
    let sufficiency = checkSufficiency({ topic, subtopics, collected: [], minCore, minTotal })
    for (let round = 1; round <= maxRounds; round += 1) {
      const query = queries.shift() ?? topic
      const result = await this.search(query, {
        ...(request.sources === undefined ? {} : { sources: request.sources }),
        max: perRound,
        ...(request.yearFrom === undefined ? {} : { yearFrom: request.yearFrom }),
        ...(request.yearTo === undefined ? {} : { yearTo: request.yearTo }),
        ...(request.oaOnly === undefined ? {} : { oaOnly: request.oaOnly }),
      })
      let newPapers = 0
      for (const paper of result.papers) {
        const key = paperKey(paper)
        if (!collected.has(key)) {
          collected.set(key, paper)
          newPapers += 1
        }
      }
      sufficiency = checkSufficiency({ topic, subtopics, collected: [...collected.values()], minCore, minTotal })
      rounds.push({
        round,
        query,
        found: result.papers.length,
        newPapers,
        sufficient: sufficiency.sufficient,
        gaps: sufficiency.gaps,
        perSource: result.perSource,
        errors: result.errors,
      })
      if (sufficiency.sufficient) break
      for (const next of sufficiency.nextQueries) {
        if (!queries.includes(next) && next !== topic) queries.push(next)
      }
    }

    const papers = [...collected.values()]
    for (const round of rounds) {
      for (const error of round.errors) warnings.push(`${round.query} · ${error.source}: ${error.code} — ${error.message}`)
    }
    const generatedAt = this.now().toISOString()
    const runId = runIdOf(topic, subtopics, rounds.map(round => round.query), papers)
    const record: HarvestRunRecord = {
      schema: 'lit-harvest/run-v1',
      runId,
      topic,
      subtopics,
      generatedAt,
      plugin: { name: 'dsh-lit-harvest', version: VERSION },
      settings: {
        sources: [...(request.sources ?? (['openalex', 'crossref', 'arxiv', 'europepmc'] as const))],
        perRound,
        maxRounds,
        minCore,
        minTotal,
      },
      rounds,
      papers,
      sufficiency,
    }
    const persistence = request.persist === false
      ? { mode: 'none' as const, reason: 'persist: false' }
      : await this.persist(record)
    return { record, persistence, warnings }
  }

  private async persist(record: HarvestRunRecord): Promise<Persistence> {
    const bytes = JSON.stringify(record, null, 2)
    const sourceRef: SourceRef = {
      kind: 'other',
      id: `lit-harvest:${record.runId}`,
      retrievedAt: record.generatedAt,
      metadata: {
        title: `Literature harvest: ${record.topic}`,
        type: 'search',
      },
    }
    if (this.service !== undefined) {
      try {
        const capture = await this.service.capture({
          bytes,
          mediaType: 'application/json',
          sourceRef,
          capturedAt: record.generatedAt,
          encoding: 'utf-8',
        })
        const okSources = record.rounds.reduce((sum, round) => sum + Object.keys(round.perSource).length, 0)
        const errors = record.rounds.reduce((sum, round) => sum + round.errors.length, 0)
        const check: CheckResult = {
          checkId: sha256(`${record.runId}:source-status`).slice(0, 16),
          check: 'source-status',
          status: okSources === 0 ? 'fail' : errors === 0 ? 'pass' : 'warn',
          detail: `${okSources} source result(s) across ${record.rounds.length} round(s); ${errors} source error(s)`,
        }
        const evidence = await this.service.addEvidence({
          title: `Literature harvest: ${record.topic}`,
          sourceRef,
          snapshotIds: [capture.snapshot.snapshotId],
          anchors: [],
          provenance: {
            plugin: 'dsh-lit-harvest',
            version: VERSION,
            method: 'deterministic multi-source search + quota/subtopic sufficiency',
            retrievedAt: record.generatedAt,
            toolRun: record.runId,
          },
          checks: [check],
          labels: ['literature-harvest'],
        })
        return { mode: 'rep', evidenceId: evidence.evidence.evidenceId, snapshotId: capture.snapshot.snapshotId }
      } catch (error) {
        const fallback = await this.writeFile(record, bytes)
        return {
          mode: 'file',
          path: fallback,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return { mode: 'file', path: await this.writeFile(record, bytes) }
  }

  private async writeFile(record: HarvestRunRecord, bytes: string): Promise<string> {
    const directory = path.join(this.config.root, 'runs')
    await mkdir(directory, { recursive: true })
    const file = path.join(directory, `${record.runId}.json`)
    await writeFile(file, bytes, 'utf8')
    return file
  }
}
