/**
 * Runtime: bounded harvest loop, deterministic run id, file/REP persistence,
 * and Unpaywall resolution with and without `mailto`.
 * @module test/runtime.spec
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { HarvestRuntime, type EvidencePort } from '../src/runtime.ts'
import { ARXIV, CROSSREF, EUROPEPMC, OPENALEX, UNPAYWALL, scriptedClient } from './helpers.ts'

const AT = new Date('2026-11-10T12:00:00.000Z')
const routes = [
  { match: 'api.openalex.org', body: OPENALEX },
  { match: 'api.crossref.org', body: CROSSREF },
  { match: 'export.arxiv.org', body: ARXIV },
  { match: 'www.ebi.ac.uk', body: EUROPEPMC },
  { match: 'api.unpaywall.org', body: UNPAYWALL },
]

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lit-harvest-'))
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

function runtime(options: { mailto?: string; service?: EvidencePort } = {}): HarvestRuntime {
  return new HarvestRuntime({
    config: resolveConfig({ root, ...(options.mailto === undefined ? {} : { mailto: options.mailto }) }),
    client: scriptedClient(routes).client,
    now: () => AT,
    ...(options.service === undefined ? {} : { service: options.service }),
  })
}

describe('harvest', () => {
  it('stops after one sufficient round and persists nothing when asked', async () => {
    const outcome = await runtime({ mailto: 'you@example.org' }).harvest({
      topic: 'things',
      subtopics: ['damage'],
      minCore: 1,
      minTotal: 1,
      perRound: 5,
      maxRounds: 3,
      persist: false,
    })
    expect(outcome.record.papers).toHaveLength(1)
    expect(outcome.record.rounds).toHaveLength(1)
    expect(outcome.record.sufficiency.sufficient).toBe(true)
    expect(outcome.persistence.mode).toBe('none')
  })

  it('writes a run file when the REP service is absent', async () => {
    const outcome = await runtime({ mailto: 'you@example.org' }).harvest({
      topic: 'things',
      minCore: 1,
      minTotal: 1,
      perRound: 5,
      maxRounds: 1,
    })
    expect(outcome.persistence.mode).toBe('file')
    if (outcome.persistence.mode !== 'file') throw new Error('expected file mode')
    const written = JSON.parse(await readFile(outcome.persistence.path, 'utf8')) as { runId: string; papers: unknown[] }
    expect(written.runId).toBe(outcome.record.runId)
    expect(written.papers).toHaveLength(1)
  })

  it('registers one REP evidence item when the service is mounted', async () => {
    const captured: Array<{ bytes: unknown }> = []
    const added: Array<{ snapshotIds: readonly string[] }> = []
    const service: EvidencePort = {
      async capture(input) {
        captured.push({ bytes: input.bytes })
        return { snapshot: { snapshotId: 'snap-1' } as never }
      },
      async addEvidence(input) {
        added.push({ snapshotIds: input.snapshotIds })
        return { evidence: { evidenceId: 'ev-1' } as never }
      },
    }
    const outcome = await runtime({ mailto: 'you@example.org', service }).harvest({
      topic: 'things',
      minCore: 1,
      minTotal: 1,
      perRound: 5,
      maxRounds: 1,
    })
    expect(outcome.persistence.mode).toBe('rep')
    if (outcome.persistence.mode !== 'rep') throw new Error('expected rep mode')
    expect(outcome.persistence.evidenceId).toBe('ev-1')
    expect(captured).toHaveLength(1)
    expect(added[0]?.snapshotIds).toEqual(['snap-1'])
  })

  it('derives the same run id for the same search', async () => {
    const first = await runtime({ mailto: 'you@example.org' }).harvest({ topic: 'things', minCore: 1, minTotal: 1, maxRounds: 1, persist: false })
    const second = await runtime({ mailto: 'you@example.org' }).harvest({ topic: 'things', minCore: 1, minTotal: 1, maxRounds: 1, persist: false })
    expect(first.record.runId).toBe(second.record.runId)
  })
})

describe('resolveOa', () => {
  it('resolves DOI links through Unpaywall', async () => {
    const results = await runtime({ mailto: 'you@example.org' }).resolveOa([{ doi: '10.1000/xyz' }])
    expect(results[0]?.pdfUrls).toHaveLength(2)
    expect(results[0]?.isOa).toBe(true)
    expect(results[0]?.error).toBeUndefined()
  })

  it('reports MAILTO_REQUIRED instead of silently returning no links', async () => {
    const results = await runtime().resolveOa([{ doi: '10.1000/xyz', pdfUrl: 'https://example.org/known.pdf' }])
    expect(results[0]?.pdfUrls).toEqual(['https://example.org/known.pdf'])
    expect(results[0]?.error?.code).toBe('MAILTO_REQUIRED')
  })
})
