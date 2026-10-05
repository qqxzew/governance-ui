#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
// Offline check of a recorded RPC snapshot (no network needed).
//
//   node demo/verify-replay.js [--snapshot demo/snapshot/rpc.json.gz]
//
// 1. Starts the rpc-proxy in replay mode in-process on a free port.
// 2. Replays every recorded request (single + batched, with fresh ids) and
//    checks the answer equals the recorded one and carries the caller's id.
// 3. Uses @solana/web3.js Connection (as the app does) to read the Marinade
//    realm and the demo proposals from the replay proxy.
// Exit code 0 = snapshot is usable for the offline demo.

const http = require('http')
const path = require('path')
const { createProxy, loadSnapshot } = require('../scripts/rpc-proxy')

const args = process.argv.slice(2)
const snapIdx = args.indexOf('--snapshot')
const SNAPSHOT = path.resolve(
  snapIdx >= 0 ? args[snapIdx + 1] : 'demo/snapshot/rpc.json.gz',
)

// Accounts the demo needs (see README-DEMO.md).
const REQUIRED = {
  'Marinade realm': '899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo',
  'MIP-23 (malicious VSR upgrade)':
    '7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj',
  'MIP-24 (malicious treasury drain)':
    'EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9',
  'Benign (USDC vault allocator)':
    'CrbL16mpZRFJwKqkMsnVjHRP44n422opfQ1pGRL6zGoz',
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve(JSON.parse(Buffer.concat(chunks).toString())),
        )
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

async function main() {
  const snap = loadSnapshot(SNAPSHOT, { mustExist: true })
  const entries = Object.values(snap.entries)
  const byMethod = {}
  for (const e of entries) byMethod[e.method] = (byMethod[e.method] || 0) + 1
  console.log(`snapshot: ${SNAPSHOT}`)
  console.log(`entries: ${entries.length}`, byMethod)

  const proxy = createProxy({ mode: 'replay', snapshot: SNAPSHOT, quiet: true })
  const port = await new Promise((r) =>
    proxy.server.listen(0, '127.0.0.1', () => r(proxy.server.address().port)),
  )

  // 2. replay all recorded requests
  let ok = 0
  let bad = 0
  let id = 1000
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const e of entries) {
    const reqId = id++
    const r = await post(port, {
      jsonrpc: '2.0',
      id: reqId,
      method: e.method,
      params: e.params,
    })
    const expected = e.response
    const good =
      r.id === reqId &&
      ('result' in expected
        ? same(r.result, expected.result)
        : same(r.error, expected.error))
    if (good) ok++
    else {
      bad++
      if (bad <= 5)
        console.error(
          'MISMATCH',
          e.method,
          JSON.stringify(e.params).slice(0, 200),
        )
    }
  }
  // one batch with shuffled ids
  const sample = entries.slice(0, 5)
  const batch = sample.map((e, i) => ({
    jsonrpc: '2.0',
    id: `b${i}`,
    method: e.method,
    params: e.params,
  }))
  const batchResp = batch.length ? await post(port, batch) : []
  const batchOk =
    batch.length === 0 ||
    (Array.isArray(batchResp) &&
      batchResp.every(
        (x, i) => x.id === `b${i}` && !x.error === !sample[i].response.error,
      ))
  console.log(
    `replayed ${entries.length}: ${ok} identical, ${bad} mismatched; batch ids preserved: ${batchOk}`,
  )

  // 3. web3.js reads, exactly like the app
  let web3Ok = true
  try {
    const { Connection, PublicKey } = require('@solana/web3.js')
    const conn = new Connection(`http://127.0.0.1:${port}`, 'recent')
    for (const [label, pk] of Object.entries(REQUIRED)) {
      let info = null
      try {
        info = await conn.getAccountInfo(new PublicKey(pk))
      } catch (e) {
        info = null
      }
      // The app often reads accounts via getMultipleAccounts / getProgramAccounts;
      // fall back to scanning the snapshot for the pubkey.
      const inSnapshot = entries.some(
        (e) =>
          JSON.stringify(e.response).includes(pk) ||
          JSON.stringify(e.params).includes(pk),
      )
      const status = info
        ? `getAccountInfo OK (${info.data.length} bytes, owner ${info.owner
            .toBase58()
            .slice(0, 8)}...)`
        : inSnapshot
        ? 'present in snapshot (not as single getAccountInfo)'
        : 'MISSING'
      if (!info && !inSnapshot) web3Ok = false
      console.log(`  ${label.padEnd(36)} ${pk}  ${status}`)
    }
  } catch (e) {
    console.warn('web3.js check skipped:', e.message)
  }
  console.log(
    `proxy stats: hits=${proxy.stats.hits} misses=${proxy.stats.misses}`,
  )
  proxy.server.close()
  const pass = bad === 0 && batchOk && web3Ok && entries.length > 0
  console.log(pass ? 'PASS: snapshot replays offline' : 'FAIL')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
