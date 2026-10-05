/**
 * @jest-environment node
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  canonicalize,
  requestKey,
  looseRequestKey,
  recordEntry,
  replayLookup,
  emptySnapshot,
  createProxy,
  parseArgs,
  saveSnapshot,
  upstreamSecrets,
} = require('../rpc-proxy')

const PK = '899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo'

describe('canonical keying', () => {
  test('canonicalize sorts object keys recursively', () => {
    expect(canonicalize({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
    )
  })

  test('jsonrpc id and version are ignored', () => {
    const a = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [PK, { encoding: 'base64' }],
    }
    const b = {
      jsonrpc: '2.0',
      id: 'abc',
      method: 'getAccountInfo',
      params: [PK, { encoding: 'base64' }],
    }
    expect(requestKey(a)).toBe(requestKey(b))
  })

  test('param key order does not matter', () => {
    const a = {
      method: 'getProgramAccounts',
      params: [
        PK,
        {
          encoding: 'base64',
          filters: [{ memcmp: { offset: 0, bytes: 'x' } }],
        },
      ],
    }
    const b = {
      method: 'getProgramAccounts',
      params: [
        PK,
        {
          filters: [{ memcmp: { bytes: 'x', offset: 0 } }],
          encoding: 'base64',
        },
      ],
    }
    expect(requestKey(a)).toBe(requestKey(b))
  })

  test('method and params values matter', () => {
    const base = { method: 'getAccountInfo', params: [PK] }
    expect(requestKey(base)).not.toBe(
      requestKey({ method: 'getBalance', params: [PK] }),
    )
    expect(requestKey(base)).not.toBe(
      requestKey({ method: 'getAccountInfo', params: ['other'] }),
    )
    // array order is significant
    expect(requestKey({ method: 'm', params: [1, 2] })).not.toBe(
      requestKey({ method: 'm', params: [2, 1] }),
    )
  })

  test('missing params equals empty params', () => {
    expect(requestKey({ method: 'getSlot' })).toBe(
      requestKey({ method: 'getSlot', params: [] }),
    )
  })

  test('loose key ignores commitment / minContextSlot / empty config', () => {
    const a = {
      method: 'getAccountInfo',
      params: [PK, { encoding: 'base64', commitment: 'confirmed' }],
    }
    const b = {
      method: 'getAccountInfo',
      params: [
        PK,
        { encoding: 'base64', commitment: 'processed', minContextSlot: 5 },
      ],
    }
    expect(requestKey(a)).not.toBe(requestKey(b))
    expect(looseRequestKey(a)).toBe(looseRequestKey(b))
    expect(
      looseRequestKey({
        method: 'getSlot',
        params: [{ commitment: 'confirmed' }],
      }),
    ).toBe(looseRequestKey({ method: 'getSlot' }))
    // but not encoding
    const c = {
      method: 'getAccountInfo',
      params: [PK, { encoding: 'jsonParsed' }],
    }
    expect(looseRequestKey(a)).not.toBe(looseRequestKey(c))
  })
})

describe('record + replay lookup', () => {
  test('replay preserves the caller id and serves exact, loose and latest hits', () => {
    const snap = emptySnapshot()
    recordEntry(
      snap,
      {
        id: 7,
        method: 'getAccountInfo',
        params: [PK, { commitment: 'confirmed' }],
      },
      { jsonrpc: '2.0', id: 7, result: { value: 1 } },
    )
    recordEntry(
      snap,
      { id: 8, method: 'getSlot', params: [] },
      { jsonrpc: '2.0', id: 8, result: 100 },
    )
    recordEntry(
      snap,
      { id: 9, method: 'getSlot', params: [] },
      { jsonrpc: '2.0', id: 9, result: 101 },
    )

    const exact = replayLookup(snap, {
      jsonrpc: '2.0',
      id: 'x',
      method: 'getAccountInfo',
      params: [PK, { commitment: 'confirmed' }],
    })
    expect(exact.source).toBe('exact')
    expect(exact.response).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      result: { value: 1 },
    })

    const loose = replayLookup(snap, {
      id: 3,
      method: 'getAccountInfo',
      params: [PK, { commitment: 'processed' }],
    })
    expect(loose.source).toBe('loose')
    expect(loose.response.id).toBe(3)

    const latest = replayLookup(snap, {
      id: 4,
      method: 'getSlot',
      params: [{ commitment: 'finalized', minContextSlot: 1, foo: 1 }],
    })
    expect(latest.source).toBe('latest')
    expect(latest.response.result).toBe(101)

    expect(
      replayLookup(snap, { id: 5, method: 'getBalance', params: [PK] }),
    ).toBeNull()
  })

  test('rate-limit errors are not recorded; a result is not overwritten by an error', () => {
    const snap = emptySnapshot()
    const q = { id: 1, method: 'getBalance', params: [PK] }
    expect(
      recordEntry(snap, q, {
        id: 1,
        error: { code: 429, message: 'Too many requests' },
      }),
    ).toBe(false)
    expect(recordEntry(snap, q, { id: 1, result: { value: 5 } })).toBe(true)
    expect(
      recordEntry(snap, q, { id: 1, error: { code: -32602, message: 'bad' } }),
    ).toBe(false)
    expect(replayLookup(snap, q).response.result).toEqual({ value: 5 })
  })

  test('parseArgs defaults and flags', () => {
    const o = parseArgs(['--mode', 'replay', '--port=9000', '--no-ws'], {})
    expect(o.mode).toBe('replay')
    expect(o.port).toBe(9000)
    expect(o.wsPort).toBeNull()
    expect(parseArgs([], { PORT: '8898' }).wsPort).toBe(8899)
    expect(() => parseArgs(['--mode', 'nope'], {})).toThrow()
  })
})

// ---------------------------------------------------------------- e2e ---

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3000',
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            json: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

function listen(server) {
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r(server.address().port)),
  )
}

describe('proxy end-to-end (fake upstream)', () => {
  let upstream
  let upstreamPort
  const seenOrigins = []
  let tmp

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcproxy-'))
    upstream = http.createServer((req, res) => {
      seenOrigins.push(req.headers.origin)
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const answer = (q) => ({
          jsonrpc: '2.0',
          id: q.id,
          result: { method: q.method, echo: q.params || [] },
        })
        // reply to batches in reverse order to prove id matching
        const out = Array.isArray(body)
          ? body.map(answer).reverse()
          : answer(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      })
    })
    upstreamPort = await listen(upstream)
  })

  afterAll(() => {
    upstream.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('record (single + batch) then replay offline', async () => {
    const snapshot = path.join(tmp, 'rpc.json')
    const rec = createProxy({
      mode: 'record',
      snapshot,
      upstream: `http://127.0.0.1:${upstreamPort}`,
      allowSend: false,
      quiet: true,
    })
    const recPort = await listen(rec.server)

    const single = await post(recPort, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [PK],
    })
    expect(single.json.result.method).toBe('getAccountInfo')
    expect(single.headers['access-control-allow-origin']).toBe('*')
    expect(seenOrigins.every((o) => o === undefined)).toBe(true)

    const batch = await post(recPort, [
      { jsonrpc: '2.0', id: 10, method: 'getBalance', params: [PK] },
      { jsonrpc: '2.0', id: 11, method: 'getSlot' },
    ])
    expect(batch.json).toHaveLength(2)

    const send = await post(recPort, {
      jsonrpc: '2.0',
      id: 2,
      method: 'sendTransaction',
      params: ['AAAA'],
    })
    expect(send.json.error.code).toBe(-32003)

    rec.flush()
    rec.server.close()
    const saved = JSON.parse(fs.readFileSync(snapshot, 'utf8'))
    expect(Object.keys(saved.entries)).toHaveLength(3)

    // replay: upstream not used
    upstream.close()
    const rep = createProxy({ mode: 'replay', snapshot, quiet: true })
    const repPort = await listen(rep.server)

    const r1 = await post(repPort, {
      jsonrpc: '2.0',
      id: 'abc',
      method: 'getAccountInfo',
      params: [PK],
    })
    expect(r1.json).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      result: { method: 'getAccountInfo', echo: [PK] },
    })

    const r2 = await post(repPort, [
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'getSlot',
        params: [{ commitment: 'confirmed' }],
      },
      { jsonrpc: '2.0', id: 20, method: 'getBalance', params: [PK] },
      { jsonrpc: '2.0', id: 22, method: 'getMultipleAccounts', params: [[PK]] },
    ])
    expect(r2.json.map((x) => x.id)).toEqual([21, 20, 22])
    expect(r2.json[0].result.method).toBe('getSlot')
    expect(r2.json[1].result.method).toBe('getBalance')
    expect(r2.json[2].error.code).toBe(-32001)
    expect(rep.stats.misses).toBe(1)
    rep.server.close()
  })
})

describe('upstream secrets', () => {
  const KEY = '0123456789abcdef-0123-4567-89ab-cdef01234567'
  test('--env-file + --upstream-env picks the URL without exporting it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcenv-'))
    const file = path.join(tmp, '.env.local')
    fs.writeFileSync(
      file,
      `# comment\nBACKEND_MAINNET_RPC="https://rpc.example.com/?api-key=${KEY}"\n`,
    )
    const o = parseArgs(
      ['--env-file', file, '--upstream-env', 'BACKEND_MAINNET_RPC'],
      {},
    )
    expect(o.upstream).toBe(`https://rpc.example.com/?api-key=${KEY}`)
    expect(process.env.BACKEND_MAINNET_RPC).toBeUndefined()
    expect(parseArgs(['--upstream-env', 'NOPE_NOT_SET'], {}).upstream).toBe(
      'https://api.mainnet-beta.solana.com',
    )
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('snapshot containing the upstream key is never written', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpcsec-'))
    const file = path.join(tmp, 'rpc.json')
    const secrets = upstreamSecrets(`https://rpc.example.com/?api-key=${KEY}`)
    expect(secrets).toEqual([KEY])
    const snap = emptySnapshot()
    recordEntry(snap, { method: 'getSlot' }, { result: 1 })
    saveSnapshot(file, snap, secrets)
    expect(fs.existsSync(file)).toBe(true)
    recordEntry(snap, { method: 'echo', params: [KEY] }, { result: KEY })
    expect(() => saveSnapshot(file, snap, secrets)).toThrow(/upstream key/)
    expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('upstream pointing at the proxy itself is rejected', () => {
    expect(() =>
      parseArgs(['--port', '8898', '--upstream', 'http://localhost:8898'], {}),
    ).toThrow(/loop/)
  })
})
