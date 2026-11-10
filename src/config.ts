/**
 * Config schema and resolution for `dsh-lit-harvest`.
 *
 * Network behaviour is bounded: four metadata hosts plus Unpaywall, explicit
 * timeouts, a per-host interval and a retry budget. `mailto` is strongly
 * recommended: OpenAlex/Crossref use it for their polite pool and Unpaywall
 * requires it for DOI lookups.
 * @module dsh-lit-harvest/config
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** The four default metadata sources. */
export const DEFAULT_SOURCES = ['openalex', 'crossref', 'arxiv', 'europepmc'] as const

/** One supported search source. */
export type SourceName = (typeof DEFAULT_SOURCES)[number]

/** Raw plugin config — every field optional. */
export interface Config {
  /** Master switch. `false` mounts nothing. */
  enabled?: boolean
  /** Run-record and cache root, resolved against the harness working directory. */
  root?: string
  /** Contact e-mail for the polite pool and Unpaywall (required for DOI OA lookup). */
  mailto?: string
  /** `User-Agent` sent to metadata APIs. */
  userAgent?: string
  /** Per-request deadline in milliseconds. */
  timeoutMs?: number
  /** Minimum delay between two requests to the same host. */
  minIntervalMs?: number
  /** Bounded retries for 429/503 responses (0 = no retry). */
  retries?: number
  /** Hard cap on results per source per search. */
  maxResults?: number
  /** Hard cap on harvest rounds. */
  maxRounds?: number
  /** Results requested per round. */
  perRound?: number
  /** Default core quota for sufficiency checks. */
  minCore?: number
  /** Default total quota for sufficiency checks. */
  minTotal?: number
}

/** Fully resolved config. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
  readonly mailto?: string
  readonly userAgent: string
  readonly timeoutMs: number
  readonly minIntervalMs: number
  readonly retries: number
  readonly maxResults: number
  readonly maxRounds: number
  readonly perRound: number
  readonly minCore: number
  readonly minTotal: number
}

/** Schemastery schema: the loader validates and fills defaults before `apply`. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default('.lit-harvest'),
  mailto: z.string(),
  userAgent: z.string().default('dsh-lit-harvest/0.1.0 (https://github.com/PerryLink/dsh-lit-harvest)'),
  timeoutMs: z.number().default(15_000),
  minIntervalMs: z.number().default(150),
  retries: z.number().default(1),
  maxResults: z.number().default(25),
  maxRounds: z.number().default(3),
  perRound: z.number().default(10),
  minCore: z.number().default(5),
  minTotal: z.number().default(10),
})

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer, got ${String(value)}`)
}

/**
 * Validate raw values and fill explicit defaults.
 * @param config - raw (possibly partial) plugin config.
 * @returns the fully resolved config.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const root = config.root ?? '.lit-harvest'
  if (typeof root !== 'string' || root.trim() === '') throw new TypeError('root must be a non-empty path')
  const timeoutMs = config.timeoutMs ?? 15_000
  const minIntervalMs = config.minIntervalMs ?? 150
  const retries = config.retries ?? 1
  const maxResults = config.maxResults ?? 25
  const maxRounds = config.maxRounds ?? 3
  const perRound = config.perRound ?? 10
  const minCore = config.minCore ?? 5
  const minTotal = config.minTotal ?? 10
  assertPositiveInt('timeoutMs', timeoutMs)
  assertPositiveInt('maxResults', maxResults)
  assertPositiveInt('maxRounds', maxRounds)
  assertPositiveInt('perRound', perRound)
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) throw new TypeError('minIntervalMs must be a non-negative integer')
  if (!Number.isInteger(retries) || retries < 0) throw new TypeError('retries must be a non-negative integer')
  if (!Number.isInteger(minCore) || minCore < 0) throw new TypeError('minCore must be a non-negative integer')
  if (!Number.isInteger(minTotal) || minTotal < 0) throw new TypeError('minTotal must be a non-negative integer')
  const mailto = config.mailto?.trim()
  return {
    enabled: config.enabled ?? true,
    root: path.resolve(root),
    ...(mailto === undefined || mailto === '' ? {} : { mailto }),
    userAgent: config.userAgent ?? 'dsh-lit-harvest/0.1.0 (https://github.com/PerryLink/dsh-lit-harvest)',
    timeoutMs,
    minIntervalMs,
    retries,
    maxResults,
    maxRounds,
    perRound,
    minCore,
    minTotal,
  }
}
