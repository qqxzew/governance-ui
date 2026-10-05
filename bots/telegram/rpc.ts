import { Connection } from '@solana/web3.js'
import { redact } from './redact'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  log?: (msg: string) => void
}

/** Delay for retry `attempt` (0-based): exponential backoff with jitter, honouring Retry-After. */
export function backoffDelay(
  attempt: number,
  retryAfterHeader: string | null | undefined,
  base = 1000,
  max = 30000,
) {
  const ra = retryAfterHeader ? Number(retryAfterHeader) : NaN
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, max)
  const exp = Math.min(base * 2 ** attempt, max)
  return Math.round(exp / 2 + Math.random() * (exp / 2))
}

/**
 * fetch wrapper for web3.js Connection: retries 429 / 5xx / network errors
 * with exponential backoff. Never logs the URL (RPC URLs often carry API keys).
 */
export function makeRetryingFetch(opts: RetryOptions = {}) {
  const maxRetries = opts.maxRetries ?? 6
  const log = opts.log ?? ((m: string) => console.warn(m))
  return async function retryingFetch(input: any, init?: any): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined
      let err: unknown
      try {
        res = await fetch(input, {
          ...init,
          signal: AbortSignal.timeout(60_000),
        })
      } catch (e) {
        err = e
      }
      const retryable =
        err !== undefined ||
        (res !== undefined &&
          (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504))
      if (!retryable || attempt >= maxRetries) {
        if (err) throw new Error(`RPC request failed: ${redact(err)}`)
        return res
      }
      const delay = backoffDelay(
        attempt,
        res?.headers.get('retry-after'),
        opts.baseDelayMs ?? 1000,
        opts.maxDelayMs ?? 30000,
      )
      log(
        `[rpc] ${err ? 'network error' : `HTTP ${res!.status}`}, retry ${
          attempt + 1
        }/${maxRetries} in ${delay} ms`,
      )
      await sleep(delay)
    }
  }
}

export function makeConnection(rpcUrl: string, opts: RetryOptions = {}) {
  return new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: makeRetryingFetch(opts) as any,
  })
}
