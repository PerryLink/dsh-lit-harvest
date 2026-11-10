/**
 * Source adapters: OpenAlex, Crossref, arXiv, Europe PMC and Unpaywall.
 *
 * Each adapter returns normalized {@link PaperHit}s and never decides that a
 * source's failure means "no paper". The caller records per-source errors.
 * @module dsh-lit-harvest/providers
 */

import type { SourceName } from './config.ts'
import { jsonOf, type HttpClient } from './http.ts'

/** One normalized search hit. */
export interface PaperHit {
  readonly source: SourceName
  readonly sourceId: string
  readonly title: string
  readonly authors: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly doi?: string
  readonly arxivId?: string
  readonly abstract?: string
  readonly url?: string
  readonly pdfUrl?: string
  readonly citedBy?: number
  readonly oa?: boolean
  readonly type?: string
  readonly fetchedAt: string
  readonly query: string
}

/** Options shared by the source adapters. */
export interface SearchOptions {
  readonly max: number
  readonly yearFrom?: number
  readonly yearTo?: number
  readonly oaOnly?: boolean
  readonly mailto?: string
  readonly now: () => Date
}

/** One Unpaywall lookup. */
export interface OaLookup {
  readonly doi: string
  readonly pdfUrls: readonly string[]
  readonly landingUrl?: string
  readonly isOa: boolean
}

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/gu, ' ').trim()
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
}

function normalizeDoi(value: string | null | undefined): string | undefined {
  const text = clean(value).replace(/^https?:\/\/doi\.org\//iu, '')
  return text === '' ? undefined : text.toLowerCase()
}

function normalizeArxiv(value: string | null | undefined): string | undefined {
  const text = clean(value)
    .replace(/^https?:\/\/arxiv\.org\/abs\//iu, '')
    .replace(/v\d+$/u, '')
  return text === '' ? undefined : text
}

function yearOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** OpenAlex stores abstracts as an inverted index. */
function reconstructAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (index === null || index === undefined) return undefined
  const words: Array<[number, string]> = []
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words.push([position, word])
  }
  if (words.length === 0) return undefined
  words.sort((left, right) => left[0] - right[0])
  return clean(words.map(([, word]) => word).join(' '))
}

/** OpenAlex `/works` search. */
export async function searchOpenalex(
  client: HttpClient,
  query: string,
  options: SearchOptions,
): Promise<PaperHit[]> {
  const params = new URLSearchParams({
    search: query,
    'per-page': String(options.max),
  })
  if (options.mailto !== undefined) params.set('mailto', options.mailto)
  const filters: string[] = []
  if (options.oaOnly === true) filters.push('open_access.is_oa:true')
  if (options.yearFrom !== undefined || options.yearTo !== undefined) {
    filters.push(`from_publication_date:${options.yearFrom ?? 1800}-01-01`)
    filters.push(`to_publication_date:${options.yearTo ?? 2100}-12-31`)
  }
  if (filters.length > 0) params.set('filter', filters.join(','))
  const body = jsonOf(await client.get(`https://api.openalex.org/works?${params.toString()}`, { accept: 'application/json' }))
  if (typeof body !== 'object' || body === null) return []
  const results = (body as { results?: unknown[] }).results
  if (!Array.isArray(results)) return []
  const fetchedAt = options.now().toISOString()
  const hits: PaperHit[] = []
  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const title = clean(stringOf(raw.title) ?? stringOf(raw.display_name) ?? '')
    if (title === '') continue
    const authorships = Array.isArray(raw.authorships) ? raw.authorships : []
    const authors = authorships
      .map(authorship => {
        if (typeof authorship !== 'object' || authorship === null) return ''
        const author = (authorship as { author?: { display_name?: unknown } }).author
        return clean(typeof author?.display_name === 'string' ? author.display_name : '')
      })
      .filter(name => name !== '')
    const primary = typeof raw.primary_location === 'object' && raw.primary_location !== null
      ? raw.primary_location as Record<string, unknown>
      : undefined
    const source = typeof primary?.source === 'object' && primary.source !== null
      ? primary.source as Record<string, unknown>
      : undefined
    const bestOa = typeof raw.best_oa_location === 'object' && raw.best_oa_location !== null
      ? raw.best_oa_location as Record<string, unknown>
      : undefined
    const oa = typeof raw.open_access === 'object' && raw.open_access !== null
      ? (raw.open_access as { is_oa?: unknown }).is_oa === true
      : undefined
    const year = yearOf(raw.publication_year)
    const abstract = reconstructAbstract(raw.abstract_inverted_index as Record<string, number[]> | null | undefined)
    const doi = normalizeDoi(stringOf(raw.doi))
    hits.push({
      source: 'openalex',
      sourceId: clean(stringOf(raw.id) ?? title).replace(/^https?:\/\/openalex\.org\//u, ''),
      title,
      authors,
      ...(year === undefined ? {} : { year }),
      ...(stringOf(source?.display_name) === undefined ? {} : { venue: clean(stringOf(source?.display_name)) }),
      ...(doi === undefined ? {} : { doi }),
      ...(abstract === undefined ? {} : { abstract }),
      ...(stringOf(primary?.landing_page_url) === undefined ? {} : { url: clean(stringOf(primary?.landing_page_url)) }),
      ...(stringOf(bestOa?.pdf_url) === undefined ? {} : { pdfUrl: clean(stringOf(bestOa?.pdf_url)) }),
      ...(typeof raw.cited_by_count === 'number' ? { citedBy: raw.cited_by_count } : {}),
      ...(oa === undefined ? {} : { oa }),
      ...(stringOf(raw.type) === undefined ? {} : { type: clean(stringOf(raw.type)) }),
      fetchedAt,
      query,
    })
  }
  return hits
}

