import type { NextApiRequest, NextApiResponse } from 'next'
import { safeError } from './rpc'
import { OfflineMissError } from './cache'

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const SYMBOL = /^[A-Za-z0-9 _.-]{1,40}$/

export const isPubkey = (s: unknown): s is string => typeof s === 'string' && BASE58.test(s)
export const isRealmInput = (s: unknown): s is string =>
  typeof s === 'string' && (BASE58.test(s) || SYMBOL.test(s))

export class BadRequest extends Error {}

export function route(
  fn: (req: NextApiRequest) => Promise<unknown>,
  cacheSeconds = 30,
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
    try {
      const body = await fn(req)
      res.setHeader('Cache-Control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=600`)
      return res.status(200).json(body)
    } catch (e) {
      const status = e instanceof BadRequest ? 400 : e instanceof OfflineMissError ? 404 : 502
      const msg = safeError(e)
      if (status === 502) console.error('[lens]', req.url, msg)
      res.setHeader('Cache-Control', 'no-store')
      return res.status(status).json({ error: msg })
    }
  }
}
