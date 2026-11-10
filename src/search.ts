/**
 * Fan-out, merge and dedupe across the four metadata sources.
 *
 * A source failure is recorded per source and never turns into "no results".
 * Hits are merged by DOI, then arXiv id, then normalized title; the merged
 * record keeps every source that saw it and every PDF link any source offered.
 *
 * @module dsh-lit-harvest/search
 */

import { DEFAULT_SOURCES, type SourceName } from './config.ts'
import { HarvestNetworkError, type HttpClient } from './http.ts'
import {
  searchArxiv,
  searchCrossref,
  searchEuropepmc,
  searchOpenalex,
  type PaperHit,
  type SearchOptions,
} from './providers.ts'

/** One merged paper across sources. */
export interface MergedPaper {
  readonly title: string
  readonly authors: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly doi?: string
  readonly arxivId?: string
  readonly abstract?: string
  readonly url?: string
  readonly pdfUrls: readonly string[]
  readonly citedBy?: number
  readonly oa?: boolean
  readonly type?: string
  readonly sources: readonly SourceName[]
  readonly sourceIds: Readonly<Partial<Record<SourceName, string>>>
  readonly firstSeen: number
}

/** A search request. */
export interface SearchRequest extends SearchOptions {
  readonly query: string
  readonly sources?: readonly SourceName[]
  readonly sort?: 'relevance' | 'citations' | 'year'
}

/** A search result with per-source counts and typed errors. */
export interface SearchResult {
  readonly papers: readonly MergedPaper[]
  readonly perSource: Readonly<Partial<Record<SourceName, number>>>
  readonly errors: readonly { readonly source: SourceName; readonly code: string; readonly message: string }[]
  readonly queries: readonly string[]
}

function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function keyOf(hit: PaperHit): string {
  if (hit.doi !== undefined) return `doi:${hit.doi.toLowerCase()}`
  if (hit.arxivId !== undefined) return `arxiv:${hit.arxivId}`
  return `title:${normalizeTitle(hit.title)}`
}

function mergeInto(existing: MergedPaper, hit: PaperHit): MergedPaper {
  const pdfUrls = new Set([...existing.pdfUrls, ...(hit.pdfUrl === undefined ? [] : [hit.pdfUrl])])
  const year = existing.year ?? hit.year
  const venue = existing.venue ?? hit.venue
  const doi = existing.doi ?? hit.doi
  const arxivId = existing.arxivId ?? hit.arxivId
  const abstract = existing.abstract ?? hit.abstract
  const url = existing.url ?? hit.url
  const oa = existing.oa ?? hit.oa
  const type = existing.type ?? hit.type
  const citedBy = Math.max(existing.citedBy ?? 0, hit.citedBy ?? 0)
  const hasCitation = existing.citedBy !== undefined || hit.citedBy !== undefined
  return {
    title: existing.title.length >= hit.title.length ? existing.title : hit.title,
    authors: existing.authors.length > 0 ? existing.authors : hit.authors,
    ...(year === undefined ? {} : { year }),
    ...(venue === undefined ? {} : { venue }),
    ...(doi === undefined ? {} : { doi }),
    ...(arxivId === undefined ? {} : { arxivId }),
    ...(abstract === undefined ? {} : { abstract }),
    ...(url === undefined ? {} : { url }),
    pdfUrls: [...pdfUrls],
    ...(hasCitation ? { citedBy } : {}),
    ...(oa === undefined ? {} : { oa }),
    ...(type === undefined ? {} : { type }),
    sources: [...new Set([...existing.sources, hit.source])],
    sourceIds: { ...existing.sourceIds, [hit.source]: hit.sourceId },
    firstSeen: existing.firstSeen,
  }
}

function fromHit(hit: PaperHit, index: number): MergedPaper {
  return {
    title: hit.title,
    authors: hit.authors,
    ...(hit.year === undefined ? {} : { year: hit.year }),
    ...(hit.venue === undefined ? {} : { venue: hit.venue }),
    ...(hit.doi === undefined ? {} : { doi: hit.doi }),
    ...(hit.arxivId === undefined ? {} : { arxivId: hit.arxivId }),
    ...(hit.abstract === undefined ? {} : { abstract: hit.abstract }),
    ...(hit.url === undefined ? {} : { url: hit.url }),
    pdfUrls: hit.pdfUrl === undefined ? [] : [hit.pdfUrl],
    ...(hit.citedBy === undefined ? {} : { citedBy: hit.citedBy }),
    ...(hit.oa === undefined ? {} : { oa: hit.oa }),
    ...(hit.type === undefined ? {} : { type: hit.type }),
    sources: [hit.source],
    sourceIds: { [hit.source]: hit.sourceId },
    firstSeen: index,
  }
}

function searchOne(
  client: HttpClient,
  source: SourceName,
  query: string,
  options: SearchOptions,
): Promise<PaperHit[]> {
  switch (source) {
    case 'openalex':
      return searchOpenalex(client, query, options)
    case 'crossref':
      return searchCrossref(client, query, options)
    case 'arxiv':
      return searchArxiv(client, query, options)
    case 'europepmc':
      return searchEuropepmc(client, query, options)
  }
}

/**
 * Search every requested source, merge duplicates and sort.
 * @param client - the bounded HTTP client.
 * @param request - query, sources, limits and filters.
 * @returns merged papers, per-source counts and typed errors.
 */
export async function searchAll(client: HttpClient, request: SearchRequest): Promise<SearchResult> {
  const sources = request.sources === undefined || request.sources.length === 0 ? [...DEFAULT_SOURCES] : [...request.sources]
  const options: SearchOptions = {
    max: request.max,
    ...(request.yearFrom === undefined ? {} : { yearFrom: request.yearFrom }),
    ...(request.yearTo === undefined ? {} : { yearTo: request.yearTo }),
    ...(request.oaOnly === undefined ? {} : { oaOnly: request.oaOnly }),
    ...(request.mailto === undefined ? {} : { mailto: request.mailto }),
    now: request.now,
  }
  const settled = await Promise.allSettled(sources.map(source => searchOne(client, source, request.query, options)))
  const perSource: Partial<Record<SourceName, number>> = {}
  const errors: Array<{ source: SourceName; code: string; message: string }> = []
  const merged = new Map<string, MergedPaper>()
  let index = 0

  sources.forEach((source, position) => {
    const result = settled[position]
    if (result === undefined) return
    if (result.status === 'rejected') {
      const error = result.reason as unknown
      const code = error instanceof HarvestNetworkError ? error.code : 'source-error'
      errors.push({ source, code, message: error instanceof Error ? error.message : String(error) })
      return
    }
    perSource[source] = result.value.length
    for (const hit of result.value) {
      if (request.oaOnly === true && hit.oa !== true && hit.pdfUrl === undefined) continue
      const key = keyOf(hit)
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, fromHit(hit, index))
        index += 1
      } else {
        merged.set(key, mergeInto(existing, hit))
      }
    }
  })

  let papers = [...merged.values()]
  const sort = request.sort ?? 'relevance'
  if (sort === 'citations') {
    papers.sort((left, right) => (right.citedBy ?? 0) - (left.citedBy ?? 0) || left.firstSeen - right.firstSeen)
  } else if (sort === 'year') {
    papers.sort((left, right) => (right.year ?? 0) - (left.year ?? 0) || left.firstSeen - right.firstSeen)
  } else {
    papers.sort((left, right) => left.firstSeen - right.firstSeen)
  }
  papers = papers.slice(0, request.max)
  return { papers, perSource, errors, queries: [request.query] }
}
