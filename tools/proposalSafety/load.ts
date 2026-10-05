/**
 * Builds a ProposalSafetyInput from chain. All RPC lives here; analyze.ts stays pure.
 *
 * Notes
 * - Governance program id is taken from the proposal account owner (custom deployments such as
 *   Marinade's GovMaiH… work) unless opts.programId is given.
 * - Governance accounts are loaded with raw getProgramAccounts + memcmp + GovernanceAccountParser
 *   because getGovernanceAccounts(..., Governance) throws "account is not supported" on some realms.
 * - Realm-level context (governances, treasury balances, known payees) is cached per realm for
 *   10 minutes so several proposals of the same DAO reuse it.
 *
 * Unaudited, evaluation-grade.
 */
import {
  AccountInfo,
  Connection,
  GetProgramAccountsFilter,
  PublicKey,
} from '@solana/web3.js'
import {
  Governance,
  GovernanceAccountParser,
  GovernanceAccountType,
  GoverningTokenType,
  Proposal,
  ProposalState,
  ProposalTransaction,
  Realm,
  RealmConfigAccount,
  VoteThreshold,
  VoteThresholdType,
  VoteTipping,
  getNativeTreasuryAddress,
  getProposalTransactionAddress,
  getRealmConfigAddress,
} from '@solana/spl-governance'
import {
  AccountInfoInput,
  BufferInfoInput,
  GovernanceConfigInput,
  GovernanceInput,
  InstructionInput,
  KnownPayeeInput,
  ProgramInfoInput,
  ProposalSafetyInput,
  TokenAccountInput,
  VoteThresholdInput,
  VsrVotingMintInput,
} from './types'
import {
  BPF_UPGRADEABLE_LOADER,
  GOVERNANCE_PROGRAMS,
  KNOWN_MINT_SYMBOLS,
  PROGRAM_NAMES,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VSR_PROGRAMS,
} from './constants'
import { decodeInstruction } from './decode'

export interface LoadOptions {
  programId?: PublicKey
  /** fetch description when descriptionLink is a URL (5 s timeout). default true */
  fetchDescription?: boolean
  /** derive known payees from executed proposals. default true */
  includeKnownPayees?: boolean
  /** reuse a realm context (e.g. from a snapshot) */
  realmContext?: RealmSafetyContext
  log?: (msg: string) => void
}

export interface RealmSafetyContext {
  loadedAt: string
  programId: string
  realm: ProposalSafetyInput['realm']
  realmConfig: ProposalSafetyInput['realmConfig']
  governances: GovernanceInput[]
  tokenAccounts: TokenAccountInput[]
  mints: ProposalSafetyInput['mints']
  knownPayees: KnownPayeeInput[]
  /** DAO-governed programs + voter-weight plugins */
  programs: Record<string, ProgramInfoInput>
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function withRetry<T>(fn: () => Promise<T>, what = 'rpc', tries = 9): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const msg = String((e as Error)?.message ?? e)
      const retryable = /429|Too many|rate|timed? ?out|fetch failed|ECONNRESET|503|502|socket/i.test(msg)
      if (!retryable) throw e
      await sleep(Math.min(15000, 500 * Math.pow(2, i)) + Math.floor(Math.random() * 200))
    }
  }
  throw new Error(`${what} failed after ${tries} tries: ${String((lastErr as Error)?.message ?? lastErr)}`)
}

/** base58 of a single byte (< 58) — used for account-type memcmp filters */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const typeFilter = (t: number): GetProgramAccountsFilter => ({ memcmp: { offset: 0, bytes: B58[t] } })
const keyFilter = (offset: number, k: PublicKey | string): GetProgramAccountsFilter => ({
  memcmp: { offset, bytes: typeof k === 'string' ? k : k.toBase58() },
})