/** Crossref `/works` bibliographic search. */
export async function searchCrossref(
  client: HttpClient,
  query: string,
  options: SearchOptions,
): Promise<PaperHit[]> {
  const params = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(options.max),
    select: 'DOI,title,author,issued,container-title,volume,issue,page,type,URL,is-referenced-by-count',
  })
  if (options.mailto !== undefined) params.set('mailto', options.mailto)
  const filters: string[] = []
  if (options.yearFrom !== undefined) filters.push(`from-pub-date:${options.yearFrom}-01-01`)
  if (options.yearTo !== undefined) filters.push(`until-pub-date:${options.yearTo}-12-31`)
  if (filters.length > 0) params.set('filter', filters.join(','))
  const body = jsonOf(await client.get(`https://api.crossref.org/works?${params.toString()}`, { accept: 'application/json' }))
  if (typeof body !== 'object' || body === null) return []
  const message = (body as { message?: { items?: unknown[] } }).message
  const items = message?.items
  if (!Array.isArray(items)) return []
  const fetchedAt = options.now().toISOString()
  const hits: PaperHit[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const titles = Array.isArray(raw.title) ? raw.title : []
    const title = clean(titles.map(value => (typeof value === 'string' ? value : '')).join(' '))
    if (title === '') continue
    const authorList = Array.isArray(raw.author) ? raw.author : []
    const authors = authorList
      .map(author => {
        if (typeof author !== 'object' || author === null) return ''
        const record = author as Record<string, unknown>
        const family = clean(stringOf(record.family) ?? '')
        const given = clean(stringOf(record.given) ?? '')
        return clean(`${given} ${family}`)
      })
      .filter(name => name !== '')
    const issued = typeof raw.issued === 'object' && raw.issued !== null ? raw.issued as { 'date-parts'?: unknown } : undefined
    const parts = Array.isArray(issued?.['date-parts']) ? issued['date-parts'] : []
    const first = Array.isArray(parts[0]) ? parts[0] : []
    const year = yearOf(first[0])
    const containers = Array.isArray(raw['container-title']) ? raw['container-title'] : []
    const venue = clean(containers.map(value => (typeof value === 'string' ? value : '')).join(' '))
    const doi = normalizeDoi(stringOf(raw.DOI))
    hits.push({
      source: 'crossref',
      sourceId: doi ?? title,
      title,
      authors,
      ...(year === undefined ? {} : { year }),
      ...(venue === '' ? {} : { venue }),
      ...(doi === undefined ? {} : { doi }),
      ...(stringOf(raw.URL) === undefined ? {} : { url: clean(stringOf(raw.URL)) }),
      ...(typeof raw['is-referenced-by-count'] === 'number' ? { citedBy: raw['is-referenced-by-count'] } : {}),
      ...(stringOf(raw.type) === undefined ? {} : { type: clean(stringOf(raw.type)) }),
      fetchedAt,
      query,
    })
  }
  return hits
}

