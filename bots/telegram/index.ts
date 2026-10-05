/**
 * Telegram proposal-notification bot for SPL Governance (Realms) DAOs.
 *
 *   yarn bot                               # run the bot (needs TELEGRAM_BOT_TOKEN)
 *   yarn bot --dry-run --realm MNDE        # poll one realm once, print alerts, no Telegram
 *   yarn bot --once                        # poll all watched realms once, send alerts, exit
 *
 * See bots/telegram/README.md.
 */
import * as path from 'path'
import { Connection } from '@solana/web3.js'
import { handleCommand, parseCommand } from './commands'
import { BotConfig, loadDotEnv, readConfig } from './env'
import { fetchProposalDetails } from './chain'
import { Alert, chainApi, pollRealm, PollDeps } from './poller'
import { loadRegistry, RealmRegistry, resolveRealm } from './realms'
import { redact, redactUrl } from './redact'
import { makeConnection } from './rpc'
import { loadEngine, makeSafetyChecker } from './safety'
import { BotState, loadState, saveState, WatchedRealm } from './state'
import { TelegramClient, TelegramError, TgMessage } from './telegram'

const DEFAULT_SHARED_PROGRAM = 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface CliArgs {
  dryRun: boolean
  once: boolean
  realm?: string
  last: number
  forget: string[]
  help: boolean
}

export function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: false, once: false, last: 5, forget: [], help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--once') out.once = true
    else if (a === '--realm') out.realm = val()
    else if (a === '--last') {
      out.last = Number(val())
      if (!Number.isInteger(out.last) || out.last < 0 || out.last > 1000) {
        throw new Error('--last must be an integer 0..1000')
      }
    } else if (a === '--forget') out.forget.push(...val().split(',').filter(Boolean))
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`Unknown argument: ${a}`)
  }
  return out
}

const USAGE = `Usage:
  yarn bot                         run the Telegram bot (TELEGRAM_BOT_TOKEN required)
  yarn bot --once                  poll all watched realms once, send alerts, exit
  yarn bot --dry-run --realm MNDE [--last 5] [--forget <proposalPk,...>]
                                   poll one realm once and print the alerts it would send
                                   (no Telegram, no token, state.json untouched).
                                   --last N treats the N newest proposals as unseen,
                                   --forget treats the given proposals as unseen.`

function makeLogger(secrets: Array<string | undefined>) {
  return (msg: string) =>
    console.log(`${new Date().toISOString()} ${redact(msg, secrets)}`)
}

function dedicatedPrograms(registry: RealmRegistry) {
  const counts = new Map<string, number>()
  for (const e of registry.byRealmId.values()) {
    counts.set(e.programId, (counts.get(e.programId) ?? 0) + 1)
  }
  return (programId: string) =>
    programId !== DEFAULT_SHARED_PROGRAM && counts.get(programId) === 1
}

function pollDeps(conn: Connection, cfg: BotConfig, registry: RealmRegistry, log: (m: string) => void): PollDeps {
  return {
    chain: chainApi(conn, log),
    safety: makeSafetyChecker(conn, loadEngine(undefined, log)),
    appUrl: cfg.appUrl,
    log,
    isDedicatedProgram: dedicatedPrograms(registry),
  }
}

// ---------------------------------------------------------------- dry run

