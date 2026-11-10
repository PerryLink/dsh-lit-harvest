/**
 * The four model-facing tools: search, OA resolution, sufficiency, harvest.
 * @module dsh-lit-harvest/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarvestNetworkError } from './http.ts'
import type { MergedPaper } from './search.ts'
import type { HarvestRuntime, OaItem } from './runtime.ts'
import { checkSufficiency, type PaperLike } from './sufficiency.ts'

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

const SOURCE_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description: 'Sources to query: openalex, crossref, arxiv, europepmc (default: all four).',
} as const

function failure(code: string, message: string) {
  return { ok: false as const, error: { code, message } }
}

function codeOf(error: unknown): string {
  return error instanceof HarvestNetworkError ? error.code : 'ERROR'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function paperJson(paper: MergedPaper) {
  return {
    title: paper.title,
    authors: [...paper.authors],
    ...(paper.year === undefined ? {} : { year: paper.year }),
    ...(paper.venue === undefined ? {} : { venue: paper.venue }),
    ...(paper.doi === undefined ? {} : { doi: paper.doi }),
    ...(paper.arxivId === undefined ? {} : { arxivId: paper.arxivId }),
    ...(paper.abstract === undefined ? {} : { abstract: paper.abstract }),
    ...(paper.url === undefined ? {} : { url: paper.url }),
    pdfUrls: [...paper.pdfUrls],
    ...(paper.citedBy === undefined ? {} : { citedBy: paper.citedBy }),
    ...(paper.oa === undefined ? {} : { oa: paper.oa }),
    ...(paper.type === undefined ? {} : { type: paper.type }),
    sources: [...paper.sources],
    sourceIds: { ...paper.sourceIds },
  }
}

/** Build `lit_search`. */
export function makeLitSearchTool(runtime: HarvestRuntime) {
  return defineTool({
    name: 'lit_search',
    description: [
      'Search OpenAlex, Crossref, arXiv and Europe PMC in one call (dsh-lit-harvest).',
      '',
      'Returns merged, deduplicated papers with every source that saw them and every PDF link the source offered. A source failure is reported per source in `errors[]`; it never turns into "no results". No LLM and no full-text download: this is the search step, not the reading step.',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: 'Bibliographic query (title words, authors, topic).' },
      sources: SOURCE_PARAM,
      max: { type: 'integer', description: 'Results per source (default 25, capped by config).' },
      yearFrom: { type: 'integer', description: 'Earliest publication year.' },
      yearTo: { type: 'integer', description: 'Latest publication year.' },
      oaOnly: { type: 'boolean', description: 'Keep only records with an OA flag or a PDF link.' },
      sort: { type: 'string', description: 'relevance (default) | citations | year.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          papers: { type: 'json' },
          perSource: { type: 'json' },
          errors: { type: 'json' },
          queries: { type: 'array', items: { type: 'string' } },
          error: ERROR_SCHEMA,
        },
      },
      render: (_args, value) => {
        const result = value as { ok: boolean; papers?: unknown[]; perSource?: Record<string, number>; errors?: unknown[]; error?: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `lit_search failed (${result.error?.code}): ${result.error?.message}` }]
        const papers = Array.isArray(result.papers) ? result.papers : []
        const perSource = result.perSource ?? {}
        const errors = Array.isArray(result.errors) ? result.errors : []
        const lines = [`lit_search: ${papers.length} paper(s); sources ${Object.entries(perSource).map(([name, count]) => `${name}=${count}`).join(' ') || '(none)'}`]
        for (const paper of papers.slice(0, 10)) {
          const record = paper as { title?: string; year?: number; doi?: string; sources?: string[] }
          lines.push(`  ${record.year ?? '?'} · ${record.title ?? '(no title)'}${record.doi === undefined ? '' : ` · doi:${record.doi}`} [${(record.sources ?? []).join(',')}]`)
        }
        for (const error of errors) {
          const record = error as { source?: string; code?: string; message?: string }
          lines.push(`  ! ${record.source}: ${record.code} — ${record.message}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(input: unknown) {
      const args = (input ?? {}) as {
        query?: string
        sources?: string[]
        max?: number
        yearFrom?: number
        yearTo?: number
        oaOnly?: boolean
        sort?: string
      }
      if (typeof args.query !== 'string' || args.query.trim() === '') return failure('INVALID_INPUT', 'query must be a non-empty string')
      try {
        const result = await runtime.search(args.query, {
          ...(args.sources === undefined ? {} : { sources: args.sources as never }),
          ...(args.max === undefined ? {} : { max: args.max }),
          ...(args.yearFrom === undefined ? {} : { yearFrom: args.yearFrom }),
          ...(args.yearTo === undefined ? {} : { yearTo: args.yearTo }),
          ...(args.oaOnly === undefined ? {} : { oaOnly: args.oaOnly }),
          ...(args.sort === undefined ? {} : { sort: args.sort as never }),
        })
        return {
          ok: true as const,
          papers: result.papers.map(paperJson),
          perSource: { ...result.perSource },
          errors: result.errors.map(error => ({ ...error })),
          queries: [...result.queries],
        }
      } catch (error) {
        return failure(codeOf(error), messageOf(error))
      }
    },
  })
}

/** Build `lit_resolve_oa`. */
export function makeLitResolveOaTool(runtime: HarvestRuntime) {
  return defineTool({
    name: 'lit_resolve_oa',
    description: [
      'Resolve open-access PDF links for known papers (dsh-lit-harvest).',
      '',
      'Pass `items` (objects with doi/title/pdfUrl) or `dois`. Known links are kept; DOIs are looked up in Unpaywall, which requires config.mailto. A failed lookup is reported per item with a code and never dropped.',
    ].join('\n'),
    parameters: {
      items: { type: 'json', description: 'Array of {doi?, title?, pdfUrl?}.' },
      dois: { type: 'array', items: { type: 'string' }, description: 'Convenience form: DOI strings.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          results: { type: 'json' },
          error: ERROR_SCHEMA,
        },
      },
      render: (_args, value) => {
        const result = value as { ok: boolean; results?: Array<{ doi?: string; pdfUrls?: string[]; error?: { code: string } }>; error?: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `lit_resolve_oa failed (${result.error?.code}): ${result.error?.message}` }]
        const results = result.results ?? []
        const withPdf = results.filter(item => (item.pdfUrls ?? []).length > 0).length
        const lines = [`lit_resolve_oa: ${results.length} item(s), ${withPdf} with a PDF link`]
        for (const item of results.slice(0, 10)) {
          lines.push(`  ${item.doi ?? '(no doi)'}: ${(item.pdfUrls ?? []).length} link(s)${item.error === undefined ? '' : ` — ${item.error.code}`}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(input: unknown) {
      const args = (input ?? {}) as { items?: unknown; dois?: unknown }
      const items: OaItem[] = []
      if (Array.isArray(args.dois)) {
        for (const doi of args.dois) if (typeof doi === 'string' && doi.trim() !== '') items.push({ doi: doi.trim() })
      }
      if (Array.isArray(args.items)) {
        for (const raw of args.items) {
          if (typeof raw !== 'object' || raw === null) continue
          const record = raw as Record<string, unknown>
          const doi = typeof record.doi === 'string' ? record.doi.trim() : undefined
          const title = typeof record.title === 'string' ? record.title : undefined
          const pdfUrl = typeof record.pdfUrl === 'string' ? record.pdfUrl : undefined
          if (doi === undefined && title === undefined && pdfUrl === undefined) continue
          items.push({
            ...(doi === undefined || doi === '' ? {} : { doi }),
            ...(title === undefined ? {} : { title }),
            ...(pdfUrl === undefined ? {} : { pdfUrl }),
          })
        }
      }
      if (items.length === 0) return failure('INVALID_INPUT', 'provide items[] or dois[]')
      if (items.length > 50) return failure('INVALID_INPUT', 'at most 50 items per call')
      try {
        return { ok: true as const, results: (await runtime.resolveOa(items)) as never }
      } catch (error) {
        return failure(codeOf(error), messageOf(error))
      }
    },
  })
}

/** Build `lit_sufficiency`. */
export function makeLitSufficiencyTool() {
  return defineTool({
    name: 'lit_sufficiency',
    description: [
      'Check whether a collected set is sufficient for a review (dsh-lit-harvest).',
      '',
      'Quota (core/total) plus subtopic coverage over titles, abstracts and keywords; CJK is scored with unigrams + bigrams. Returns explicit `gaps[]` and deterministic `nextQueries[]`. Lexical by design: no embeddings, no LLM.',
    ].join('\n'),
    parameters: {
      topic: { type: 'string', required: true, description: 'Review topic.' },
      subtopics: { type: 'array', items: { type: 'string' }, description: 'Subtopics that must each be covered.' },
      collected: { type: 'json', description: 'Array of {title, abstract?, year?, doi?, arxivId?, keywords?}.' },
      core: { type: 'array', items: { type: 'string' }, description: 'Core set (DOI/arXiv id/title); omitted = every collected record counts.' },
      minCore: { type: 'integer', description: 'Minimum core papers (default 5).' },
      minTotal: { type: 'integer', description: 'Minimum total papers (default 10).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'json' },
          error: ERROR_SCHEMA,
        },
      },
      render: (_args, value) => {
        const result = value as { ok: boolean; report?: { sufficient: boolean; coreCount: number; minCore: number; totalCount: number; minTotal: number; gaps: string[]; nextQueries: string[] }; error?: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `lit_sufficiency failed (${result.error?.code}): ${result.error?.message}` }]
        const report = result.report
        if (report === undefined) return [{ type: 'text', text: 'lit_sufficiency: no report' }]
        const lines = [
          `lit_sufficiency: ${report.sufficient ? 'sufficient' : 'insufficient'} (core ${report.coreCount}/${report.minCore}, total ${report.totalCount}/${report.minTotal})`,
        ]
        if (report.gaps.length > 0) lines.push(`gaps: ${report.gaps.join('; ')}`)
        if (report.nextQueries.length > 0) lines.push(`next: ${report.nextQueries.join(' | ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(input: unknown) {
      const args = (input ?? {}) as {
        topic?: string
        subtopics?: string[]
        collected?: unknown
        core?: string[]
        minCore?: number
        minTotal?: number
      }
      if (typeof args.topic !== 'string' || args.topic.trim() === '') return failure('INVALID_INPUT', 'topic must be a non-empty string')
      const collected: PaperLike[] = []
      if (Array.isArray(args.collected)) {
        for (const raw of args.collected) {
          if (typeof raw !== 'object' || raw === null) continue
          const record = raw as Record<string, unknown>
          if (typeof record.title !== 'string' || record.title.trim() === '') continue
          collected.push({
            title: record.title,
            ...(typeof record.abstract === 'string' ? { abstract: record.abstract } : {}),
            ...(typeof record.year === 'number' ? { year: record.year } : {}),
            ...(typeof record.doi === 'string' ? { doi: record.doi } : {}),
            ...(typeof record.arxivId === 'string' ? { arxivId: record.arxivId } : {}),
            ...(Array.isArray(record.keywords) ? { keywords: record.keywords.filter((word): word is string => typeof word === 'string') } : {}),
          })
        }
      }
      try {
        const report = checkSufficiency({
          topic: args.topic,
          ...(args.subtopics === undefined ? {} : { subtopics: args.subtopics }),
          collected,
          ...(args.core === undefined ? {} : { core: args.core }),
          ...(args.minCore === undefined ? {} : { minCore: args.minCore }),
          ...(args.minTotal === undefined ? {} : { minTotal: args.minTotal }),
        })
        return { ok: true as const, report: report as never }
      } catch (error) {
        return failure(codeOf(error), messageOf(error))
      }
    },
  })
}

/** Build `lit_harvest_run`. */
export function makeLitHarvestRunTool(runtime: HarvestRuntime) {
  return defineTool({
    name: 'lit_harvest_run',
    description: [
      'Run a bounded literature harvest: search → sufficiency → gap-driven next round (dsh-lit-harvest).',
      '',
      'Stops when the quota + subtopic coverage is sufficient or when maxRounds is reached. The whole run (queries, per-source counts and errors, merged papers, sufficiency) is sealed as one REP evidence item when ctx.researchEvidence is mounted, otherwise written under `<root>/runs/`. No LLM decides relevance or writes the query.',
    ].join('\n'),
    parameters: {
      topic: { type: 'string', required: true, description: 'Review topic / first query.' },
      subtopics: { type: 'array', items: { type: 'string' }, description: 'Subtopics used for coverage and gap queries.' },
      sources: SOURCE_PARAM,
      maxRounds: { type: 'integer', description: 'Hard round cap (default from config).' },
      perRound: { type: 'integer', description: 'Results requested per round.' },
      minCore: { type: 'integer', description: 'Core quota (default 5).' },
      minTotal: { type: 'integer', description: 'Total quota (default 10).' },
      yearFrom: { type: 'integer', description: 'Earliest publication year.' },
      yearTo: { type: 'integer', description: 'Latest publication year.' },
      oaOnly: { type: 'boolean', description: 'Keep only OA records.' },
      persist: { type: 'boolean', description: 'Persist the run (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          runId: { type: 'string' },
          topic: { type: 'string' },
          rounds: { type: 'json' },
          papers: { type: 'json' },
          sufficiency: { type: 'json' },
          persistence: { type: 'json' },
          warnings: { type: 'array', items: { type: 'string' } },
          error: ERROR_SCHEMA,
        },
      },
      render: (_args, value) => {
        const result = value as {
          ok: boolean
          runId?: string
          topic?: string
          rounds?: Array<{ round: number; query: string; found: number; newPapers: number; sufficient: boolean }>
          papers?: unknown[]
          persistence?: { mode: string; path?: string; evidenceId?: string; reason?: string }
          warnings?: string[]
          error?: { code: string; message: string }
        }
        if (!result.ok) return [{ type: 'text', text: `lit_harvest_run failed (${result.error?.code}): ${result.error?.message}` }]
        const lines = [`lit_harvest_run: ${result.topic ?? ''} (run ${result.runId ?? '?'})`]
        for (const round of result.rounds ?? []) {
          lines.push(`  round ${round.round}: "${round.query}" found ${round.found}, new ${round.newPapers}, sufficient=${round.sufficient}`)
        }
        lines.push(`papers: ${(result.papers ?? []).length}`)
        if (result.persistence !== undefined) {
          lines.push(result.persistence.mode === 'rep'
            ? `persisted: REP evidence ${result.persistence.evidenceId ?? '?'}`
            : result.persistence.mode === 'file'
              ? `persisted: file ${result.persistence.path ?? '?'}${result.persistence.reason === undefined ? '' : ` (${result.persistence.reason})`}`
              : 'persisted: none')
        }
        for (const warning of result.warnings ?? []) lines.push(`  warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(input: unknown) {
      const args = (input ?? {}) as {
        topic?: string
        subtopics?: string[]
        sources?: string[]
        maxRounds?: number
        perRound?: number
        minCore?: number
        minTotal?: number
        yearFrom?: number
        yearTo?: number
        oaOnly?: boolean
        persist?: boolean
      }
      if (typeof args.topic !== 'string' || args.topic.trim() === '') return failure('INVALID_INPUT', 'topic must be a non-empty string')
      try {
        const outcome = await runtime.harvest({
          topic: args.topic,
          ...(args.subtopics === undefined ? {} : { subtopics: args.subtopics }),
          ...(args.sources === undefined ? {} : { sources: args.sources as never }),
          ...(args.maxRounds === undefined ? {} : { maxRounds: args.maxRounds }),
          ...(args.perRound === undefined ? {} : { perRound: args.perRound }),
          ...(args.minCore === undefined ? {} : { minCore: args.minCore }),
          ...(args.minTotal === undefined ? {} : { minTotal: args.minTotal }),
          ...(args.yearFrom === undefined ? {} : { yearFrom: args.yearFrom }),
          ...(args.yearTo === undefined ? {} : { yearTo: args.yearTo }),
          ...(args.oaOnly === undefined ? {} : { oaOnly: args.oaOnly }),
          ...(args.persist === undefined ? {} : { persist: args.persist }),
        })
        return {
          ok: true as const,
          runId: outcome.record.runId,
          topic: outcome.record.topic,
          rounds: outcome.record.rounds.map(round => ({ ...round })) as never,
          papers: outcome.record.papers.map(paperJson) as never,
          sufficiency: { ...outcome.record.sufficiency } as never,
          persistence: { ...outcome.persistence } as never,
          warnings: [...outcome.warnings],
        }
      } catch (error) {
        return failure(codeOf(error), messageOf(error))
      }
    },
  })
}