/** arXiv Atom search. */
export async function searchArxiv(
  client: HttpClient,
  query: string,
  options: SearchOptions,
): Promise<PaperHit[]> {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(options.max),
    sortBy: 'relevance',
  })
  const response = await client.get(`https://export.arxiv.org/api/query?${params.toString()}`, { accept: 'application/atom+xml' })
  const fetchedAt = options.now().toISOString()
  const hits: PaperHit[] = []
  for (const match of response.body.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)) {
    const entry = match[1] ?? ''
    const title = clean(decodeEntities(/<title>([\s\S]*?)<\/title>/u.exec(entry)?.[1] ?? ''))
    if (title === '') continue
    const id = clean(decodeEntities(/<id>([\s\S]*?)<\/id>/u.exec(entry)?.[1] ?? ''))
    const summary = clean(decodeEntities(/<summary>([\s\S]*?)<\/summary>/u.exec(entry)?.[1] ?? ''))
    const published = clean(/<published>([\s\S]*?)<\/published>/u.exec(entry)?.[1] ?? '')
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/gu)]
      .map(name => clean(decodeEntities(name[1] ?? '')))
      .filter(name => name !== '')
    const pdfUrl = /<link[^>]*title="pdf"[^>]*href="([^"]+)"/u.exec(entry)?.[1]
    const doi = normalizeDoi(decodeEntities(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/u.exec(entry)?.[1] ?? ''))
    const arxivId = normalizeArxiv(id)
    const year = yearOf(published.slice(0, 4))
    hits.push({
      source: 'arxiv',
      sourceId: arxivId ?? title,
      title,
      authors,
      ...(year === undefined ? {} : { year }),
      venue: 'arXiv',
      ...(doi === undefined ? {} : { doi }),
      ...(arxivId === undefined ? {} : { arxivId }),
      ...(summary === '' ? {} : { abstract: summary }),
      ...(id === '' ? {} : { url: id }),
      ...(pdfUrl === undefined ? {} : { pdfUrl: clean(decodeEntities(pdfUrl)) }),
      oa: true,
      type: 'preprint',
      fetchedAt,
      query,
    })
  }
  return hits
}

/** Europe PMC REST search. */
export async function searchEuropepmc(
  client: HttpClient,
  query: string,
  options: SearchOptions,
): Promise<PaperHit[]> {
  const params = new URLSearchParams({
    query,
    format: 'json',
    pageSize: String(options.max),
    resultType: 'core',
  })
  const body = jsonOf(await client.get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params.toString()}`, { accept: 'application/json' }))
  if (typeof body !== 'object' || body === null) return []
  const list = (body as { resultList?: { result?: unknown[] } }).resultList?.result
  if (!Array.isArray(list)) return []
  const fetchedAt = options.now().toISOString()
  const hits: PaperHit[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    const title = clean(stringOf(raw.title) ?? '')
    if (title === '') continue
    const authorString = clean(stringOf(raw.authorString) ?? '')
    const authors = authorString.split(',').map(name => clean(name)).filter(name => name !== '')
    const doi = normalizeDoi(stringOf(raw.doi))
    const fullText = typeof raw.fullTextUrlList === 'object' && raw.fullTextUrlList !== null
      ? (raw.fullTextUrlList as { fullTextUrl?: unknown[] }).fullTextUrl
      : undefined
    const urls = Array.isArray(fullText) ? fullText : []
    const pdfUrl = urls
      .map(entry => (typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : undefined))
      .find(entry => entry?.documentStyle === 'pdf')?.url
    const year = yearOf(raw.pubYear)
    hits.push({
      source: 'europepmc',
      sourceId: clean(stringOf(raw.id) ?? doi ?? title),
      title,
      authors,
      ...(year === undefined ? {} : { year }),
      ...(stringOf(raw.journalTitle) === undefined ? {} : { venue: clean(stringOf(raw.journalTitle)) }),
      ...(doi === undefined ? {} : { doi }),
      ...(stringOf(raw.abstractText) === undefined ? {} : { abstract: clean(stringOf(raw.abstractText)) }),
      ...(pdfUrl === undefined ? {} : { pdfUrl: clean(String(pdfUrl)) }),
      ...(stringOf(raw.isOpenAccess) === 'Y' ? { oa: true } : {}),
      ...(stringOf(raw.pubType) === undefined ? {} : { type: clean(stringOf(raw.pubType)) }),
      fetchedAt,
      query,
    })
  }
  return hits
}

/**
 * Look up one DOI in Unpaywall.
 * @param client - the HTTP client.
 * @param doi - the DOI.
 * @param mailto - required contact e-mail.
 * @returns the OA locations.
 */
export async function unpaywallLookup(client: HttpClient, doi: string, mailto: string): Promise<OaLookup> {
  const params = new URLSearchParams({ email: mailto })
  const body = jsonOf(await client.get(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?${params.toString()}`, { accept: 'application/json' }))
  if (typeof body !== 'object' || body === null) return { doi, pdfUrls: [], isOa: false }
  const raw = body as Record<string, unknown>
  const pdfUrls = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith('http')) pdfUrls.add(value)
  }
  const best = typeof raw.best_oa_location === 'object' && raw.best_oa_location !== null
    ? raw.best_oa_location as Record<string, unknown>
    : undefined
  add(best?.url_for_pdf)
  const locations = Array.isArray(raw.oa_locations) ? raw.oa_locations : []
  for (const location of locations) {
    if (typeof location === 'object' && location !== null) add((location as Record<string, unknown>).url_for_pdf)
  }
  return {
    doi,
    pdfUrls: [...pdfUrls],
    ...(stringOf(best?.url) === undefined ? {} : { landingUrl: clean(stringOf(best?.url)) }),
    isOa: raw.is_oa === true,
  }
}
