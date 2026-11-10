/**
 * `dsh-lit-harvest` — deterministic literature harvesting for DSH.
 *
 * Four tools: multi-source search, OA resolution, sufficiency checking and a
 * bounded harvest loop. The run record lands in REP (or `<root>/runs/` when the
 * REP service is not mounted). Function plugin — no default export.
 *
 * @module dsh-lit-harvest
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { HarvestRuntime, type EvidencePort } from './runtime.ts'
import {
  makeLitHarvestRunTool,
  makeLitResolveOaTool,
  makeLitSearchTool,
  makeLitSufficiencyTool,
} from './tools.ts'
import { VERSION } from './version.ts'

/** Cordis plugin name. */
export const name = 'lit-harvest'

/** The tool registry is required; the REP service is optional. */
export const inject = ['tools']

export { Config, resolveConfig, VERSION }
export type { ConfigShape }
export type { ResolvedConfig, SourceName } from './config.ts'
export { createHttpClient, assertAllowed, ALLOWED_HOSTS, HarvestNetworkError, jsonOf } from './http.ts'
export type { HttpClient, HttpResponse, HarvestNetworkErrorCode } from './http.ts'
export { searchAll } from './search.ts'
export type { MergedPaper, SearchRequest, SearchResult } from './search.ts'
export { checkSufficiency } from './sufficiency.ts'
export type { PaperLike, SubtopicCoverage, SufficiencyInput, SufficiencyReport } from './sufficiency.ts'
export { HarvestRuntime } from './runtime.ts'
export type {
  EvidencePort,
  HarvestOutcome,
  HarvestRequest,
  HarvestRound,
  HarvestRunRecord,
  OaItem,
  OaResult,
  Persistence,
} from './runtime.ts'
export {
  makeLitHarvestRunTool,
  makeLitResolveOaTool,
  makeLitSearchTool,
  makeLitSufficiencyTool,
} from './tools.ts'

/**
 * Mount the four tools.
 * @param ctx - the plugin context (host).
 * @param config - raw plugin config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('lit-harvest')
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — no tools are mounted')
    return
  }
  const service = ctx.get('researchEvidence') as EvidencePort | undefined
  const runtime = new HarvestRuntime({ config: resolved, ...(service === undefined ? {} : { service }) })
  if (service === undefined) {
    logger.info(`ctx.researchEvidence is not mounted; harvest runs fall back to files under ${resolved.root}`)
  }
  ctx.effect(() => ctx.tools.register(makeLitSearchTool(runtime)), 'lit-harvest: lit_search tool')
  ctx.effect(() => ctx.tools.register(makeLitResolveOaTool(runtime)), 'lit-harvest: lit_resolve_oa tool')
  ctx.effect(() => ctx.tools.register(makeLitSufficiencyTool()), 'lit-harvest: lit_sufficiency tool')
  ctx.effect(() => ctx.tools.register(makeLitHarvestRunTool(runtime)), 'lit-harvest: lit_harvest_run tool')
}