async function dryRun(args: CliArgs, cfg: BotConfig) {
  const log = makeLogger([cfg.token])
  if (!args.realm) throw new Error('--dry-run needs --realm <pubkey or symbol>')
  const registry = loadRegistry()
  const conn = makeConnection(cfg.rpcUrl, { log })
  log(`[dry-run] RPC ${redactUrl(cfg.rpcUrl)}, APP_URL ${cfg.appUrl}`)
  const resolved = await resolveRealm(args.realm, registry, conn)
  log(`[dry-run] realm ${resolved.name ?? '?'} ${resolved.realmPk} (program ${resolved.programId}, symbol ${resolved.symbol ?? '-'})`)
  const deps = pollDeps(conn, cfg, registry, log)
  const realm: WatchedRealm = {
    ...resolved,
    subscribers: [0],
    baselineDone: false,
    proposals: {},
  }
  const alerts: Alert[] = []
  // 1) baseline poll, exactly like a freshly watched realm
  alerts.push(...(await pollRealm(realm, deps)))
  // 2) pretend the N newest (and --forget) proposals were never seen, poll again
  const all = Object.keys(realm.proposals)
  const details = await fetchProposalDetails(conn, all, log)
  const newest = [...details.values()]
    .sort((a, b) => b.draftAt - a.draftAt)
    .slice(0, args.last)
    .map((d) => d.pk)
  const forget = new Set([...newest, ...args.forget])
  for (const pk of args.forget) {
    if (!realm.proposals[pk]) log(`[dry-run] --forget ${pk}: not a proposal of this realm`)
  }
  for (const pk of forget) delete realm.proposals[pk]
  log(`[dry-run] ${all.length} proposals; treating ${forget.size} as unseen`)
  alerts.push(...(await pollRealm(realm, deps)))

  console.log(`\n===== ${alerts.length} alert(s) that WOULD be sent =====`)
  for (const a of alerts) {
    console.log(`\n----- [${a.type}] ${a.proposalPk} -----`)
    console.log(a.text)
  }
  console.log('\n===== end of dry run =====')
}

// ---------------------------------------------------------------- bot

class Bot {
  private state: BotState
  private readonly stateFile: string
  private readonly inflight = new Set<string>()
  private readonly log: (m: string) => void
  private username?: string
  private stopping = false

  constructor(
    private readonly cfg: BotConfig,
    private readonly tg: TelegramClient,
    private readonly conn: Connection,
    private readonly registry: RealmRegistry,
    private readonly deps: PollDeps,
  ) {
    this.log = deps.log
    this.stateFile = path.join(cfg.dataDir, 'state.json')
    this.state = loadState(this.stateFile)
  }

  save() {
    try {
      saveState(this.stateFile, this.state)
    } catch (e) {
      this.log(`[state] save failed: ${redact(e, [this.cfg.token])}`)
    }
  }

  stop() {
    this.stopping = true
    this.save()
  }

  async start(once: boolean) {
    let me
    for (let attempt = 1; ; attempt++) {
      try {
        me = await this.tg.getMe()
        break
      } catch (e) {
        if ((e instanceof TelegramError && e.code === 401) || attempt >= 10) throw e
        const wait = Math.min(60_000, 2000 * 2 ** attempt)
        this.log(`[tg] getMe failed: ${redact(e, [this.cfg.token])}; retry in ${wait} ms`)
        await sleep(wait)
      }
    }
    this.username = me.username
    this.log(`[bot] @${me.username} up; ${Object.keys(this.state.realms).length} watched realm(s); poll every ${this.cfg.pollSeconds}s; RPC ${redactUrl(this.cfg.rpcUrl)}`)
    if (once) {
      await this.pollAll()
      return
    }
    void this.pollLoop()
    await this.updatesLoop()
  }

