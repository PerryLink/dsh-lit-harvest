/**
 * Sufficiency: quota, subtopic coverage, CJK and explicit gaps.
 * @module test/sufficiency.spec
 */

import { describe, expect, it } from 'vitest'
import { checkSufficiency } from '../src/sufficiency.ts'

const collected = [
  { title: 'Damage evolution in a synthetic material', abstract: 'damage and strain' },
  { title: 'A damage model for composites', year: 2021 },
  { title: 'Fatigue of metals', abstract: 'cyclic loading' },
]

describe('checkSufficiency', () => {
  it('lists uncovered subtopics and derives next-round queries', () => {
    const report = checkSufficiency({
      topic: 'peridynamics',
      subtopics: ['damage', 'fracture'],
      collected,
      minCore: 3,
      minTotal: 3,
    })
    expect(report.sufficient).toBe(false)
    expect(report.gaps).toEqual(['fracture'])
    expect(report.nextQueries).toEqual(['fracture peridynamics'])
    expect(report.coverage.find(entry => entry.subtopic === 'damage')?.covered).toBe(true)
  })

  it('counts only the explicit core set when one is given', () => {
    const report = checkSufficiency({
      topic: 'peridynamics',
      collected,
      core: ['Damage evolution in a synthetic material'],
      minCore: 2,
      minTotal: 3,
    })
    expect(report.coreCount).toBe(1)
    expect(report.reason).toContain('core papers 1/2')
  })

  it('is sufficient when quota and coverage are met', () => {
    const report = checkSufficiency({
      topic: 'peridynamics',
      subtopics: ['damage'],
      collected,
      minCore: 2,
      minTotal: 3,
    })
    expect(report.sufficient).toBe(true)
    expect(report.gaps).toEqual([])
    expect(report.nextQueries).toEqual([])
  })

  it('scores CJK subtopics with unigrams and bigrams', () => {
    const report = checkSufficiency({
      topic: '近场动力学',
      subtopics: ['损伤'],
      collected: [{ title: '损伤演化与疲劳', abstract: '近场动力学模型' }],
      minCore: 1,
      minTotal: 1,
    })
    const coverage = report.coverage[0]!
    expect(coverage.covered).toBe(true)
    expect(coverage.score).toBe(1)
    expect(coverage.matchedTitles).toEqual(['损伤演化与疲劳'])
  })
})