async function getMultiple(
  connection: Connection,
  keys: PublicKey[],
  dataSlice?: { offset: number; length: number },
): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = []
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100)
    const res = await withRetry(
      () =>
        connection.getMultipleAccountsInfo(
          chunk,
          dataSlice ? ({ commitment: 'confirmed', dataSlice } as any) : 'confirmed',
        ),
      'getMultipleAccountsInfo',
    )
    out.push(...res)
  }
  return out
}

const pk = (s: string) => new PublicKey(s)
const b58 = (k: PublicKey | undefined | null) => (k ? k.toBase58() : null)
const bnNum = (b: any): number | null => (b === null || b === undefined ? null : Number(b.toString()))

function thresholdIn(t: VoteThreshold | undefined): VoteThresholdInput {
  if (!t) return { type: 'Disabled' }
  const type =
    t.type === VoteThresholdType.YesVotePercentage
      ? 'YesVotePercentage'
      : t.type === VoteThresholdType.QuorumPercentage
      ? 'QuorumPercentage'
      : 'Disabled'
  return type === 'Disabled' ? { type } : { type, value: t.value }
}

function governanceConfigIn(c: Governance['config']): GovernanceConfigInput {
  return {
    communityVoteThreshold: thresholdIn(c.communityVoteThreshold),
    minCommunityTokensToCreateProposal: c.minCommunityTokensToCreateProposal.toString(),
    minInstructionHoldUpTime: c.minInstructionHoldUpTime,
    baseVotingTime: c.baseVotingTime,
    communityVoteTipping: VoteTipping[c.communityVoteTipping] ?? String(c.communityVoteTipping),
    councilVoteThreshold: thresholdIn(c.councilVoteThreshold),
    councilVetoVoteThreshold: thresholdIn(c.councilVetoVoteThreshold),
    minCouncilTokensToCreateProposal: c.minCouncilTokensToCreateProposal.toString(),
    councilVoteTipping:
      c.councilVoteTipping !== undefined ? VoteTipping[c.councilVoteTipping] ?? String(c.councilVoteTipping) : undefined,
    communityVetoVoteThreshold: c.communityVetoVoteThreshold ? thresholdIn(c.communityVetoVoteThreshold) : undefined,
    votingCoolOffTime: c.votingCoolOffTime,
    depositExemptProposalCount: c.depositExemptProposalCount,
  }
}

function programDataAddress(program: string): string {
  return PublicKey.findProgramAddressSync([pk(program).toBuffer()], pk(BPF_UPGRADEABLE_LOADER))[0].toBase58()
}

/** UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> } (bincode) */
function parseProgramDataAuthority(data: Buffer): string | null | undefined {
  if (data.length < 13 || data.readUInt32LE(0) !== 3) return undefined
  return data[12] === 1 && data.length >= 45 ? new PublicKey(data.subarray(13, 45)).toBase58() : null
}

// ---------------------------------------------------------------------------
// Realm context
// ---------------------------------------------------------------------------
const GOVERNANCE_TYPES = [
  GovernanceAccountType.GovernanceV2,
  GovernanceAccountType.ProgramGovernanceV2,
  GovernanceAccountType.MintGovernanceV2,
  GovernanceAccountType.TokenGovernanceV2,
  GovernanceAccountType.GovernanceV1,
  GovernanceAccountType.ProgramGovernanceV1,
  GovernanceAccountType.MintGovernanceV1,
  GovernanceAccountType.TokenGovernanceV1,
]
const EXECUTED_STATES = new Set([
  ProposalState.Completed,
  ProposalState.Executing,
  ProposalState.ExecutingWithErrors,
  ProposalState.Succeeded,
])

const realmCache = new Map<string, { at: number; ctx: Promise<RealmSafetyContext> }>()
const REALM_TTL_MS = 10 * 60 * 1000

