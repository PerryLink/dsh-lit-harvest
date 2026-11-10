/**
 * Deterministic sufficiency: quota plus subtopic coverage, with explicit gaps.
 *
 * The judgment is lexical on purpose: CJK unigrams + bigrams and Latin word
 * tokens, no embeddings and no LLM. Every number in the report can be
 * recomputed from the collected records; `gaps` drive the next round's queries.
 *
 * @module dsh-lit-harvest/sufficiency
 */

/** The minimal record the checker reads. */
export interface PaperLike {
  readonly title: string
  readonly abstract?: string
  readonly year?: number
  readonly doi?: string
  readonly arxivId?: string
  readonly type?: string
  readonly keywords?: readonly string[]
}

/** One subtopic's coverage. */
export interface SubtopicCoverage {
  readonly subtopic: string
  readonly covered: boolean
  readonly score: number
  readonly matchedTitles: readonly string[]
}

/** The sufficiency report. */
export interface SufficiencyReport {
  readonly sufficient: boolean
  readonly coreCount: number
  readonly totalCount: number
  readonly minCore: number
  readonly minTotal: number
  readonly coverage: readonly SubtopicCoverage[]
  readonly gaps: readonly string[]
  readonly nextQueries: readonly string[]
  readonly reason: string
  readonly scoring: 'keyword+cjk-bigram'
}

/** Input to the checker. */
export interface SufficiencyInput {
  readonly topic: string
  readonly subtopics?: readonly string[]
  readonly collected: readonly PaperLike[]
  /** Explicit core set (DOI / arXiv id / title); omitted = every collected record counts. */
  readonly core?: readonly string[]
  readonly minCore?: number
  readonly minTotal?: number
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'for', 'to', 'with', 'by',
  'from', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that',
  'these', 'those', 'using', 'use', 'based', 'via', 'towards', 'toward',
  'between', 'among', 'over', 'under', 'their', 'its', 'it', 'our', 'we',
  'study', 'studies', 'paper', 'papers', 'research', 'results', 'result',
  'method', 'methods', 'approach', 'analysis', 'data', 'model', 'models',
  'new', 'novel', 'proposed', 'show', 'shows', 'demonstrate', 'introduce',
  '的', '了', '和', '与', '在', '是', '为', '对', '中', '上', '下', '之', '及', '或', '等',
])

function termsOf(text: string): Set<string> {
  const terms = new Set<string>()
  const normalized = text.normalize('NFKC').toLowerCase()
  for (const match of normalized.matchAll(/[a-z0-9]+|[\u3400-\u9fff\uf900-\ufaff]+/gu)) {
    const run = match[0]
    if (/^[\u3400-\u9fff\uf900-\ufaff]+$/u.test(run)) {
      for (const char of run) if (!STOPWORDS.has(char)) terms.add(char)
      for (let index = 0; index < run.length - 1; index += 1) {
        const bigram = run.slice(index, index + 2)
        if (!STOPWORDS.has(bigram)) terms.add(bigram)
      }
      continue
    }
    if (run.length < 2) continue
    if (STOPWORDS.has(run)) continue
    terms.add(run)
  }
  return terms
}

function haystackOf(paper: PaperLike): Set<string> {
  return termsOf(`${paper.title} ${paper.abstract ?? ''} ${(paper.keywords ?? []).join(' ')}`)
}

function coverageOf(subtopic: string, collected: readonly PaperLike[]): SubtopicCoverage {
  const wanted = termsOf(subtopic)
  const matchedTitles: string[] = []
  let best = 0
  if (wanted.size > 0) {
    for (const paper of collected) {
      const haystack = haystackOf(paper)
      let hits = 0
      for (const term of wanted) if (haystack.has(term)) hits += 1
      const score = hits / wanted.size
      if (score > best) best = score
      if (score >= 0.6) matchedTitles.push(paper.title)
    }
  }
  return {
    subtopic,
    covered: matchedTitles.length > 0,
    score: Number(best.toFixed(3)),
    matchedTitles: matchedTitles.slice(0, 5),
  }
}

function coreCountOf(collected: readonly PaperLike[], core: readonly string[] | undefined): number {
  if (core === undefined || core.length === 0) return collected.length
  const wanted = new Set(core.map(value => value.normalize('NFKC').toLowerCase().trim()))
  let count = 0
  for (const paper of collected) {
    const keys = [
      paper.doi?.toLowerCase(),
      paper.arxivId?.toLowerCase(),
      paper.title.normalize('NFKC').toLowerCase().trim(),
    ].filter((value): value is string => value !== undefined)
    if (keys.some(key => wanted.has(key))) count += 1
  }
  return count
}

/**
 * Check quota and subtopic coverage.
 * @param input - topic, subtopics, collected records and quotas.
 * @returns the report with gaps and next-round queries.
 */
export function checkSufficiency(input: SufficiencyInput): SufficiencyReport {
  const minCore = input.minCore ?? 5
  const minTotal = input.minTotal ?? 10
  const subtopics = input.subtopics === undefined || input.subtopics.length === 0 ? [input.topic] : [...input.subtopics]
  const coverage = subtopics.map(subtopic => coverageOf(subtopic, input.collected))
  const gaps = coverage.filter(entry => !entry.covered).map(entry => entry.subtopic)
  const coreCount = coreCountOf(input.collected, input.core)
  const totalCount = input.collected.length
  const reasons: string[] = []
  if (coreCount < minCore) reasons.push(`core papers ${coreCount}/${minCore}`)
  if (totalCount < minTotal) reasons.push(`total papers ${totalCount}/${minTotal}`)
  if (gaps.length > 0) reasons.push(`uncovered subtopics: ${gaps.join('; ')}`)
  const sufficient = reasons.length === 0
  return {
    sufficient,
    coreCount,
    totalCount,
    minCore,
    minTotal,
    coverage,
    gaps,
    nextQueries: gaps.map(gap => `${gap} ${input.topic}`.trim()),
    reason: sufficient ? 'Quota and subtopic coverage satisfied.' : `Insufficient — ${reasons.join('; ')}.`,
    scoring: 'keyword+cjk-bigram',
  }
}
