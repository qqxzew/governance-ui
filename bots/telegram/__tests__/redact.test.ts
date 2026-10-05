import { redact, redactUrl } from '../redact'
import { TelegramClient, TelegramError } from '../telegram'

// Fake token in the real format; not a working credential.
const TOKEN = '1234567890:AAFakeFakeFakeFakeFakeFakeFakeFake_xyz'

describe('redact', () => {
  it('removes the token, Bot API paths and api keys', () => {
    const msg = `request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`
    const out = redact(new Error(msg), [TOKEN])
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain('AAFake')
    expect(out).toContain('/bot<redacted>/getUpdates')
  })

  it('catches token-looking strings even when the secret is not passed', () => {
    expect(redact(`oops ${TOKEN}`)).toBe('oops <redacted>')
    expect(redact('https://mainnet.helius-rpc.com/?api-key=abcd-1234')).toBe(
      'https://mainnet.helius-rpc.com/?api-key=<redacted>',
    )
    expect(redact({ url: `https://api.telegram.org/bot${TOKEN}/x` })).not.toContain('AAFake')
  })

  it('redactUrl keeps only scheme and host', () => {
    expect(redactUrl('https://rpc.example.com/v1/SECRET?api-key=x')).toBe('https://rpc.example.com/<redacted>')
    expect(redactUrl('http://localhost:8898')).toBe('http://localhost:8898')
    expect(redactUrl('nope')).toBe('<invalid-url>')
  })
})

describe('TelegramClient never leaks the token', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it('rejects malformed tokens without echoing them', () => {
    expect(() => new TelegramClient('not-a-token-SECRET')).toThrow(/unexpected format/)
    try {
      new TelegramClient('not-a-token-SECRET')
    } catch (e: any) {
      expect(e.message).not.toContain('SECRET')
    }
  })

  it('network errors carrying the URL are redacted', async () => {
    global.fetch = jest.fn(async (url: any) => {
      const err: any = new TypeError(`fetch failed for ${url}`)
      err.cause = new Error(`connect ECONNREFUSED ${url}`)
      throw err
    }) as any
    const tg = new TelegramClient(TOKEN)
    const e: any = await tg.getMe().catch((x) => x)
    expect(e).toBeInstanceOf(TelegramError)
    expect(e.message).toContain('getMe: network error')
    expect(e.message).not.toContain(TOKEN)
    expect(e.message).not.toContain('AAFake')
    expect(String(e.stack)).not.toContain('AAFake')
  })

  it('API errors are surfaced with code, without the token; 429 is retried', async () => {
    const calls: string[] = []
    let n = 0
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push(String(url))
      n++
      if (n === 1) {
        return { status: 429, json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }) }
      }
      if (n === 2) {
        expect(JSON.parse(init.body)).toMatchObject({ chat_id: 5, text: 'hi' })
        expect(JSON.parse(init.body).parse_mode).toBeUndefined()
        return { status: 200, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 5, type: 'private' } } }) }
      }
      return { status: 403, json: async () => ({ ok: false, error_code: 403, description: `Forbidden: bot was blocked by the user ${TOKEN}` }) }
    }) as any
    const tg = new TelegramClient(TOKEN)
    await expect(tg.sendMessage(5, 'hi')).resolves.toMatchObject({ message_id: 1 })
    const e: any = await tg.sendMessage(5, 'again').catch((x) => x)
    expect(e.code).toBe(403)
    expect(e.message).toContain('blocked')
    expect(e.message).not.toContain('AAFake')
    expect(calls[0]).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
  }, 10000)
})