export function loadRealmSafetyContextCached(
  connection: Connection,
  programId: PublicKey,
  realmPk: PublicKey,
  opts: LoadOptions = {},
): Promise<RealmSafetyContext> {
  const key = `${connection.rpcEndpoint}|${programId.toBase58()}|${realmPk.toBase58()}|${opts.includeKnownPayees !== false}`
  const hit = realmCache.get(key)
  if (hit && Date.now() - hit.at < REALM_TTL_MS) return hit.ctx
  const ctx = loadRealmSafetyContext(connection, programId, realmPk, opts)
  realmCache.set(key, { at: Date.now(), ctx })
  ctx.catch(() => realmCache.delete(key))
  return ctx
}

export async function loadRealmSafetyContext(
  connection: Connection,
  programId: PublicKey,
  realmPk: PublicKey,
  opts: LoadOptions = {},
): Promise<RealmSafetyContext> {
  const log = opts.log ?? (() => undefined)
  const realmInfo = await withRetry(() => connection.getAccountInfo(realmPk), 'realm')
  if (!realmInfo) throw new Error(`realm ${realmPk.toBase58()} not found`)
  const realm = GovernanceAccountParser(Realm)(realmPk, realmInfo).account

  const rcAddr = await getRealmConfigAddress(programId, realmPk)
  const rcInfo = await withRetry(() => connection.getAccountInfo(rcAddr), 'realmConfig')
  const rc = rcInfo ? GovernanceAccountParser(RealmConfigAccount)(rcAddr, rcInfo).account : undefined

  log('loading governances')
  const govs: { pubkey: PublicKey; account: Governance }[] = []
  for (const t of GOVERNANCE_TYPES) {
    const res = await withRetry(
      () => connection.getProgramAccounts(programId, { commitment: 'confirmed', filters: [typeFilter(t), keyFilter(1, realmPk)] }),
      'getProgramAccounts(governance)',
    )
    for (const a of res) govs.push({ pubkey: a.pubkey, account: GovernanceAccountParser(Governance)(a.pubkey, a.account).account })
  }
  govs.sort((a, b) => a.pubkey.toBase58().localeCompare(b.pubkey.toBase58()))

  const treasuries = await Promise.all(govs.map((g) => getNativeTreasuryAddress(programId, g.pubkey)))
  const treasuryInfos = await getMultiple(connection, treasuries, { offset: 0, length: 0 })
  const governances: GovernanceInput[] = govs.map((g, i) => ({
    pubkey: g.pubkey.toBase58(),
    accountType: GovernanceAccountType[g.account.accountType] ?? String(g.account.accountType),
    governedAccount: g.account.governedAccount.toBase58(),
    nativeTreasury: treasuries[i].toBase58(),
    nativeTreasuryLamports: String(treasuryInfos[i]?.lamports ?? 0),
    config: governanceConfigIn(g.account.config),
  }))

  log('loading treasury token accounts')
  const tokenAccounts: TokenAccountInput[] = []
  const mints: ProposalSafetyInput['mints'] = {}
  const owners = [...govs.map((g) => g.pubkey), ...treasuries]
  for (const owner of owners) {
    // raw (not jsonParsed): the public RPC rate-limits getParsedTokenAccountsByOwner much harder
    const res = await withRetry(
      () => connection.getTokenAccountsByOwner(owner, { programId: pk(TOKEN_PROGRAM) }, 'confirmed'),
      'getTokenAccountsByOwner',
    )
    for (const a of res.value) {
      const d = a.account.data
      if (d.length < 72) continue
      const mint = new PublicKey(d.subarray(0, 32)).toBase58()
      tokenAccounts.push({
        address: a.pubkey.toBase58(),
        owner: new PublicKey(d.subarray(32, 64)).toBase58(),
        mint,
        amount: d.readBigUInt64LE(64).toString(),
        decimals: 0,
        symbol: KNOWN_MINT_SYMBOLS[mint],
      })
    }
    await sleep(600)
  }
  const mintList = Array.from(new Set(tokenAccounts.map((t) => t.mint)))
  const mintInfos = await getMultiple(connection, mintList.map(pk), { offset: 0, length: 82 })
  mintList.forEach((m, i) => {
    const info = mintInfos[i]
    if (info && info.data.length >= 45) mints[m] = { decimals: info.data[44], symbol: KNOWN_MINT_SYMBOLS[m] }
  })
  for (const t of tokenAccounts) t.decimals = mints[t.mint]?.decimals ?? 0
  tokenAccounts.sort((x, y) => x.address.localeCompare(y.address))

  // Programs controlled by the DAO + voter weight plugins
  const realmConfig: ProposalSafetyInput['realmConfig'] = {
    pubkey: rcAddr.toBase58(),
    communityVoterWeightAddin: b58(rc?.communityTokenConfig.voterWeightAddin),
    communityMaxVoterWeightAddin: b58(rc?.communityTokenConfig.maxVoterWeightAddin),
    councilVoterWeightAddin: b58(rc?.councilTokenConfig.voterWeightAddin),
    councilMaxVoterWeightAddin: b58(rc?.councilTokenConfig.maxVoterWeightAddin),
    communityTokenType: rc ? GoverningTokenType[rc.communityTokenConfig.tokenType] : undefined,
    councilTokenType: rc ? GoverningTokenType[rc.councilTokenConfig.tokenType] : undefined,
  }
  const progIds = new Set<string>()
  for (const g of governances) if (/^ProgramGovernance/.test(g.accountType)) progIds.add(g.governedAccount)
  for (const a of [
    realmConfig.communityVoterWeightAddin,
    realmConfig.communityMaxVoterWeightAddin,
    realmConfig.councilVoterWeightAddin,
    realmConfig.councilMaxVoterWeightAddin,
  ])
    if (a) progIds.add(a)
  progIds.add(programId.toBase58())
  const programs = await loadPrograms(connection, [...progIds], governances)

  let knownPayees: KnownPayeeInput[] = []
  if (opts.includeKnownPayees !== false) {
    log('deriving known payees from executed proposals')
    knownPayees = await loadKnownPayees(connection, programId, govs.map((g) => g.pubkey), log)
  }

  return {
    loadedAt: new Date().toISOString(),
    programId: programId.toBase58(),
    realm: {
      pubkey: realmPk.toBase58(),
      name: realm.name,
      programId: programId.toBase58(),
      communityMint: realm.communityMint.toBase58(),
      councilMint: b58(realm.config.councilMint),
      authority: b58(realm.authority),
      minCommunityTokensToCreateGovernance: realm.config.minCommunityTokensToCreateGovernance.toString(),
      communityMintMaxVoteWeightSource: {
        type: realm.config.communityMintMaxVoteWeightSource.type === 0 ? 'SupplyFraction' : 'Absolute',
        value: realm.config.communityMintMaxVoteWeightSource.value.toString(),
      },
    },
    realmConfig,
    governances,
    tokenAccounts,
    mints,
    knownPayees,
    programs,
  }
}

