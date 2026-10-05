import * as fs from 'fs'
import * as path from 'path'
import { AccountInfo, PublicKey } from '@solana/web3.js'
import { GovernanceAccountParser, Realm } from '@solana/spl-governance'

/** Error whose message is safe and meant to be shown to the Telegram user. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserInputError'
  }
}

export interface RegistryEntry {
  symbol: string
  displayName?: string
  programId: string
  realmId: string
}

export interface RealmRegistry {
  bySymbol: Map<string, RegistryEntry>
  byRealmId: Map<string, RegistryEntry>
}

export const REGISTRY_FILE = path.resolve(
  __dirname,
  '../../public/realms/mainnet-beta.json',
)

export function buildRegistry(entries: RegistryEntry[]): RealmRegistry {
  const bySymbol = new Map<string, RegistryEntry>()
  const byRealmId = new Map<string, RegistryEntry>()
  for (const e of entries) {
    if (!e || typeof e.symbol !== 'string' || !e.realmId || !e.programId) continue
    bySymbol.set(normalizeSymbol(e.symbol), e)
    byRealmId.set(e.realmId, e)
  }
  return { bySymbol, byRealmId }
}

export function loadRegistry(file = REGISTRY_FILE): RealmRegistry {
  return buildRegistry(JSON.parse(fs.readFileSync(file, 'utf8')))
}

export function normalizeSymbol(s: string) {
  return s.trim().replace(/\s+/g, ' ').toUpperCase()
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
// Registry symbols contain letters, digits, spaces and a few punctuation chars ($ & ' . - ( )).
const SYMBOL_RE = /^[A-Za-z0-9$&'.()_\- ]{1,48}$/

export type RealmInput =
  | { kind: 'pubkey'; pubkey: string }
  | { kind: 'symbol'; symbol: string }

/** Strict validation of the user-supplied `<realm>` argument. Throws a user-facing Error. */
export function classifyRealmInput(raw: string | undefined): RealmInput {
  const s = (raw ?? '').trim()
  if (!s) throw new UserInputError('Missing realm. Usage: /watch <realm pubkey or symbol, e.g. MNDE>')
  if (s.length > 64) throw new UserInputError('Realm argument is too long (max 64 characters).')
  // No registry symbol is a single 32+ char alphanumeric word, so such input must be an address.
  if (/^[A-Za-z0-9]{32,}$/.test(s)) {
    if (!BASE58_RE.test(s)) {
      throw new UserInputError(
        /[0OIl]/.test(s)
          ? 'Invalid public key: contains characters that are not base58 (0, O, I, l).'
          : 'Invalid public key: must be 32-44 base58 characters.',
      )
    }
    let pk: PublicKey | undefined
    try {
      pk = new PublicKey(s)
    } catch {
      pk = undefined
    }
    if (!pk || pk.toBase58() !== s) {
      throw new UserInputError('Invalid public key: not a 32-byte base58 address.')
    }
    return { kind: 'pubkey', pubkey: s }
  }
  if (!SYMBOL_RE.test(s)) {
    throw new UserInputError(
      'Invalid realm: use a base58 realm address or a known realm symbol (letters, digits, spaces).',
    )
  }
  return { kind: 'symbol', symbol: s }
}

export interface ResolvedRealm {
  realmPk: string
  programId: string
  symbol?: string
  name?: string
}

/** Resolve against the registry only (no RPC). Throws a user-facing Error for unknown symbols. */
export function resolveFromRegistry(
  input: RealmInput,
  registry: RealmRegistry,
): { realmPk: string; entry?: RegistryEntry } {
  if (input.kind === 'symbol') {
    const entry = registry.bySymbol.get(normalizeSymbol(input.symbol))
    if (!entry) {
      throw new UserInputError(
        `Unknown realm symbol "${input.symbol.slice(0, 48)}". Use the realm's public key instead.`,
      )
    }
    return { realmPk: entry.realmId, entry }
  }
  return { realmPk: input.pubkey, entry: registry.byRealmId.get(input.pubkey) }
}

const REALM_ACCOUNT_TYPES = new Set([1, 16]) // RealmV1, RealmV2

export interface AccountFetcher {
  getAccountInfo(pk: PublicKey): Promise<AccountInfo<Buffer> | null>
}

/**
 * Full resolution: registry lookup + on-chain verification. The realm's governance
 * program id is the account owner (works for custom instances such as Marinade's
 * GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs).
 */
export async function resolveRealm(
  raw: string | undefined,
  registry: RealmRegistry,
  conn: AccountFetcher,
): Promise<ResolvedRealm> {
  const input = classifyRealmInput(raw)
  const { realmPk, entry } = resolveFromRegistry(input, registry)
  const info = await conn.getAccountInfo(new PublicKey(realmPk))
  if (!info) throw new UserInputError(`Account ${realmPk} does not exist on mainnet.`)
  const owner = info.owner.toBase58()
  if (!info.data || info.data.length < 1 || !REALM_ACCOUNT_TYPES.has(info.data[0])) {
    throw new UserInputError(`Account ${realmPk} is not an SPL Governance realm.`)
  }
  if (entry && entry.programId !== owner) {
    throw new UserInputError(
      `Realm ${realmPk} is owned by ${owner}, but the registry says ${entry.programId}. Refusing.`,
    )
  }
  let name = entry?.displayName
  try {
    const parsed = GovernanceAccountParser(Realm)(new PublicKey(realmPk), info)
    if (parsed?.account?.name) name = parsed.account.name
  } catch {
    /* newer/unknown layout: keep registry name */
  }
  return { realmPk, programId: owner, symbol: entry?.symbol, name }
}
