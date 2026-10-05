import * as fs from 'fs'
import * as path from 'path'

/**
 * Tiny .env parser (no dotenv dependency). Supports `KEY=value`,
 * `export KEY=value`, single/double quoted values, `#` comments.
 * Existing process.env values win (so PowerShell `$env:X` overrides .env).
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash)
      value = value.trim()
    }
    out[m[1]] = value
  }
  return out
}

export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return
  const parsed = parseDotEnv(fs.readFileSync(file, 'utf8'))
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}

export interface BotConfig {
  token: string | undefined
  /** Bot API base URL; override only for a self-hosted Bot API server or a local mock */
  telegramApiBase: string
  rpcUrl: string
  appUrl: string
  pollSeconds: number
  maxRealms: number
  maxWatchesPerChat: number
  allowedChats: Set<number> | null
  dataDir: string
}

function intEnv(name: string, def: number, min: number, max: number) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  }
  return n
}

export function readConfig(): BotConfig {
  const allowed = (process.env.TELEGRAM_ALLOWED_CHATS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const a of allowed) {
    if (!/^-?\d{1,20}$/.test(a)) {
      throw new Error('TELEGRAM_ALLOWED_CHATS must be comma-separated chat ids')
    }
  }
  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(
    /\/+$/,
    '',
  )
  if (!/^https?:\/\/[^\s]+$/.test(appUrl)) {
    throw new Error('APP_URL must start with http:// or https://')
  }
  const telegramApiBase = (
    process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'
  ).replace(/\/+$/, '')
  if (
    !/^https:\/\/[^\s/]+$/.test(telegramApiBase) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(telegramApiBase)
  ) {
    throw new Error('TELEGRAM_API_BASE must be https://<host> or http://localhost:<port>')
  }
  const rpcUrl = process.env.BOT_RPC_URL || 'https://api.mainnet-beta.solana.com'
  if (!/^https?:\/\//.test(rpcUrl)) {
    throw new Error('BOT_RPC_URL must start with http:// or https://')
  }
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramApiBase,
    rpcUrl,
    appUrl,
    pollSeconds: intEnv('BOT_POLL_SECONDS', 60, 10, 86400),
    maxRealms: intEnv('BOT_MAX_REALMS', 50, 1, 10000),
    maxWatchesPerChat: intEnv('BOT_MAX_WATCHES_PER_CHAT', 10, 1, 1000),
    allowedChats: allowed.length ? new Set(allowed.map(Number)) : null,
    dataDir:
      process.env.BOT_DATA_DIR || path.resolve(__dirname, 'data'),
  }
}
