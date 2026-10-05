#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
// Local JSON-RPC proxy for the governance UI (dev + offline demo). Not product code.
//
// Why: the public mainnet RPC returns 403 to any request carrying a browser
// `Origin` header, and rate-limits with 429. This proxy forwards JSON-RPC
// without the Origin header, retries 429 with backoff, and can record/replay
// responses so the demo works fully offline.
//
// Usage (works the same in PowerShell and bash):
//   node scripts/rpc-proxy.js --mode live
//   node scripts/rpc-proxy.js --mode record --snapshot demo/snapshot/rpc.json
//   node scripts/rpc-proxy.js --mode replay --snapshot demo/snapshot/rpc.json
// Options (CLI flag | env var | default):
//   --mode      | RPC_PROXY_MODE | live        live | record | replay
//   --snapshot  | RPC_SNAPSHOT   | demo/snapshot/rpc.json
//   --port      | PORT           | 8898        HTTP JSON-RPC port
//   --ws-port   | WS_PORT        | port + 1    WebSocket port (web3.js Connection
//                                              derives ws://host:<port+1> from an
//                                              http://host:<port> endpoint)
//   --no-ws     |                |             do not open the WebSocket port
//   --upstream  | UPSTREAM       | https://api.mainnet-beta.solana.com
//   --allow-send| RPC_ALLOW_SEND |             forward sendTransaction (blocked by
//                                              default: the mainnet demo is read-only)
//   --quiet     |                |             log only misses/errors
//
// Snapshot format (JSON):
//   { version: 1, entries: { <key>: { method, params, response, recordedAt } },
//     loose: { <looseKey>: <key> }, latest: { <method>: <key> } }
// where response is { result } or { error } (never the jsonrpc id).
// Keys: sha256 of method + canonical JSON of params (object keys sorted,
// missing params == []). The jsonrpc `id` is ignored. A second "loose" key
// also ignores commitment / minContextSlot so the same read issued with a
// different commitment still replays.

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ---------------------------------------------------------------- keying ---

/** Deterministic JSON: object keys sorted recursively; undefined dropped. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value)
  }
  if (Array.isArray(value)) {
    return (
      '[' +
      value.map((v) => canonicalize(v === undefined ? null : v)).join(',') +
      ']'
    )
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]))
      .join(',') +
    '}'
  )
}

const LOOSE_IGNORED_FIELDS = new Set([
  'commitment',
  'minContextSlot',
  'preflightCommitment',
])

/** Strip fields that do not change *what* is read (only how fresh it is). */
function loosenParams(params) {
  if (Array.isArray(params)) return params.map(loosenParams)
  if (params && typeof params === 'object') {
    const out = {}
    for (const k of Object.keys(params)) {
      if (LOOSE_IGNORED_FIELDS.has(k)) continue
      out[k] = loosenParams(params[k])
    }
    return out
  }
  return params
}

/** Drop a trailing empty config object, e.g. [pk, {}] == [pk]. */
function trimTrailingEmpty(params) {
  if (!Array.isArray(params)) return params
  const p = params.slice()
  while (p.length) {
    const last = p[p.length - 1]
    const empty =
      last === null ||
      last === undefined ||
      (typeof last === 'object' &&
        !Array.isArray(last) &&
        Object.keys(last).length === 0)
    if (!empty) break
    p.pop()
  }
  return p
}

function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/** Exact key: method + canonical params. jsonrpc id/version ignored. */
function requestKey(req) {
  const params = req.params === undefined ? [] : req.params
  return hash(String(req.method) + '\n' + canonicalize(params))
}

/** Loose key: also ignores commitment/minContextSlot and empty trailing config. */
function looseRequestKey(req) {
  const params = req.params === undefined ? [] : req.params
  return hash(
    String(req.method) +
      '\n' +
      canonicalize(trimTrailingEmpty(loosenParams(params))),
  )
}

// Methods whose answer changes every slot. In replay, if the exact request
// was never recorded, serve the last recorded answer for the same method.
const VOLATILE_METHODS = new Set([
  'getLatestBlockhash',
  'getRecentBlockhash',
  'getSlot',
  'getBlockHeight',
  'getEpochInfo',
  'getEpochSchedule',
  'getRecentPrioritizationFees',
  'getRecentPerformanceSamples',
  'getFeeForMessage',
  'getFees',
  'getHealth',
  'getVersion',
  'getGenesisHash',
  'getMinimumBalanceForRentExemption',
  'isBlockhashValid',
  'getBlockTime',
  'getSupply',
])

const SEND_METHODS = new Set(['sendTransaction', 'requestAirdrop'])

// -------------------------------------------------------------- snapshot ---

