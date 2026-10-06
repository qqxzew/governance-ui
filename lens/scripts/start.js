#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
// Start the lens production server and pre-warm the featured realm, so the first
// visitor (a judge) never waits on cold RPC. Works in PowerShell and Linux.
//   node lens/scripts/start.js            (PORT env, default 3100)
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

const root = path.join(__dirname, '..', '..')
const port = process.env.PORT || '3100'
const nextBin = require.resolve('next/dist/bin/next', { paths: [root] })
const child = spawn(process.execPath, [nextBin, 'start', 'lens', '-p', port], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))

function get(url) {
  return new Promise((resolve) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      .on('error', () => resolve({ status: 0, body: '' }))
  })
}

const CASES = [
  '7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj',
  'EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9',
  'CrbL16mpZRFJwKqkMsnVjHRP44n422opfQ1pGRL6zGoz',
]

;(async () => {
  if (process.env.LENS_OFFLINE === '1' || process.env.LENS_NO_WARM === '1') return
  for (let i = 0; i < 60; i++) {
    const r = await get(`http://localhost:${port}/api/meta`)
    if (r.status === 200) break
    await new Promise((s) => setTimeout(s, 1000))
  }
  const t0 = Date.now()
  const r = await get(`http://localhost:${port}/api/warm?pks=${CASES.join(',')}`)
  console.log(`[lens] warm-up ${r.status} in ${Date.now() - t0} ms ${r.body.slice(0, 160)}`)
})()