  private async updatesLoop() {
    let failures = 0
    while (!this.stopping) {
      try {
        const updates = await this.tg.getUpdates(this.state.telegramOffset, 50)
        failures = 0
        for (const u of updates) {
          this.state.telegramOffset = Math.max(this.state.telegramOffset, u.update_id + 1)
          if (u.message) await this.onMessage(u.message)
        }
        if (updates.length) this.save()
      } catch (e) {
        failures++
        const wait = e instanceof TelegramError && e.retryAfter ? e.retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** failures)
        this.log(`[tg] getUpdates failed: ${redact(e, [this.cfg.token])}; retry in ${wait} ms`)
        if (e instanceof TelegramError && e.code === 401) {
          this.log('[tg] token rejected (401). Check TELEGRAM_BOT_TOKEN.')
          process.exit(1)
        }
        await sleep(wait)
      }
    }
  }

  private async onMessage(msg: TgMessage) {
    if (msg.from?.is_bot) return
    const chatId = msg.chat.id
    const cmd = parseCommand(msg.text, this.username)
    if (!cmd) {
      if (msg.chat.type === 'private' && msg.text && !msg.text.trim().startsWith('/')) await this.reply(chatId, 'Send /help for the list of commands.', msg.message_id)
      return
    }
    if (this.cfg.allowedChats && !this.cfg.allowedChats.has(chatId)) {
      this.log(`[bot] ignoring /${cmd.command} from chat ${chatId} (not in TELEGRAM_ALLOWED_CHATS)`)
      await this.reply(chatId, 'This bot instance is private.', msg.message_id)
      return
    }
    const text = await handleCommand(cmd, {
      state: this.state,
      chatId,
      maxRealms: this.cfg.maxRealms,
      maxWatchesPerChat: this.cfg.maxWatchesPerChat,
      resolve: (raw) => resolveRealm(raw, this.registry, this.conn),
      onWatched: (realmPk) => setTimeout(() => void this.pollOne(realmPk), 0),
      log: this.log,
    })
    this.save()
    if (text) await this.reply(chatId, text, msg.message_id)
  }

  private async reply(chatId: number, text: string, replyTo?: number) {
    try {
      await this.tg.sendMessage(chatId, text, replyTo)
    } catch (e) {
      this.log(`[tg] reply to ${chatId} failed: ${redact(e, [this.cfg.token])}`)
    }
  }

  private async pollLoop() {
    while (!this.stopping) {
      const started = Date.now()
      await this.pollAll()
      const wait = this.cfg.pollSeconds * 1000 - (Date.now() - started)
      await sleep(Math.max(1000, wait))
    }
  }

  private async pollAll() {
    for (const realmPk of Object.keys(this.state.realms)) {
      if (this.stopping) return
      await this.pollOne(realmPk)
    }
  }

  private async pollOne(realmPk: string) {
    const realm = this.state.realms[realmPk]
    if (!realm || realm.subscribers.length === 0 || this.inflight.has(realmPk)) return
    this.inflight.add(realmPk)
    try {
      const alerts = await pollRealm(realm, this.deps)
      this.save()
      for (const a of alerts) await this.deliver(a)
    } catch (e: any) {
      realm.lastError = redact(e?.message ?? e, [this.cfg.token]).slice(0, 300)
      this.log(`[poll] ${realm.symbol ?? realmPk} failed: ${realm.lastError}`)
    } finally {
      this.inflight.delete(realmPk)
    }
  }

  private async deliver(alert: Alert) {
    const subs = [...(this.state.realms[alert.realmPk]?.subscribers ?? [])]
    this.log(`[alert] ${alert.type} ${alert.proposalPk} -> ${subs.length} chat(s)`)
    for (const chatId of subs) {
      try {
        await this.tg.sendMessage(chatId, alert.text)
      } catch (e) {
        this.log(`[tg] send to ${chatId} failed: ${redact(e, [this.cfg.token])}`)
        if (e instanceof TelegramError && (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message)))) {
          this.dropChat(chatId)
        }
      }
      await sleep(60)
    }
  }

  private dropChat(chatId: number) {
    for (const [pk, r] of Object.entries(this.state.realms)) {
      r.subscribers = r.subscribers.filter((c) => c !== chatId)
      if (!r.subscribers.length) delete this.state.realms[pk]
    }
    this.log(`[bot] removed chat ${chatId} (bot blocked / chat gone)`)
    this.save()
  }
}

async function main() {
  loadDotEnv(path.resolve(__dirname, '../../.env'))
  const args = parseCliArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  const cfg = readConfig()
  const log = makeLogger([cfg.token])
  process.on('unhandledRejection', (e) => log(`[fatal] unhandled rejection: ${redact(e, [cfg.token])}`))

  if (args.dryRun) {
    await dryRun(args, cfg)
    return
  }
  if (!cfg.token) {
    console.error('TELEGRAM_BOT_TOKEN is not set (put it in .env or $env:TELEGRAM_BOT_TOKEN). For a token-less test use: yarn bot --dry-run --realm MNDE')
    process.exit(1)
  }
  const registry = loadRegistry()
  const conn = makeConnection(cfg.rpcUrl, { log })
  const tg = new TelegramClient(cfg.token, cfg.telegramApiBase)
  const bot = new Bot(cfg, tg, conn, registry, pollDeps(conn, cfg, registry, log))
  const shutdown = () => {
    log('[bot] shutting down')
    bot.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await bot.start(args.once)
}

if (require.main === module) {
  main().catch((e) => {
    console.error(redact(e, [process.env.TELEGRAM_BOT_TOKEN]))
    process.exit(1)
  })
}

