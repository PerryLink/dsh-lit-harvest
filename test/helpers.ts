/**
 * Test helpers: a scripted HTTP client and inline provider fixtures.
 * @module test/helpers
 */

import type { HttpClient, HttpResponse } from '../src/http.ts'

/** One scripted route. */
export interface Route {
  readonly match: string
  readonly body: string
  readonly status?: number
  readonly contentType?: string
}

/** A client plus its request log. */
export interface ScriptedClient {
  readonly client: HttpClient
  readonly calls: string[]
}

/**
 * Build a client that answers from a route table.
 * @param routes - routes in match order.
 * @param options - `fail` throws for every request.
 * @returns the client and its call log.
 */
export function scriptedClient(routes: readonly Route[], options: { fail?: Error } = {}): ScriptedClient {
  const calls: string[] = []
  const client: HttpClient = {
    async get(url: string): Promise<HttpResponse> {
      calls.push(url)
      if (options.fail !== undefined) throw options.fail
      const route = routes.find(candidate => url.includes(candidate.match))
      if (route === undefined) return { status: 404, body: '', url, contentType: 'text/plain' }
      return {
        status: route.status ?? 200,
        body: route.body,
        url,
        contentType: route.contentType ?? 'application/json',
      }
    },
  }
  return { client, calls }
}

/** OpenAlex works response (one paper). */
export const OPENALEX = JSON.stringify({
  results: [
    {
      id: 'https://openalex.org/W1',
      title: 'A study of things and damage',
      publication_year: 2020,
      doi: 'https://doi.org/10.1000/xyz',
      authorships: [{ author: { display_name: 'Jane Doe' } }],
      primary_location: {
        source: { display_name: 'Journal of Tests' },
        landing_page_url: 'https://example.org/a',
      },
      best_oa_location: { pdf_url: 'https://example.org/a.pdf' },
      open_access: { is_oa: true },
      cited_by_count: 12,
      type: 'article',
      abstract_inverted_index: { Damage: [0], study: [1] },
    },
  ],
})

/** Crossref works response (the same paper). */
export const CROSSREF = JSON.stringify({
  message: {
    items: [
      {
        DOI: '10.1000/xyz',
        title: ['A study of things and damage'],
        author: [{ given: 'Jane', family: 'Doe' }],
        issued: { 'date-parts': [[2020]] },
        'container-title': ['Journal of Tests'],
        URL: 'https://doi.org/10.1000/xyz',
        type: 'journal-article',
        'is-referenced-by-count': 15,
      },
    ],
  },
})

/** arXiv Atom response (one preprint). */
export const ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>A study of things and damage</title>
    <summary>Damage in a synthetic material.</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Jane Doe</name></author>
    <link title="pdf" href="https://arxiv.org/pdf/2401.00001v1"/>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1000/xyz</arxiv:doi>
  </entry>
</feed>`

/** Europe PMC response (one record). */
export const EUROPEPMC = JSON.stringify({
  resultList: {
    result: [
      {
        id: 'PMC1',
        doi: '10.1000/xyz',
        title: 'A study of things and damage',
        authorString: 'Doe J, Roe R',
        pubYear: '2020',
        journalTitle: 'Journal of Tests',
        abstractText: 'Damage in a synthetic material.',
        isOpenAccess: 'Y',
        pubType: 'research-article',
        fullTextUrlList: { fullTextUrl: [{ documentStyle: 'pdf', url: 'https://europepmc.org/a.pdf' }] },
      },
    ],
  },
})

/** Unpaywall response. */
export const UNPAYWALL = JSON.stringify({
  doi: '10.1000/xyz',
  is_oa: true,
  best_oa_location: { url_for_pdf: 'https://example.org/a.pdf', url: 'https://example.org/a' },
  oa_locations: [{ url_for_pdf: 'https://example.org/a.pdf' }, { url_for_pdf: 'https://repo.example.org/a.pdf' }],
})