async function loadPrograms(
  connection: Connection,
  ids: string[],
  governances: GovernanceInput[],
): Promise<Record<string, ProgramInfoInput>> {
  const out: Record<string, ProgramInfoInput> = {}
  const pds = ids.map(programDataAddress)
  const infos = await getMultiple(connection, pds.map(pk), { offset: 0, length: 45 })
  ids.forEach((id, i) => {
    const info = infos[i]
    const auth = info ? parseProgramDataAuthority(info.data) : undefined
    const gov = governances.find((g) => /^ProgramGovernance/.test(g.accountType) && g.governedAccount === id)
    const daoAuth = auth ? governances.find((g) => g.pubkey === auth || g.nativeTreasury === auth) : undefined
    out[id] = {
      programData: info ? pds[i] : undefined,
      upgradeAuthority: auth === undefined ? null : auth,
      governedBy: gov?.pubkey ?? daoAuth?.pubkey,
      name: PROGRAM_NAMES[id],
    }
  })
  return out
}

/** Destinations paid by executed transactions of this DAO's past proposals. */
async function loadKnownPayees(
  connection: Connection,
  programId: PublicKey,
  governances: PublicKey[],
  log: (m: string) => void,
): Promise<KnownPayeeInput[]> {
  const txAddrs: { addr: PublicKey; proposal: string }[] = []
  for (const g of governances) {
    for (const t of [GovernanceAccountType.ProposalV2, GovernanceAccountType.ProposalV1]) {
      const res = await withRetry(
        () => connection.getProgramAccounts(programId, { commitment: 'confirmed', filters: [typeFilter(t), keyFilter(1, g)] }),
        'getProgramAccounts(proposals)',
      )
      for (const a of res) {
        let p: Proposal
        try {
          p = GovernanceAccountParser(Proposal)(a.pubkey, a.account).account
        } catch {
          continue
        }
        if (!EXECUTED_STATES.has(p.state)) continue
        const version = t === GovernanceAccountType.ProposalV1 ? 1 : 2
        const counts = version === 1 ? [p.instructionsCount ?? 0] : p.options.map((o) => o.instructionsCount ?? 0)
        for (let oi = 0; oi < counts.length; oi++)
          for (let ti = 0; ti < counts[oi]; ti++)
            txAddrs.push({ addr: await getProposalTransactionAddress(programId, version, a.pubkey, oi, ti), proposal: a.pubkey.toBase58() })
      }
      await sleep(150)
    }
  }
  log(`known payees: ${txAddrs.length} transactions to inspect`)
  const infos = await getMultiple(connection, txAddrs.map((t) => t.addr))
  const payees: KnownPayeeInput[] = []
  const ctx = { governanceProgramIds: new Set([programId.toBase58(), ...Object.keys(GOVERNANCE_PROGRAMS)]), vsrProgramIds: new Set(Object.keys(VSR_PROGRAMS)) }
  infos.forEach((info, i) => {
    if (!info) return
    let tx: ProposalTransaction
    try {
      tx = GovernanceAccountParser(ProposalTransaction)(txAddrs[i].addr, info).account
    } catch {
      return
    }
    const executedAt = bnNum(tx.executedAt)
    if (!executedAt) return
    for (const ix of tx.getAllInstructions()) {
      const d = decodeInstruction(
        ix.programId.toBase58(),
        ix.accounts.map((a) => ({ pubkey: a.pubkey.toBase58(), isSigner: a.isSigner, isWritable: a.isWritable })),
        Buffer.from(ix.data),
        ctx,
      )
      const dest =
        d.type === 'token-transfer' || d.type === 'token-mint-to'
          ? d.destination
          : d.type === 'sol-transfer'
          ? d.to
          : d.type === 'token-approve'
          ? d.delegate
          : null
      if (dest) payees.push({ address: dest, proposal: txAddrs[i].proposal, executedAt, mint: d.type === 'token-transfer' ? d.mint : undefined })
    }
  })
  // owners of token-account destinations
  const uniq = Array.from(new Set(payees.map((p) => p.address)))
  const owners = await getMultiple(connection, uniq.map(pk), { offset: 0, length: 64 })
  const ownerOf = new Map<string, { owner: string; mint: string }>()
  uniq.forEach((a, i) => {
    const info = owners[i]
    if (!info) return
    const prog = info.owner.toBase58()
    if ((prog === TOKEN_PROGRAM || prog === TOKEN_2022_PROGRAM) && info.data.length >= 64)
      ownerOf.set(a, { mint: new PublicKey(info.data.subarray(0, 32)).toBase58(), owner: new PublicKey(info.data.subarray(32, 64)).toBase58() })
  })
  for (const p of payees) {
    const o = ownerOf.get(p.address)
    if (o) {
      p.owner = o.owner
      p.mint = p.mint ?? o.mint
    }
  }
  payees.sort((a, b) => (a.executedAt ?? 0) - (b.executedAt ?? 0) || a.address.localeCompare(b.address))
  return payees
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------
async function fetchWithTimeout(url: string, ms: number): Promise<string | undefined> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
  const timer = setTimeout(() => ctl?.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl?.signal })
    if (!r.ok) return undefined
    const text = await r.text()
    return text.slice(0, 50_000)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveDescription(
  link: string,
  fetchIt = true,
): Promise<{ text: string; unresolved: boolean }> {
  const trimmed = (link ?? '').trim()
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return { text: trimmed, unresolved: false }
  if (!fetchIt) return { text: trimmed, unresolved: true }
  let url = trimmed
  try {
    const u = new URL(trimmed)
    if (u.hostname === 'gist.github.com') {
      // https://gist.github.com/<user>/<id> -> GitHub API returns file contents as JSON
      const id = u.pathname.split('/').filter(Boolean).pop()
      if (id) {
        const json = await fetchWithTimeout(`https://api.github.com/gists/${id}`, 5000)
        if (json) {
          try {
            const files = JSON.parse(json).files ?? {}
            const first: any = Object.values(files)[0]
            if (first?.content) return { text: String(first.content).slice(0, 50_000), unresolved: false }
          } catch {
            /* fall through */
          }
        }
        return { text: trimmed, unresolved: true }
      }
    }
    url = u.toString()
  } catch {
    return { text: trimmed, unresolved: true }
  }
  const text = await fetchWithTimeout(url, 5000)
  return text ? { text, unresolved: false } : { text: trimmed, unresolved: true }
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------
const TX_TYPES = [GovernanceAccountType.ProposalTransactionV2, GovernanceAccountType.ProposalInstructionV1]

export async function loadProposalSafetyInput(
  connection: Connection,
  proposalPk: PublicKey,
  opts: LoadOptions = {},
): Promise<ProposalSafetyInput> {
  const log = opts.log ?? (() => undefined)
  const pInfo = await withRetry(() => connection.getAccountInfo(proposalPk), 'proposal')
  if (!pInfo) throw new Error(`proposal ${proposalPk.toBase58()} not found`)
  const programId = opts.programId ?? pInfo.owner
  const proposal = GovernanceAccountParser(Proposal)(proposalPk, pInfo).account

  const gInfo = await withRetry(() => connection.getAccountInfo(proposal.governance), 'governance')
  if (!gInfo) throw new Error('governance not found')
  const governance = GovernanceAccountParser(Governance)(proposal.governance, gInfo).account

  const ctx =
    opts.realmContext ?? (await loadRealmSafetyContextCached(connection, programId, governance.realm, opts))

  // Transactions
  log('loading proposal transactions')
  const txAccts: { pubkey: PublicKey; tx: ProposalTransaction }[] = []
  for (const t of TX_TYPES) {
    const res = await withRetry(
      () => connection.getProgramAccounts(programId, { commitment: 'confirmed', filters: [typeFilter(t), keyFilter(1, proposalPk)] }),
      'getProgramAccounts(transactions)',
    )
    for (const a of res) txAccts.push({ pubkey: a.pubkey, tx: GovernanceAccountParser(ProposalTransaction)(a.pubkey, a.account).account })
  }
  txAccts.sort((a, b) => a.tx.optionIndex - b.tx.optionIndex || a.tx.instructionIndex - b.tx.instructionIndex)
  const instructions: InstructionInput[] = []
  for (const { tx } of txAccts) {
    tx.getAllInstructions().forEach((ix, j) => {
      instructions.push({
        index: instructions.length,
        txIndex: tx.instructionIndex,
        ixIndexInTx: j,
        optionIndex: tx.optionIndex,
        holdUpTime: tx.holdUpTime,
        executedAt: bnNum(tx.executedAt) || null,
        programId: ix.programId.toBase58(),
        accounts: ix.accounts.map((a) => ({ pubkey: a.pubkey.toBase58(), isSigner: a.isSigner, isWritable: a.isWritable })),
        dataBase64: Buffer.from(ix.data).toString('base64'),
      })
    })
  }

  // Referenced accounts
  log('loading referenced accounts')
  const refs = Array.from(new Set(instructions.flatMap((i) => [i.programId, ...i.accounts.map((a) => a.pubkey)])))
  const infos = await getMultiple(connection, refs.map(pk), { offset: 0, length: 165 })
  const accounts: Record<string, AccountInfoInput> = {}
  const mints: ProposalSafetyInput['mints'] = { ...ctx.mints }
  const needMintDecimals = new Set<string>()
  const buffers: Record<string, BufferInfoInput> = {}
  const programIdsSeen = new Set<string>()
  refs.forEach((addr, i) => {
    const info = infos[i]
    if (!info) {
      accounts[addr] = { kind: 'missing' }
      return
    }
    const owner = info.owner.toBase58()
    const d = info.data
    const base: AccountInfoInput = { kind: 'other', programOwner: owner, lamports: String(info.lamports) }
    if (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) {
      if (d.length >= 165) {
        const mint = new PublicKey(d.subarray(0, 32)).toBase58()
        accounts[addr] = { ...base, kind: 'token', mint, owner: new PublicKey(d.subarray(32, 64)).toBase58(), amount: d.readBigUInt64LE(64).toString() }
        if (!mints[mint]) needMintDecimals.add(mint)
      } else if (d.length >= 82) {
        accounts[addr] = { ...base, kind: 'mint', decimals: d[44] }
        mints[addr] = { decimals: d[44], symbol: KNOWN_MINT_SYMBOLS[addr] }
      } else accounts[addr] = base
    } else if (owner === BPF_UPGRADEABLE_LOADER && d.length >= 4) {
      const tag = d.readUInt32LE(0)
      if (tag === 1) {
        accounts[addr] = { ...base, kind: 'buffer', owner: d[4] === 1 && d.length >= 37 ? new PublicKey(d.subarray(5, 37)).toBase58() : null }
      } else if (tag === 2) {
        accounts[addr] = { ...base, kind: 'program' }
        programIdsSeen.add(addr)
      } else if (tag === 3) {
        accounts[addr] = { ...base, kind: 'programdata', owner: parseProgramDataAuthority(d) ?? null }
      } else accounts[addr] = base
    } else if (info.executable) {
      accounts[addr] = { ...base, kind: 'program' }
    } else if (owner === SYSTEM_PROGRAM) {
      accounts[addr] = { ...base, kind: 'wallet' }
    } else accounts[addr] = base
  })
  if (needMintDecimals.size) {
    const ml = Array.from(needMintDecimals)
    const mi = await getMultiple(connection, ml.map(pk), { offset: 0, length: 82 })
    ml.forEach((m, i) => {
      const info = mi[i]
      if (info && info.data.length >= 45) mints[m] = { decimals: info.data[44], symbol: KNOWN_MINT_SYMBOLS[m] }
    })
  }
  for (const a of Object.values(accounts)) if (a.kind === 'token' && a.mint && mints[a.mint]) a.decimals = mints[a.mint].decimals

  // Upgrade buffers (full size) + programs touched by loader instructions
  const decodeCtx = {
    governanceProgramIds: new Set([programId.toBase58(), ...Object.keys(GOVERNANCE_PROGRAMS)]),
    vsrProgramIds: new Set([...Object.keys(VSR_PROGRAMS)]),
  }
  const registrars = new Set<string>()
  for (const ix of instructions) {
    const d = decodeInstruction(ix.programId, ix.accounts, Buffer.from(ix.dataBase64, 'base64'), decodeCtx)
    if (d.type === 'bpf-upgrade') {
      programIdsSeen.add(d.program)
      if (!buffers[d.buffer]) {
        const bi = await withRetry(() => connection.getAccountInfo(pk(d.buffer)), 'buffer')
        buffers[d.buffer] =
          bi && bi.owner.toBase58() === BPF_UPGRADEABLE_LOADER && bi.data.length >= 37 && bi.data.readUInt32LE(0) === 1
            ? { exists: true, authority: bi.data[4] === 1 ? new PublicKey(bi.data.subarray(5, 37)).toBase58() : null, dataLen: bi.data.length - 37 }
            : { exists: false, authority: null, dataLen: 0 }
      }
    }
    if (d.type === 'vsr-configure-voting-mint') registrars.add(d.registrar)
    programIdsSeen.add(ix.programId)
  }
  const toLoad = Array.from(programIdsSeen).filter(
    (p) => !ctx.programs[p] && accounts[p]?.programOwner === BPF_UPGRADEABLE_LOADER,
  )
  const programs = {
    ...ctx.programs,
    ...(toLoad.length ? await loadPrograms(connection, toLoad, ctx.governances) : {}),
  }

  // VSR registrars (Registrar account: 8 disc, 5 x 32 header, 4 x VotingMintConfig of 152 bytes)
  const vsrRegistrars: NonNullable<ProposalSafetyInput['vsrRegistrars']> = {}
  for (const r of Array.from(registrars)) {
    const ri = await withRetry(() => connection.getAccountInfo(pk(r)), 'registrar')
    if (!ri || ri.data.length < 168 + 152 * 4) continue
    const votingMints: VsrVotingMintInput[] = []
    for (let i = 0; i < 4; i++) {
      const o = 168 + i * 152
      const d = ri.data
      votingMints.push({
        mint: new PublicKey(d.subarray(o, o + 32)).toBase58(),
        grantAuthority: new PublicKey(d.subarray(o + 32, o + 64)).toBase58(),
        baselineVoteWeightScaledFactor: d.readBigUInt64LE(o + 64).toString(),
        maxExtraLockupVoteWeightScaledFactor: d.readBigUInt64LE(o + 72).toString(),
        lockupSaturationSecs: d.readBigUInt64LE(o + 80).toString(),
        digitShift: d.readInt8(o + 88),
      })
    }
    vsrRegistrars[r] = { votingMints }
  }

  const desc = await resolveDescription(proposal.descriptionLink, opts.fetchDescription !== false)
  const govInput =
    ctx.governances.find((g) => g.pubkey === proposal.governance.toBase58()) ??
    ({
      pubkey: proposal.governance.toBase58(),
      accountType: GovernanceAccountType[governance.accountType],
      governedAccount: governance.governedAccount.toBase58(),
      nativeTreasury: (await getNativeTreasuryAddress(programId, proposal.governance)).toBase58(),
      config: governanceConfigIn(governance.config),
    } as GovernanceInput)

  return {
    version: 1,
    snapshotAt: new Date().toISOString(),
    cluster: connection.rpcEndpoint.includes('devnet') ? 'devnet' : 'mainnet-beta',
    proposal: {
      pubkey: proposalPk.toBase58(),
      name: proposal.name,
      descriptionLink: proposal.descriptionLink,
      descriptionText: desc.text,
      descriptionUnresolved: desc.unresolved || undefined,
      state: ProposalState[proposal.state] ?? String(proposal.state),
      governance: proposal.governance.toBase58(),
      tokenOwnerRecord: proposal.tokenOwnerRecord.toBase58(),
      governingTokenMint: proposal.governingTokenMint.toBase58(),
      draftAt: bnNum(proposal.draftAt),
      votingAt: bnNum(proposal.votingAt),
    },
    governance: govInput,
    realm: ctx.realm,
    realmConfig: ctx.realmConfig,
    instructions,
    treasury: { governances: ctx.governances, tokenAccounts: ctx.tokenAccounts },
    mints,
    knownPayees: ctx.knownPayees,
    programs,
    buffers,
    accounts,
    vsrRegistrars: Object.keys(vsrRegistrars).length ? vsrRegistrars : undefined,
  }
}