function emptySnapshot() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    entries: {},
    loose: {},
    latest: {},
  }
}

function loadSnapshot(file, { mustExist }) {
  if (!fs.existsSync(file)) {
    if (mustExist) throw new Error(`snapshot not found: ${file}`)
    return emptySnapshot()
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  snap.entries = snap.entries || {}
  snap.loose = snap.loose || {}
  snap.latest = snap.latest || {}
  return snap
}

function saveSnapshot(file, snap) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  snap.updatedAt = new Date().toISOString()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(snap))
  fs.renameSync(tmp, file)
}

/** Store one {request, response} pair. Returns true if the snapshot changed. */
function recordEntry(snap, req, response) {
  if (!response || typeof response !== 'object') return false
  const hasResult = Object.prototype.hasOwnProperty.call(response, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(response, 'error')
  if (!hasResult && !hasError) return false
  // Never record rate-limit / transient upstream errors as truth.
  if (
    hasError &&
    response.error &&
    [429, -32005, -32004, -32007].includes(response.error.code)
  )
    return false
  const key = requestKey(req)
  const existing = snap.entries[key]
  // Keep a good result over a later error.
  if (
    existing &&
    hasError &&
    Object.prototype.hasOwnProperty.call(existing.response, 'result')
  )
    return false
  snap.entries[key] = {
    method: req.method,
    params: req.params === undefined ? [] : req.params,
    response: hasResult
      ? { result: response.result }
      : { error: response.error },
    recordedAt: new Date().toISOString(),
  }
  snap.loose[looseRequestKey(req)] = key
  if (hasResult) snap.latest[req.method] = key
  return true
}

/**
 * Answer one request from the snapshot. Returns
 * { response, source: 'exact'|'loose'|'latest' } or null on a miss.
 * The returned response carries the caller's jsonrpc id.
 */
function replayLookup(snap, req) {
  const id = req.id === undefined ? null : req.id
  const wrap = (entry, source) => ({
    response: { jsonrpc: '2.0', id, ...entry.response },
    source,
  })
  const exact = snap.entries[requestKey(req)]
  if (exact) return wrap(exact, 'exact')
  const looseKey = snap.loose[looseRequestKey(req)]
  if (looseKey && snap.entries[looseKey])
    return wrap(snap.entries[looseKey], 'loose')
  if (VOLATILE_METHODS.has(req.method)) {
    const latestKey = snap.latest[req.method]
    if (latestKey && snap.entries[latestKey])
      return wrap(snap.entries[latestKey], 'latest')
  }
  return null
}

function rpcError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error: { code, message },
  }
}

// --------------------------------------------------------------- upstream ---

function redact(url) {
  try {
    const u = new URL(url)
    return u.origin + u.pathname + (u.search ? '?<redacted>' : '')
  } catch {
    return '<invalid url>'
  }
}

function forward(upstream, body, attempt = 0) {
  const u = new URL(upstream)
  const lib = u.protocol === 'http:' ? http : https
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'POST',
        // No Origin / Referer: the public RPC rejects browser origins.
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) }),
        )
      },
    )
    req.on('timeout', () => req.destroy(new Error('upstream timeout')))
    req.on('error', reject)
    req.end(body)
  }).then(async (r) => {
    if (r.status === 429 && attempt < 8) {
      await new Promise((s) => setTimeout(s, 500 * 2 ** Math.min(attempt, 4)))
      return forward(upstream, body, attempt + 1)
    }
    return r
  })
}

// ------------------------------------------------------------------- args ---

function parseArgs(argv, env) {
  const get = (name) => {
    const i = argv.indexOf(name)
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
    const eq = argv.find((a) => a.startsWith(name + '='))
    return eq ? eq.slice(name.length + 1) : undefined
  }
  const has = (name) => argv.includes(name)
  const port = Number(get('--port') || env.PORT || 8898)
  const opts = {
    mode: get('--mode') || env.RPC_PROXY_MODE || 'live',
    snapshot: path.resolve(
      get('--snapshot') || env.RPC_SNAPSHOT || 'demo/snapshot/rpc.json',
    ),
    port,
    wsPort: has('--no-ws')
      ? null
      : Number(get('--ws-port') || env.WS_PORT || port + 1),
    upstream:
      get('--upstream') ||
      env.UPSTREAM ||
      'https://api.mainnet-beta.solana.com',
    allowSend: has('--allow-send') || env.RPC_ALLOW_SEND === 'true',
    quiet: has('--quiet'),
  }
  if (!['live', 'record', 'replay'].includes(opts.mode)) {
    throw new Error(`unknown --mode ${opts.mode} (live | record | replay)`)
  }
  return opts
}

