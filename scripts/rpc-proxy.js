// Phase-0 helper: local RPC proxy. Public mainnet RPC returns 403 for requests
// carrying a browser Origin header; this forwards JSON-RPC without it and
// retries 429s with backoff. Not product code.
const http = require('http')
const https = require('https')
const UPSTREAM = process.env.UPSTREAM || 'https://api.mainnet-beta.solana.com'
const PORT = Number(process.env.PORT || 8898)

function forward(body, attempt = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(UPSTREAM)
    const req = https.request(
      { hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
      }
    )
    req.on('error', reject)
    req.end(body)
  }).then(async (r) => {
    if (r.status === 429 && attempt < 8) {
      await new Promise((s) => setTimeout(s, 500 * 2 ** Math.min(attempt, 4)))
      return forward(body, attempt + 1)
    }
    return r
  })
}

http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString()
    try {
      const r = await forward(body)
      let method = '?'
      try { const j = JSON.parse(body); method = Array.isArray(j) ? `batch(${j.length})` : j.method } catch {}
      console.log(new Date().toISOString(), r.status, method)
      res.writeHead(r.status, { ...cors, 'Content-Type': 'application/json' })
      res.end(r.body)
    } catch (e) {
      console.log('ERR', e.message)
      res.writeHead(502, cors); res.end(JSON.stringify({ error: e.message }))
    }
  })
}).listen(PORT, () => console.log('rpc proxy on', PORT, '->', UPSTREAM))
