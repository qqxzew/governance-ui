#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
// Cross-platform "VAR=x cmd" for package.json scripts (works in PowerShell,
// cmd.exe and POSIX shells without cross-env).
//
//   node scripts/run-with-env.js KEY=VALUE [KEY=VALUE ...] -- <command> [args...]
//
// Variables already set in the caller's environment win over the defaults
// given here, unless the KEY is prefixed with "!" (force), e.g. "!REALM=MNDE".
// <command> may be `node`, a package bin (`next`, `jest`, `tsc`, ...), or any
// executable on PATH.
// Several commands can run side by side, separated by "---":
//   node scripts/run-with-env.js A=1 -- node a.js --- next dev
// When any of them exits, the others are stopped and its exit code is returned.

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

/** Resolve a package bin (e.g. "next") to [node, <bin.js>] so no shell is needed. */
function resolveCommand(cmd) {
  if (cmd === 'node') return { file: process.execPath, prefix: [] }
  const binNames = {
    tsc: 'typescript',
    jest: 'jest',
    next: 'next',
    'ts-node': 'ts-node',
  }
  const pkg = binNames[cmd] || cmd
  try {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`, {
      paths: [ROOT],
    })
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    const bin =
      typeof pkgJson.bin === 'string'
        ? pkgJson.bin
        : pkgJson.bin && pkgJson.bin[cmd]
    if (bin)
      return {
        file: process.execPath,
        prefix: [path.join(path.dirname(pkgJsonPath), bin)],
      }
  } catch {
    // not a package bin; fall through
  }
  return { file: cmd, prefix: [], shell: process.platform === 'win32' }
}

function parse(argv) {
  const sep = argv.indexOf('--')
  if (sep < 0)
    throw new Error('usage: run-with-env.js KEY=VALUE ... -- command [args]')
  const env = {}
  for (const a of argv.slice(0, sep)) {
    const m = /^(!?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a)
    if (!m) throw new Error(`bad env assignment: ${a}`)
    const [, force, key, value] = m
    if (force || process.env[key] === undefined || process.env[key] === '')
      env[key] = value
  }
  const commands = []
  let cur = []
  for (const a of argv.slice(sep + 1)) {
    if (a === '---') {
      if (cur.length) commands.push(cur)
      cur = []
    } else cur.push(a)
  }
  if (cur.length) commands.push(cur)
  if (!commands.length) throw new Error('no command given')
  return { env, commands }
}

function main() {
  const { env, commands } = parse(process.argv.slice(2))
  const childEnv = { ...process.env, ...env }
  const shown = Object.entries(env)
    .map(([k, v]) => `${k}=${/KEY|TOKEN|SECRET/i.test(k) ? '<redacted>' : v}`)
    .join(' ')
  if (shown) console.log(`[run-with-env] ${shown}`)

  const children = []
  let exiting = false
  const stopAll = (code) => {
    if (exiting) return
    exiting = true
    for (const c of children) if (c.exitCode === null) c.kill()
    setTimeout(() => process.exit(code), 300)
  }
  for (const [cmd, ...args] of commands) {
    const r = resolveCommand(cmd)
    const child = spawn(r.file, [...r.prefix, ...args], {
      cwd: ROOT,
      env: childEnv,
      stdio: 'inherit',
      shell: !!r.shell,
    })
    child.on('exit', (code, signal) =>
      stopAll(code === null ? (signal ? 1 : 0) : code),
    )
    child.on('error', (e) => {
      console.error(`[run-with-env] failed to start ${cmd}: ${e.message}`)
      stopAll(1)
    })
    children.push(child)
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0))
}

if (require.main === module) {
  try {
    main()
  } catch (e) {
    console.error(`[run-with-env] ${e.message}`)
    process.exit(2)
  }
}

module.exports = { parse, resolveCommand }