// ----------------------------------------------------------------- server ---

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

function createProxy(opts) {
  const { mode } = opts
  const snap =
    mode === 'live'
      ? null
      : loadSnapshot(opts.snapshot, { mustExist: mode === 'replay' })
  const stats = {
    requests: 0,
    hits: 0,
    loose: 0,
    latest: 0,
    misses: 0,
    recorded: 0,
    missList: [],
  }
  const log = (...a) => {
    if (!opts.quiet) console.log(new Date().toISOString(), ...a)
  }

  let saveTimer = null
  const scheduleSave = () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        saveSnapshot(opts.snapshot, snap)
      } catch (e) {
        console.error('snapshot save failed:', e.message)
      }
    }, 1000)
  }
  const flush = () => {
    if (mode !== 'record') return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    saveSnapshot(opts.snapshot, snap)
  }

  function blockedSend(r) {
    return !opts.allowSend && SEND_METHODS.has(r.method)
  }

  function answerReplay(r) {
    if (blockedSend(r)) {
      return rpcError(
        r.id,
        -32003,
        'rpc-proxy: sendTransaction is disabled (read-only demo)',
      )
    }
    const hit = replayLookup(snap, r)
    if (hit) {
      stats.hits++
      if (hit.source === 'loose') stats.loose++
      if (hit.source === 'latest') stats.latest++
      return hit.response
    }
    stats.misses++
    const miss = { method: r.method, params: r.params }
    if (stats.missList.length < 500) stats.missList.push(miss)
    console.warn(
      new Date().toISOString(),
      'REPLAY MISS',
      r.method,
      JSON.stringify(r.params || []).slice(0, 300),
    )
    return rpcError(
      r.id,
      -32001,
      `rpc-proxy replay: no recorded response for ${r.method}`,
    )
  }

  async function handleRpc(parsed, rawBody) {
    const isBatch = Array.isArray(parsed)
    const reqs = isBatch ? parsed : [parsed]
    stats.requests += reqs.length

    if (mode === 'replay') {
      const out = reqs.map(answerReplay)
      return { status: 200, body: JSON.stringify(isBatch ? out : out[0]) }
    }

    // live / record: forward (minus blocked sends), keep ids per request.
    const blocked = reqs.filter(blockedSend)
    const toForward = reqs.filter((r) => !blockedSend(r))
    const blockedResponses = blocked.map((r) =>
      rpcError(
        r.id,
        -32003,
        'rpc-proxy: sendTransaction is disabled (start with --allow-send)',
      ),
    )
    if (!toForward.length) {
      return {
        status: 200,
        body: JSON.stringify(isBatch ? blockedResponses : blockedResponses[0]),
      }
    }
    const body = blocked.length
      ? JSON.stringify(isBatch ? toForward : toForward[0])
      : rawBody
    const r = await forward(opts.upstream, body)
    if (mode === 'record' && r.status === 200) {
      try {
        const resp = JSON.parse(r.body.toString())
        const resps = Array.isArray(resp) ? resp : [resp]
        const byId = new Map(resps.map((x) => [JSON.stringify(x && x.id), x]))
        let changed = false
        toForward.forEach((q, i) => {
          // Match by id; fall back to position when ids are missing/duplicated.
          const x = byId.get(JSON.stringify(q.id)) || resps[i]
          if (recordEntry(snap, q, x)) {
            changed = true
            stats.recorded++
          }
        })
        if (changed) scheduleSave()
      } catch (e) {
        console.error('record: could not parse upstream response:', e.message)
      }
    }
    if (!blocked.length) return { status: r.status, body: r.body }
    let merged
    try {
      const resp = JSON.parse(r.body.toString())
      merged = isBatch
        ? [...(Array.isArray(resp) ? resp : [resp]), ...blockedResponses]
        : resp
    } catch {
      return { status: r.status, body: r.body }
    }
    return { status: r.status, body: JSON.stringify(merged) }
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }
    if (req.method === 'GET') {
      // Health / stats endpoint (also handy for the demo verifier script).
      const info = {
        mode,
        upstream: mode === 'replay' ? null : redact(opts.upstream),
        snapshot: mode === 'live' ? null : opts.snapshot,
        entries: snap ? Object.keys(snap.entries).length : null,
        stats: {
          ...stats,
          missList: req.url.includes('misses') ? stats.missList : undefined,
        },
      }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(info, null, 2))
    }
    if (req.method !== 'POST') {
      res.writeHead(405, CORS)
      return res.end()
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString()
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')))
      }
      try {
        const out = await handleRpc(parsed, raw)
        const label = Array.isArray(parsed)
          ? `batch(${parsed.length})`
          : parsed && parsed.method
        log(out.status, mode, label)
        res.writeHead(out.status, {
          ...CORS,
          'Content-Type': 'application/json',
        })
        res.end(out.body)
      } catch (e) {
        console.error(new Date().toISOString(), 'ERR', e.message)
        res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' })
        const id = parsed && !Array.isArray(parsed) ? parsed.id : null
        res.end(
          JSON.stringify(
            rpcError(id, -32002, 'rpc-proxy upstream error: ' + e.message),
          ),
        )
      }
    })
  })

  return { server, snap, stats, flush }
}

