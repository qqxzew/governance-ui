// Server-only env lookup: process.env first, then the repo root's .env.local / .env
// (lens/ is a separate Next app, so Next does not load the root files for it).
import * as fs from 'fs'
import * as path from 'path'
import { REPO_ROOT } from './cache'

let fileEnv: Record<string, string> | undefined

function loadFileEnv() {
  if (fileEnv) return fileEnv
  fileEnv = {}
  for (const f of ['.env', '.env.local']) {
    try {
      for (const line of fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
        if (m) fileEnv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
      }
    } catch {
      /* file absent */
    }
  }
  return fileEnv
}

export function serverEnv(name: string): string | undefined {
  return process.env[name] || loadFileEnv()[name] || undefined
}

export const rpcUpstream = () => serverEnv('RPC_UPSTREAM') || serverEnv('BACKEND_MAINNET_RPC')
