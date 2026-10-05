/**
 * Secret redaction for anything that may end up in logs.
 * The Telegram Bot API URL embeds the token (https://api.telegram.org/bot<TOKEN>/method),
 * so every error that may carry a URL goes through `redact` before it is printed.
 */

// Telegram tokens look like `123456789:AAH...` (numeric bot id, colon, 35 url-safe chars).
const TOKEN_LIKE = /\b\d{5,16}:[A-Za-z0-9_-]{30,}\b/g
const BOT_PATH = /\/bot[^/\s"'?]+/g

export function redact(input: unknown, secrets: Array<string | undefined> = []) {
  let s =
    input instanceof Error
      ? `${input.name}: ${input.message}`
      : typeof input === 'string'
      ? input
      : safeStringify(input)
  for (const secret of secrets) {
    if (secret && secret.length >= 4) s = s.split(secret).join('<redacted>')
  }
  return s
    .replace(BOT_PATH, '/bot<redacted>')
    .replace(TOKEN_LIKE, '<redacted>')
    .replace(/([?&](?:api[-_]?key|token|key)=)[^&\s"']+/gi, '$1<redacted>')
}

/** Show only scheme+host of an RPC URL (Helius etc. put API keys in the query/path). */
export function redactUrl(url: string) {
  try {
    const u = new URL(url)
    const hasMore = (u.pathname && u.pathname !== '/') || u.search
    return `${u.protocol}//${u.host}${hasMore ? '/<redacted>' : ''}`
  } catch {
    return '<invalid-url>'
  }
}

function safeStringify(v: unknown) {
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  } catch {
    return String(v)
  }
}
