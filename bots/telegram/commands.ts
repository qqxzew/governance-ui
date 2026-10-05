import {
  classifyRealmInput,
  normalizeSymbol,
  ResolvedRealm,
  UserInputError,
} from './realms'
import { BotState, WatchedRealm } from './state'
import { finalizeMessage, realmLabel } from './text'

export interface ParsedCommand {
  command: string
  args: string
}

const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/

/**
 * Parse `/cmd[@bot] args`. Returns null for non-commands and for commands
 * addressed to a different bot (`/watch@OtherBot` in a group).
 */
export function parseCommand(text: string | undefined, botUsername?: string): ParsedCommand | null {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!t.startsWith('/') || t.length > 512) return null
  const m = COMMAND_RE.exec(t)
  if (!m) return null
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null
  return { command: m[1].toLowerCase(), args: (m[3] ?? '').trim() }
}

export const HELP_TEXT = [
  'Governance proposal alerts for SPL Governance (Realms) DAOs.',
  '',
  'Commands:',
  '/watch <realm> — subscribe; <realm> is a realm address or a known symbol (e.g. MNDE)',
  '/unwatch <realm> — unsubscribe',
  '/list — realms this chat watches',
  '/help — this message',
  '',
  'You get an alert for every new proposal, when voting starts, and a 🔴 Danger alert when the',
  'safety checker reports a red finding. The first check of a realm only records existing',
  'proposals (no flood of old alerts).',
  '',
  'Unaudited, evaluation-grade tool. Always review proposal instructions yourself.',
].join('\n')

export interface CommandContext {
  state: BotState
  chatId: number
  maxRealms: number
  maxWatchesPerChat: number
  /** registry + on-chain resolution (may hit RPC) */
  resolve: (raw: string) => Promise<ResolvedRealm>
  /** called after a realm got its first subscriber (e.g. to trigger the baseline poll) */
  onWatched?: (realmPk: string) => void
  log?: (m: string) => void
}

function chatRealms(state: BotState, chatId: number) {
  return Object.values(state.realms).filter((r) => r.subscribers.includes(chatId))
}

/** Returns the reply text; mutates ctx.state. Never throws for user errors. */
export async function handleCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<string | null> {
  try {
    switch (cmd.command) {
      case 'start':
      case 'help':
        return HELP_TEXT
      case 'watch':
        return finalizeMessage(await watch(cmd.args, ctx))
      case 'unwatch':
        return finalizeMessage(unwatch(cmd.args, ctx))
      case 'list':
        return finalizeMessage(list(ctx))
      default:
        return 'Unknown command. Send /help for the list of commands.'
    }
  } catch (e: any) {
    if (e instanceof UserInputError) return `⚠️ ${e.message}`
    ctx.log?.(`[cmd] /${cmd.command} failed: ${e?.message ?? e}`)
    return '⚠️ Could not complete the request (RPC error). Please try again later.'
  }
}

async function watch(args: string, ctx: CommandContext) {
  if (!args) throw new UserInputError('Usage: /watch <realm address or symbol, e.g. MNDE>')
  classifyRealmInput(args) // fail fast before any RPC
  const mine = chatRealms(ctx.state, ctx.chatId)
  const resolved = await ctx.resolve(args)
  const existing = ctx.state.realms[resolved.realmPk]
  if (existing?.subscribers.includes(ctx.chatId)) {
    return `Already watching ${realmLabel(existing)}.`
  }
  if (mine.length >= ctx.maxWatchesPerChat) {
    throw new UserInputError(`This chat already watches ${mine.length} realms (limit ${ctx.maxWatchesPerChat}).`)
  }
  let realm: WatchedRealm
  if (existing) {
    existing.subscribers.push(ctx.chatId)
    realm = existing
  } else {
    if (Object.keys(ctx.state.realms).length >= ctx.maxRealms) {
      throw new UserInputError('The bot is at its realm limit. Try again later.')
    }
    realm = {
      realmPk: resolved.realmPk,
      programId: resolved.programId,
      symbol: resolved.symbol,
      name: resolved.name,
      subscribers: [ctx.chatId],
      baselineDone: false,
      proposals: {},
    }
    ctx.state.realms[resolved.realmPk] = realm
    ctx.onWatched?.(resolved.realmPk)
  }
  return [
    `✅ Watching ${realmLabel(realm)}`,
    `Realm: ${realm.realmPk}`,
    `Program: ${realm.programId}`,
    '',
    realm.baselineDone
      ? 'Alerts are active.'
      : 'The first check records existing proposals; you will be alerted about new ones from now on (plus 🔴 Danger alerts for active proposals).',
  ].join('\n')
}

function findWatched(args: string, ctx: CommandContext): WatchedRealm | undefined {
  const input = classifyRealmInput(args)
  const mine = chatRealms(ctx.state, ctx.chatId)
  if (input.kind === 'pubkey') return mine.find((r) => r.realmPk === input.pubkey)
  const sym = normalizeSymbol(input.symbol)
  return mine.find((r) => r.symbol && normalizeSymbol(r.symbol) === sym)
}

function unwatch(args: string, ctx: CommandContext) {
  if (!args) throw new UserInputError('Usage: /unwatch <realm address or symbol>')
  const realm = findWatched(args, ctx)
  if (!realm) throw new UserInputError('This chat is not watching that realm. See /list.')
  realm.subscribers = realm.subscribers.filter((c) => c !== ctx.chatId)
  if (realm.subscribers.length === 0) delete ctx.state.realms[realm.realmPk]
  return `Stopped watching ${realmLabel(realm)}.`
}

function list(ctx: CommandContext) {
  const mine = chatRealms(ctx.state, ctx.chatId)
  if (!mine.length) return 'This chat is not watching any realm. Use /watch <realm>, e.g. /watch MNDE'
  return [
    'Watched realms:',
    ...mine.map((r) => {
      const status = !r.baselineDone
        ? 'baseline pending'
        : `${Object.keys(r.proposals).length} proposals known`
      return `• ${realmLabel(r)} — ${r.realmPk} (${status})`
    }),
  ].join('\n')
}
