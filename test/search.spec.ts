/**
 * Merge/dedupe across sources, per-source counts and typed errors.
 * @module test/search.spec
 */

import { describe, expect, it } from 'vitest'
import { HarvestNetworkError } from '../src/http.ts'
import { searchAll } from '../src/search.ts'
import { ARXIV, CROSSREF, EUROPEPMC, OPENALEX, scriptedClient } from './helpers.ts'

const AT = new Date('2026-11-10T12:00:00.000Z')

const routes = [
  { match: 'api.openalex.org', body: OPENALEX },
  { match: 'api.crossref.org', body: CROSSREF },
  { match: 'export.arxiv.org', body: ARXIV },
  { match: 'www.ebi.ac.uk', body: EUROPEPMC },
]

describe('searchAll', () => {
  it('merges the same DOI across four sources and unions PDF links', async () => {
    const { client } = scriptedClient(routes)
    const result = await searchAll(client, { query: 'things', max: 10, now: () => AT })
    expect(result.papers).toHaveLength(1)
    const paper = result.papers[0]!
    expect(paper.sources).toHaveLength(4)
    expect(paper.pdfUrls).toHaveLength(3)
    expect(paper.citedBy).toBe(15)
    expect(paper.year).toBe(2020)
    expect(result.perSource).toEqual({ openalex: 1, crossref: 1, arxiv: 1, europepmc: 1 })
    expect(result.errors).toEqual([])
  })

  it('records a source failure instead of returning an empty answer', async () => {
    const { client } = scriptedClient([], { fail: new HarvestNetworkError('timeout', 'timed out') })
    const result = await searchAll(client, { query: 'things', max: 10, now: () => AT })
    expect(result.papers).toEqual([])
    expect(result.errors).toHaveLength(4)
    expect(result.errors.every(error => error.code === 'timeout')).toBe(true)
  })

  it('keeps only open-access records when oaOnly is set', async () => {
    const { client } = scriptedClient(routes)
    const result = await searchAll(client, { query: 'things', max: 10, oaOnly: true, now: () => AT })
    expect(result.papers).toHaveLength(1)
    expect(result.papers[0]?.oa).toBe(true)
  })
})
