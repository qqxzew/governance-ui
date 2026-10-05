/**
 * Minimal Telegram Bot API client over fetch (Node 22 global fetch, no library).
 * The token is part of the request URL, so errors are rebuilt from scratch and
 * passed through `redact` — never rethrow raw fetch errors.
 */
import { redact } from './redact'

export interface TgUser {
  id: number
  is_bot?: boolean
  username?: string
}
export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}
export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  text?: string
}
export interface TgUpdate {
  update_id: number
  message?: TgMessage
}

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'TelegramError'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class TelegramClient {
  private readonly base: string

  constructor(private readonly token: string, apiBase = 'https://api.telegram.org') {
    if (!/^\d{5,16}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      // Do not echo the value.
      throw new Error('TELEGRAM_BOT_TOKEN has an unexpected format (expected <digits>:<secret>)')
    }
    this.base = `${apiBase}/bot${token}/`
  }

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    let res: Response
    try {
      res = await fetch(this.base + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e: any) {
      const cause = e?.cause ? ` (${redact(e.cause, [this.token])})` : ''
      throw new TelegramError(`${method}: network error: ${redact(e, [this.token])}${cause}`)
    }
    let json: any
    try {
      json = await res.json()
    } catch {
      throw new TelegramError(`${method}: HTTP ${res.status} (non-JSON response)`, res.status)
    }
    if (!json?.ok) {
      throw new TelegramError(
        `${method}: ${json?.error_code ?? res.status} ${redact(String(json?.description ?? ''), [this.token])}`,
        json?.error_code ?? res.status,
        json?.parameters?.retry_after,
      )
    }
    return json.result as T
  }

  getMe() {
    return this.call<TgUser>('getMe', {}, 20_000)
  }

  getUpdates(offset: number, timeoutSec = 50) {
    return this.call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message'] },
      (timeoutSec + 15) * 1000,
    )
  }

  /** Plain text (no parse_mode), link previews off. Retries 429 using retry_after. */
  async sendMessage(chatId: number, text: string, replyTo?: number) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.call<TgMessage>(
          'sendMessage',
          {
            chat_id: chatId,
            text,
            link_preview_options: { is_disabled: true },
            ...(replyTo
              ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
              : {}),
          },
          30_000,
        )
      } catch (e) {
        if (e instanceof TelegramError && e.code === 429 && attempt < 5) {
          await sleep(Math.min((e.retryAfter ?? 5) * 1000, 60_000) + 250)
          continue
        }
        throw e
      }
    }
  }
}
