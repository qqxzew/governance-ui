// Same-origin JSON-RPC proxy for public deployments (e.g. Vercel).
// - The upstream URL (with its API key) lives only in the server env var RPC_UPSTREAM;
//   the browser talks to /api/rpc and never sees the key.
// - Read-only: transaction sending is refused (mainnet is read-only in this fork's demo builds).
// - Large responses (Marinade getProgramAccounts can exceed 10 MB) are gzip-compressed so they
//   fit serverless response limits.
import type { NextApiRequest, NextApiResponse } from 'next'
import { gzipSync } from 'zlib'

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' }, responseLimit: false },
}

const BLOCKED_METHODS = new Set(['sendTransaction', 'requestAirdrop'])
const MAX_BATCH = 120
const GZIP_THRESHOLD = 64 * 1024

// Best-effort per-instance rate limit (serverless instances do not share memory).
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = Number(process.env.RPC_RATE_LIMIT_PER_10S || 400)
const hits = new Map<string, { t: number; n: number }>()

function rateLimited(ip: string) {
  const now = Date.now()
  const h = hits.get(ip)
  if (!h || now - h.t > WINDOW_MS) {
    hits.set(ip, { t: now, n: 1 })
    if (hits.size > 5000) hits.clear()
    return false
  }
  h.n++
  return h.n > MAX_PER_WINDOW
}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
})

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json(rpcError(null, -32600, 'POST only'))

  const upstream = process.env.RPC_UPSTREAM
  if (!upstream) return res.status(500).json(rpcError(null, -32603, 'RPC_UPSTREAM not configured'))

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim()
  if (rateLimited(ip)) return res.status(429).json(rpcError(null, -32005, 'rate limited, slow down'))

  const body = req.body
  const calls = Array.isArray(body) ? body : [body]
  if (!calls.length || calls.length > MAX_BATCH || calls.some((c) => !c || typeof c.method !== 'string')) {
    return res.status(400).json(rpcError(null, -32600, 'invalid JSON-RPC request'))
  }
  const blocked = calls.find((c) => BLOCKED_METHODS.has(c.method))
  if (blocked) {
    return res
      .status(200)
      .json(rpcError(blocked.id, -32601, 'This deployment is read-only: sending transactions is disabled.'))
  }

  try {
    const r = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    res.status(r.status)
    res.setHeader('Content-Type', 'application/json')
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
    if (acceptsGzip && text.length > GZIP_THRESHOLD) {
      res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Vary', 'Accept-Encoding')
      return res.end(gzipSync(text))
    }
    return res.end(text)
  } catch (e) {
    // never echo the upstream URL (it contains the API key)
    return res.status(502).json(rpcError(null, -32603, 'upstream RPC unavailable'))
  }
}
