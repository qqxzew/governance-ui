import { route } from '../../lib/server/api'
import { cached, OFFLINE } from '../../lib/server/cache'
import { serverEnv } from '../../lib/server/env'

// Public bits only: the Telegram bot's @username (looked up server-side; the token never leaves).
export default route(async () => {
  let bot: string | null = null
  const token = serverEnv('TELEGRAM_BOT_TOKEN')
  if (token && !OFFLINE) {
    bot = await cached('meta|bot', 24 * 3600_000, async () => {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`)
      const j = await r.json()
      return j?.ok ? String(j.result.username) : null
    }).catch(() => null)
  }
  return { bot: bot ?? process.env.LENS_TELEGRAM_BOT ?? null, offline: OFFLINE }
}, 3600)
