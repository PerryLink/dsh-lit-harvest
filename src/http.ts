/**
 * Bounded HTTP client for the four metadata APIs and Unpaywall.
 *
 * Every URL is checked against an allowlist, redirects are refused (so a
 * provider cannot bounce the request to another host), and requests are
 * serialized per host with an explicit interval. A failure is a typed error so
 * the caller can report "source unavailable" instead of inventing an answer.
 *
 * @module dsh-lit-harvest/http
 */

/** Hosts this plugin may contact. */
export const ALLOWED_HOSTS = [
  'api.openalex.org',
  'api.crossref.org',
  'export.arxiv.org',
  'www.ebi.ac.uk',
  'api.unpaywall.org',
] as const

/** Stable network failure codes. */
export type HarvestNetworkErrorCode = 'blocked' | 'timeout' | 'http' | 'redirect' | 'invalid-json'

/** A typed network failure. */
export class HarvestNetworkError extends Error {
  /** Stable code. */
  readonly code: HarvestNetworkErrorCode
  /** HTTP status when the failure came from a response. */
  readonly status?: number

  constructor(code: HarvestNetworkErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'HarvestNetworkError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/** One response body. */
export interface HttpResponse {
  readonly status: number
  readonly body: string
  readonly url: string
  readonly contentType: string
}

/** Minimal client seam (tests inject a scripted implementation). */
export interface HttpClient {
  get(url: string, headers?: Readonly<Record<string, string>>): Promise<HttpResponse>
}

/** Client construction options. */
export interface HttpClientOptions {
  readonly timeoutMs: number
  readonly minIntervalMs: number
  readonly retries: number
  readonly userAgent: string
  readonly fetchImpl?: typeof fetch
}

/**
 * Reject any URL outside the allowlist (https only).
 * @param raw - the URL to check.
 * @returns the parsed URL.
 */
export function assertAllowed(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HarvestNetworkError('blocked', `invalid URL: ${raw}`)
  }
  if (url.protocol !== 'https:') throw new HarvestNetworkError('blocked', `only https is allowed: ${url.host}`)
  if (!(ALLOWED_HOSTS as readonly string[]).includes(url.host)) {
    throw new HarvestNetworkError('blocked', `host not allowlisted: ${url.host}`)
  }
  return url
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Build the bounded client.
 * @param options - timeouts, interval, retries, User-Agent.
 * @returns an {@link HttpClient}.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const lastByHost = new Map<string, number>()

  async function waitForHost(host: string): Promise<void> {
    const last = lastByHost.get(host)
    if (last !== undefined) {
      const wait = last + options.minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
    }
    lastByHost.set(host, Date.now())
  }

  async function once(url: URL, headers: Readonly<Record<string, string>>): Promise<HttpResponse> {
    await waitForHost(url.host)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    try {
      const response = await fetchImpl(url, {
        headers: { 'user-agent': options.userAgent, ...headers },
        redirect: 'error',
        signal: controller.signal,
      })
      const body = await response.text()
      return {
        status: response.status,
        body,
        url: response.url === '' ? url.toString() : response.url,
        contentType: response.headers.get('content-type') ?? '',
      }
    } catch (error) {
      if (error instanceof HarvestNetworkError) throw error
      if (controller.signal.aborted) throw new HarvestNetworkError('timeout', `request timed out after ${options.timeoutMs}ms: ${url.host}`)
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('redirect')) throw new HarvestNetworkError('redirect', `redirect refused: ${url.host}`)
      throw new HarvestNetworkError('http', `${message}: ${url.host}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async get(raw: string, headers: Readonly<Record<string, string>> = {}): Promise<HttpResponse> {
      const url = assertAllowed(raw)
      let attempt = 0
      for (;;) {
        const response = await once(url, headers)
        if (response.status >= 300 && response.status < 400) {
          throw new HarvestNetworkError('redirect', `redirect (${response.status}) refused: ${url.host}`, response.status)
        }
        if ((response.status === 429 || response.status === 503) && attempt < options.retries) {
          attempt += 1
          await sleep(500 * attempt)
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          throw new HarvestNetworkError('http', `HTTP ${response.status} from ${url.host}`, response.status)
        }
        return response
      }
    },
  }
}

/**
 * Parse a JSON response, mapping a parse failure to a typed error.
 * @param response - the raw response.
 * @returns the parsed value.
 */
export function jsonOf(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body) as unknown
  } catch (error) {
    throw new HarvestNetworkError('invalid-json', `invalid JSON from ${new URL(response.url).host}: ${(error as Error).message}`)
  }
}
