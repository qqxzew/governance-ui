import { createHash } from 'crypto'
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js'
import { GovernanceAccountParser, Proposal } from '@solana/spl-governance'

/** spl-governance GovernanceAccountType values (see @solana/spl-governance accounts.d.ts). */
export const AccountType = {
  GovernanceV1: 3,
  ProgramGovernanceV1: 4,
  ProposalV1: 5,
  ProposalInstructionV1: 8,
  MintGovernanceV1: 9,
  TokenGovernanceV1: 10,
  ProposalTransactionV2: 13,
  ProposalV2: 14,
  GovernanceV2: 18,
  ProgramGovernanceV2: 19,
  MintGovernanceV2: 20,
  TokenGovernanceV2: 21,
} as const

export const GOVERNANCE_TYPES = [
  AccountType.GovernanceV2,
  AccountType.ProgramGovernanceV2,
  AccountType.MintGovernanceV2,
  AccountType.TokenGovernanceV2,
  AccountType.GovernanceV1,
  AccountType.ProgramGovernanceV1,
  AccountType.MintGovernanceV1,
  AccountType.TokenGovernanceV1,
]
const PROPOSAL_TYPES = new Set<number>([AccountType.ProposalV1, AccountType.ProposalV2])

/** Proposal V1/V2 prefix: accountType u8 | governance [32] | governingTokenMint [32] | state u8 */
export const PROPOSAL_STATE_OFFSET = 65
const PROPOSAL_SLICE = { offset: 0, length: PROPOSAL_STATE_OFFSET + 1 }

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'))
  let out = ''
  while (n > BigInt(0)) {
    out = B58[Number(n % BigInt(58))] + out
    n = n / BigInt(58)
  }
  return '1'.repeat(zeros) + out
}

/** memcmp at offset 0 matching `accountType` byte followed by a 32-byte key at offset 1. */
export function typeAndKeyFilter(accountType: number, key: PublicKey) {
  const bytes = Buffer.concat([Buffer.from([accountType]), key.toBuffer()])
  return { memcmp: { offset: 0, bytes: encodeBase58(bytes) } }
}

export interface GovernanceRef {
  pk: string
  /** governance account type (V1: 3/4/9/10, V2: 18-21) */
  t: number
}
const V1_GOVERNANCE_TYPES = new Set<number>([3, 4, 9, 10])

/**
 * All governance accounts of a realm. Raw getProgramAccounts with a 33-byte memcmp
 * (type byte + realm) and dataSlice length 0 -> pubkeys only. (spl-governance's
 * getGovernanceAccounts(..., Governance) throws "account is not supported" on Marinade.)
 */
export async function fetchGovernances(
  conn: Connection,
  programId: PublicKey,
  realm: PublicKey,
): Promise<GovernanceRef[]> {
  const out: GovernanceRef[] = []
  // Sequential on purpose: gentle on public RPC rate limits.
  for (const t of GOVERNANCE_TYPES) {
    const accs = await conn.getProgramAccounts(programId, {
      filters: [typeAndKeyFilter(t, realm)],
      dataSlice: { offset: 0, length: 0 },
    })
    for (const a of accs) out.push({ pk: a.pubkey.toBase58(), t })
  }
  return out.sort((a, b) => (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0))
}

export interface ProposalSlice {
  pk: string
  governance: string
  accountType: number
  state: number
}

function toSlice(pubkey: PublicKey, d: Buffer): ProposalSlice | null {
  if (d.length < PROPOSAL_SLICE.length || !PROPOSAL_TYPES.has(d[0])) return null
  return {
    pk: pubkey.toBase58(),
    governance: new PublicKey(d.subarray(1, 33)).toBase58(),
    accountType: d[0],
    state: d[PROPOSAL_STATE_OFFSET],
  }
}

/**
 * Light listing of a realm's proposals: only the first 66 bytes (type, governance,
 * mint, state) of each proposal.
 *  - default: one getProgramAccounts per governance (memcmp type+governance);
 *    V2 governances only hold ProposalV2, V1 governances may hold either.
 *  - programWide: one call for the whole program (memcmp type only), filtered
 *    client-side by governance. Used for dedicated program instances (e.g. Marinade).
 */
