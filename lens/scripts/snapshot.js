#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
// Copy the live server cache (lens/.cache) into lens/demo-data, which is committed and
// used by `npm run lens:offline` (no internet, no RPC). Run after browsing the demo pages live.
// Refuses to copy anything that looks like it contains an RPC API key.
const fs = require('fs')
const path = require('path')

const lens = path.join(__dirname, '..')
const src = path.join(lens, '.cache')
const dst = path.join(lens, 'demo-data')
if (!fs.existsSync(src)) {
  console.error('lens/.cache is empty: run the app live and open the demo pages first.')
  process.exit(1)
}
fs.mkdirSync(dst, { recursive: true })
let n = 0
let bytes = 0
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.json')) continue
  const body = fs.readFileSync(path.join(src, f), 'utf8')
  if (/api-key=|helius-rpc\.com\/\?|TELEGRAM_BOT_TOKEN/.test(body)) {
    console.error(`skipping ${f}: looks like it contains a secret`)
    continue
  }
  fs.writeFileSync(path.join(dst, f), body)
  n++
  bytes += body.length
}
console.log(`copied ${n} cache entries (${(bytes / 1e6).toFixed(2)} MB) to lens/demo-data`)
