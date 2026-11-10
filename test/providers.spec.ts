/**
 * Source adapters: parse one fixture per provider.
 * @module test/providers.spec
 */

import { describe, expect, it } from 'vitest'
import {
  searchArxiv,
  searchCrossref,
  searchEuropepmc,
  searchOpenalex,
  unpaywallLookup,
} from '../src/providers.ts'
import { ARXIV, CROSSREF, EUROPEPMC, OPENALEX, UNPAYWALL, scriptedClient } from './helpers.ts'

const AT = new Date('2026-11-10T12:00:00.000Z')
const options = { max: 5, now: () => AT }

function client() {
  return scriptedClient([
    { match: 'api.openalex.org', body: OPENALEX },
    { match: 'api.crossref.org', body: CROSSREF },
    { match: 'export.arxiv.org', body: ARXIV },
    { match: 'www.ebi.ac.uk', body: EUROPEPMC },
    { match: 'api.unpaywall.org', body: UNPAYWALL },
  ]).client
}

describe('providers', () => {
  it('parses OpenAlex and reconstructs the abstract', async () => {
    const [hit] = await searchOpenalex(client(), 'things', options)
    expect(hit?.source).toBe('openalex')
    expect(hit?.doi).toBe('10.1000/xyz')
    expect(hit?.authors).toEqual(['Jane Doe'])
    expect(hit?.pdfUrl).toBe('https://example.org/a.pdf')
    expect(hit?.abstract).toBe('Damage study')
    expect(hit?.fetchedAt).toBe(AT.toISOString())
  })

  it('parses Crossref', async () => {
    const [hit] = await searchCrossref(client(), 'things', options)
    expect(hit?.source).toBe('crossref')
    expect(hit?.venue).toBe('Journal of Tests')
    expect(hit?.citedBy).toBe(15)
    expect(hit?.year).toBe(2020)
  })

  it('parses arXiv Atom', async () => {
    const [hit] = await searchArxiv(client(), 'things', options)
    expect(hit?.source).toBe('arxiv')
    expect(hit?.arxivId).toBe('2401.00001')
    expect(hit?.doi).toBe('10.1000/xyz')
    expect(hit?.pdfUrl).toBe('https://arxiv.org/pdf/2401.00001v1')
    expect(hit?.oa).toBe(true)
  })

  it('parses Europe PMC and finds the PDF link', async () => {
    const [hit] = await searchEuropepmc(client(), 'things', options)
    expect(hit?.source).toBe('europepmc')
    expect(hit?.authors).toEqual(['Doe J', 'Roe R'])
    expect(hit?.pdfUrl).toBe('https://europepmc.org/a.pdf')
    expect(hit?.oa).toBe(true)
  })

  it('resolves Unpaywall locations without duplicates', async () => {
    const lookup = await unpaywallLookup(client(), '10.1000/xyz', 'you@example.org')
    expect(lookup.isOa).toBe(true)
    expect(lookup.pdfUrls).toHaveLength(2)
    expect(lookup.landingUrl).toBe('https://example.org/a')
  })
})