// -------------------------------------------------------------- websocket ---
// web3.js opens ws://host:<port+1> lazily, only for subscriptions
// (onAccountChange, signature confirmation). Live/record: relay to upstream
// wss without Origin. Replay: accept subscriptions, never notify (data is
// frozen), so the app does not spin on reconnect errors.

function startWebSocket(opts) {
  let WebSocket
  try {
    WebSocket = require('ws')
  } catch {
    console.warn(
      'ws package not found; WebSocket port disabled (subscriptions will fail, HTTP reads still work)',
    )
    return null
  }
  const wss = new WebSocket.Server({ port: opts.wsPort })
  const upstreamWs = opts.upstream.replace(/^http/, 'ws')
  let nextSubId = 1
  wss.on('connection', (client) => {
    if (opts.mode === 'replay') {
      client.on('message', (data) => {
        let msgs
        try {
          msgs = JSON.parse(data.toString())
        } catch {
          return
        }
        const list = Array.isArray(msgs) ? msgs : [msgs]
        const out = list.map((m) => {
          if (
            typeof m.method === 'string' &&
            m.method.endsWith('Unsubscribe')
          ) {
            return { jsonrpc: '2.0', id: m.id, result: true }
          }
          if (typeof m.method === 'string' && m.method.endsWith('Subscribe')) {
            return { jsonrpc: '2.0', id: m.id, result: nextSubId++ }
          }
          return rpcError(
            m.id,
            -32601,
            'rpc-proxy replay ws: method not supported',
          )
        })
        client.send(JSON.stringify(Array.isArray(msgs) ? out : out[0]))
      })
      return
    }
    const up = new WebSocket(upstreamWs) // no Origin header from Node
    const pending = []
    up.on('open', () => pending.splice(0).forEach((m) => up.send(m)))
    up.on(
      'message',
      (d) => client.readyState === 1 && client.send(d.toString()),
    )
    up.on('close', () => client.close())
    up.on('error', (e) => {
      console.warn('upstream ws error:', e.message)
      client.close()
    })
    client.on('message', (d) => {
      const m = d.toString()
      if (up.readyState === 1) up.send(m)
      else pending.push(m)
    })
    client.on('close', () => up.close())
  })
  wss.on('error', (e) =>
    console.warn(
      `ws port ${opts.wsPort}: ${e.message} (subscriptions disabled)`,
    ),
  )
  return wss
}

// ------------------------------------------------------------------- main ---

function main() {
  const opts = parseArgs(process.argv.slice(2), process.env)
  const { server, snap, stats, flush } = createProxy(opts)
  server.listen(opts.port, () => {
    const where = opts.mode === 'live' ? redact(opts.upstream) : opts.snapshot
    console.log(
      `rpc-proxy [${opts.mode}] http://localhost:${opts.port}` +
        (opts.wsPort ? ` ws://localhost:${opts.wsPort}` : '') +
        ` -> ${
          opts.mode === 'record' ? redact(opts.upstream) + ' => ' : ''
        }${where}` +
        (snap ? ` (${Object.keys(snap.entries).length} entries)` : ''),
    )
  })
  server.on('error', (e) => {
    console.error(`rpc-proxy: cannot listen on ${opts.port}: ${e.message}`)
    process.exit(1)
  })
  if (opts.wsPort) startWebSocket(opts)
  const stop = () => {
    try {
      flush()
    } catch (e) {
      console.error('final save failed:', e.message)
    }
    if (opts.mode !== 'live') {
      console.log(
        `rpc-proxy stats: requests=${stats.requests} hits=${stats.hits} (loose=${stats.loose}, latest=${stats.latest}) misses=${stats.misses} recorded=${stats.recorded}`,
      )
    }
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

module.exports = {
  canonicalize,
  requestKey,
  looseRequestKey,
  recordEntry,
  replayLookup,
  emptySnapshot,
  loadSnapshot,
  saveSnapshot,
  parseArgs,
  createProxy,
  VOLATILE_METHODS,
}

if (require.main === module) main()