export async function fetchProposalSlices(
  conn: Connection,
  programId: PublicKey,
  governances: GovernanceRef[],
  opts: { programWide?: boolean } = {},
): Promise<ProposalSlice[]> {
  const out: ProposalSlice[] = []
  const govSet = new Set(governances.map((g) => g.pk))
  if (opts.programWide) {
    const anyV1 = governances.some((g) => V1_GOVERNANCE_TYPES.has(g.t))
    const types = anyV1
      ? [AccountType.ProposalV2, AccountType.ProposalV1]
      : [AccountType.ProposalV2]
    for (const t of types) {
      const accs = await conn.getProgramAccounts(programId, {
        filters: [{ memcmp: { offset: 0, bytes: encodeBase58(Uint8Array.of(t)) } }],
        dataSlice: PROPOSAL_SLICE,
      })
      for (const a of accs) {
        const s = toSlice(a.pubkey, a.account.data)
        if (s && govSet.has(s.governance)) out.push(s)
      }
    }
    return out
  }
  for (const g of governances) {
    const gpk = new PublicKey(g.pk)
    const types = V1_GOVERNANCE_TYPES.has(g.t)
      ? [AccountType.ProposalV2, AccountType.ProposalV1]
      : [AccountType.ProposalV2]
    for (const t of types) {
      const accs = await conn.getProgramAccounts(programId, {
        filters: [typeAndKeyFilter(t, gpk)],
        dataSlice: PROPOSAL_SLICE,
      })
      for (const a of accs) {
        const s = toSlice(a.pubkey, a.account.data)
        if (s && s.governance === g.pk) out.push(s)
      }
    }
  }
  return out
}

export interface ProposalDetails {
  pk: string
  name: string
  state: number
  accountType: number
  draftAt: number
  /** "count/nextIndex" per option: changes whenever a transaction is inserted */
  countsSig: string
}

export function parseProposal(pk: string, info: AccountInfo<Buffer>): ProposalDetails {
  const p = GovernanceAccountParser(Proposal)(new PublicKey(pk), info).account as Proposal
  const parts =
    p.options && p.options.length
      ? p.options.map((o) => `${o.instructionsCount}/${o.instructionsNextIndex}`)
      : [`${p.instructionsCount}/${p.instructionsNextIndex}`]
  return {
    pk,
    name: p.name,
    state: p.state,
    accountType: info.data[0],
    draftAt: p.draftAt ? Number(p.draftAt.toString()) : 0,
    countsSig: parts.join(','),
  }
}

export async function fetchProposalDetails(
  conn: Connection,
  pks: string[],
  log: (m: string) => void = console.warn,
): Promise<Map<string, ProposalDetails>> {
  const out = new Map<string, ProposalDetails>()
  for (let i = 0; i < pks.length; i += 100) {
    const batch = pks.slice(i, i + 100)
    const infos = await conn.getMultipleAccountsInfo(batch.map((p) => new PublicKey(p)))
    infos.forEach((info, j) => {
      if (!info) return
      try {
        out.set(batch[j], parseProposal(batch[j], info))
      } catch (e: any) {
        log(`[chain] cannot parse proposal ${batch[j]}: ${e?.message ?? e}`)
      }
    })
  }
  return out
}

/**
 * Content signature of a proposal's transactions: option counters + sha256 over all
 * ProposalTransaction accounts (sorted by pubkey). Catches remove+re-insert at the same
 * index, which leaves the counters unchanged.
 */
export async function fetchTransactionsSignature(
  conn: Connection,
  programId: PublicKey,
  proposal: ProposalDetails,
): Promise<string> {
  const txType =
    proposal.accountType === AccountType.ProposalV1
      ? AccountType.ProposalInstructionV1
      : AccountType.ProposalTransactionV2
  const accs = await conn.getProgramAccounts(programId, {
    filters: [typeAndKeyFilter(txType, new PublicKey(proposal.pk))],
  })
  return transactionsSignature(
    proposal.countsSig,
    accs.map((a) => ({ pubkey: a.pubkey.toBase58(), data: a.account.data })),
  )
}

export function transactionsSignature(
  countsSig: string,
  accounts: { pubkey: string; data: Uint8Array }[],
) {
  const h = createHash('sha256')
  for (const a of [...accounts].sort((x, y) => (x.pubkey < y.pubkey ? -1 : 1))) {
    h.update(a.pubkey)
    h.update(Buffer.from(a.data))
  }
  return `${countsSig}#${accounts.length}#${h.digest('hex').slice(0, 16)}`
}
