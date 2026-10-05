/**
 * analyzeProposal — pure, deterministic, rule-based "what this proposal really does".
 * No RPC, no React, no eval. The proposal description is treated as untrusted data:
 * it is only matched with simple linear regexes and quoted (truncated) as plain text.
 *
 * Unaudited, evaluation-grade.
 */
import {
  AnalyzeOptions,
  ConfigChange,
  DecodedAction,
  DescriptionCheck,
  GovernanceConfigInput,
  GovernanceInput,
  InstructionInput,
  MaxSeverity,
  ProposalSafetyInput,
  ProposalSafetyReport,
  SafetyFinding,
  Severity,
  TokenAccountInput,
  VoteThresholdInput,
} from './types'
import {
  ENGINE_VERSION,
  GOVERNANCE_PROGRAMS,
  KNOWN_MINT_SYMBOLS,
  PROGRAM_NAMES,
  VSR_PROGRAMS,
} from './constants'
import { Decoded, decodeInstruction } from './decode'
import {
  ZERO,
  b64ToBytes,
  fmtDuration,
  fmtPct,
  formatCompact,
  formatUnits,
  formatUnitsFull,
  percent,
  quoteText,
  short,
} from './util'

const SEV_RANK: Record<MaxSeverity, number> = { none: 0, info: 1, yellow: 2, red: 3 }
export const maxSev = (a: MaxSeverity, b: MaxSeverity): MaxSeverity =>
  SEV_RANK[a] >= SEV_RANK[b] ? a : b

const SOL_DECIMALS = 9

/** Shared lookup context derived from the input. */
class Ctx {
  governances = new Map<string, GovernanceInput>()
  treasuryToGovernance = new Map<string, string>()
  daoOwners = new Set<string>()
  tokenAccounts = new Map<string, TokenAccountInput>()
  holdingsByMint = new Map<string, bigint>()
  governedPrograms = new Map<string, string>() // program -> governance
  voterWeightAddins = new Map<string, string>() // program -> role label
  payeeAddrs = new Set<string>()
  notes: string[] = []

  constructor(public input: ProposalSafetyInput) {
    const all = [input.governance, ...input.treasury.governances]
    for (const g of all) {
      if (!g) continue
      if (!this.governances.has(g.pubkey)) this.governances.set(g.pubkey, g)
      this.daoOwners.add(g.pubkey)
      if (g.nativeTreasury) {
        this.daoOwners.add(g.nativeTreasury)
        this.treasuryToGovernance.set(g.nativeTreasury, g.pubkey)
      }
      if (/^ProgramGovernance/.test(g.accountType) && g.governedAccount)
        this.governedPrograms.set(g.governedAccount, g.pubkey)
    }
    this.daoOwners.add(input.realm.pubkey)
    for (const [pid, p] of Object.entries(input.programs || {})) {
      if (p.governedBy) this.governedPrograms.set(pid, p.governedBy)
      else if (p.upgradeAuthority && this.daoOwners.has(p.upgradeAuthority))
        this.governedPrograms.set(pid, p.upgradeAuthority)
    }
    for (const ta of input.treasury.tokenAccounts) {
      this.tokenAccounts.set(ta.address, ta)
      if (this.daoOwners.has(ta.owner)) {
        this.holdingsByMint.set(
          ta.mint,
          (this.holdingsByMint.get(ta.mint) ?? ZERO) + BigInt(ta.amount),
        )
      }
    }
    // native SOL held by treasuries
    let sol = ZERO
    let solKnown = false
    for (const g of this.governances.values()) {
      if (g.nativeTreasuryLamports !== undefined) {
        sol += BigInt(g.nativeTreasuryLamports)
        solKnown = true
      }
    }
    if (solKnown) this.holdingsByMint.set('SOL', sol)

    const rc = input.realmConfig
    if (rc.communityVoterWeightAddin)
      this.voterWeightAddins.set(rc.communityVoterWeightAddin, 'community voter-weight plugin')
    if (rc.communityMaxVoterWeightAddin)
      this.voterWeightAddins.set(rc.communityMaxVoterWeightAddin, 'community max-voter-weight plugin')
    if (rc.councilVoterWeightAddin)
      this.voterWeightAddins.set(rc.councilVoterWeightAddin, 'council voter-weight plugin')
    if (rc.councilMaxVoterWeightAddin)
      this.voterWeightAddins.set(rc.councilMaxVoterWeightAddin, 'council max-voter-weight plugin')

    // Known payees: only payments made by OTHER proposals, executed before this proposal was drafted.
    const cutoff = input.proposal.draftAt ?? null
    for (const p of input.knownPayees) {
      if (p.proposal === input.proposal.pubkey) continue
      if (cutoff !== null && p.executedAt !== undefined && p.executedAt !== null && p.executedAt > cutoff)
        continue
      this.payeeAddrs.add(p.address)
      if (p.owner) this.payeeAddrs.add(p.owner)
    }
  }

  tokenInfo(addr: string): { owner?: string | null; mint?: string; amount?: string; decimals?: number } | undefined {
    const ta = this.tokenAccounts.get(addr)
    if (ta) return ta
    const a = this.input.accounts[addr]
    if (a && a.kind === 'token') return a
    return undefined
  }

  ownerOf(addr: string): string | undefined {
    const t = this.tokenInfo(addr)
    if (t?.owner) return t.owner
    return undefined
  }

  isDao(addr: string | null | undefined): boolean {
    if (!addr) return false
    if (this.daoOwners.has(addr)) return true
    const o = this.ownerOf(addr)
    if (o && this.daoOwners.has(o)) return true
    if (this.governedPrograms.has(addr)) return true
    return false
  }

  isKnownPayee(addr: string): boolean {
    if (this.payeeAddrs.has(addr)) return true
    const o = this.ownerOf(addr)
    return !!o && this.payeeAddrs.has(o)
  }

  /**
   * true = paid before; false = not in the (complete or partial) history; null = history not loaded.
   * `text` is the sentence shown to voters.
   */
  payee(addr: string): { known: boolean | null; text: string; titleText: string } {
    const status = this.input.knownPayeesStatus ?? 'complete'
    if (this.isKnownPayee(addr))
      return { known: true, text: 'This DAO has paid this address before.', titleText: 'an outside address' }
    if (status === 'not-loaded')
      return {
        known: null,
        text: 'Payment history is still being checked — cannot tell yet whether this DAO has paid this address before.',
        titleText: 'an outside address',
      }
    if (status === 'partial')
      return {
        known: false,
        text: `This DAO has never paid this address before (as far as the checked history goes: ${this.input.knownPayeesScope ?? 'partial scan'}).`,
        titleText: 'an address this DAO has never paid',
      }
    return { known: false, text: 'This DAO has never paid this address before.', titleText: 'an address this DAO has never paid' }
  }

  symbol(mint: string | undefined): string {
    if (!mint) return 'tokens'
    if (mint === 'SOL') return 'SOL'
    return this.input.mints[mint]?.symbol ?? KNOWN_MINT_SYMBOLS[mint] ?? `tokens of mint ${short(mint)}`
  }

  decimals(mint: string | undefined, fallback?: number): number | undefined {
    if (mint && this.input.mints[mint]) return this.input.mints[mint].decimals
    return fallback
  }

  programName(pid: string): string {
    return (
      this.input.programs?.[pid]?.name ??
      PROGRAM_NAMES[pid] ??
      (pid === this.input.realm.programId ? 'SPL Governance (this realm)' : `Unknown program ${short(pid)}`)
    )
  }

  label(addr: string | null | undefined): string {
    if (!addr) return '(none)'
    const g = this.governances.get(addr)
    if (g) return `DAO governance ${short(addr)}`
    const tg = this.treasuryToGovernance.get(addr)
    if (tg) return `DAO treasury ${short(addr)}`
    if (addr === this.input.realm.pubkey) return `the realm ${short(addr)}`
    if (PROGRAM_NAMES[addr] || this.input.programs?.[addr]?.name) return `${this.programName(addr)} (${short(addr)})`
    const t = this.tokenInfo(addr)
    if (t) {
      const sym = this.symbol(t.mint)
      if (t.owner && this.daoOwners.has(t.owner)) return `DAO ${sym} account ${short(addr)}`
      return `${sym} account ${short(addr)}${t.owner ? ` (owned by ${short(t.owner)})` : ''}`
    }
    const a = this.input.accounts[addr]
    if (a?.kind === 'missing') return `${short(addr)} (account does not exist yet)`
    return short(addr)
  }
}

interface IxAnalysis {
  action: DecodedAction
  findings: SafetyFinding[]
  /** treasury outflow to non-DAO, plugin, authority, upgrade, config */
  sensitive: boolean
  /** what this instruction actually does, for the description check */
  actually?: string
  flags: {
    outflow?: { severity: Severity; destination: string; destinationOwner?: string; uiAmount: number; rawAmount: bigint; decimals: number; known: boolean | null }
    pluginReplacement?: boolean
    authorityChange?: boolean
    configChange?: boolean
    upgrade?: boolean
  }
}

function thresholdStr(t?: VoteThresholdInput): string {
  if (!t) return '(not set)'
  if (t.type === 'Disabled') return 'Disabled'
  return `${t.type === 'YesVotePercentage' ? 'Yes votes' : 'Quorum'} ${t.value}%`
}

function governanceConfigChanges(
  oldCfg: GovernanceConfigInput | undefined,
  newCfg: GovernanceConfigInput,
  ix: number,
): ConfigChange[] {
  const rows: [string, string, string, string][] = [
    ['communityVoteThreshold', 'Community approval threshold', thresholdStr(oldCfg?.communityVoteThreshold), thresholdStr(newCfg.communityVoteThreshold)],
    ['councilVoteThreshold', 'Council approval threshold', thresholdStr(oldCfg?.councilVoteThreshold), thresholdStr(newCfg.councilVoteThreshold)],
    ['councilVetoVoteThreshold', 'Council veto threshold', thresholdStr(oldCfg?.councilVetoVoteThreshold), thresholdStr(newCfg.councilVetoVoteThreshold)],
    ['communityVetoVoteThreshold', 'Community veto threshold', thresholdStr(oldCfg?.communityVetoVoteThreshold), thresholdStr(newCfg.communityVetoVoteThreshold)],
    ['minInstructionHoldUpTime', 'Minimum hold-up time', oldCfg ? fmtDuration(oldCfg.minInstructionHoldUpTime) : '(unknown)', fmtDuration(newCfg.minInstructionHoldUpTime)],
    ['baseVotingTime', 'Voting time', oldCfg ? fmtDuration(oldCfg.baseVotingTime) : '(unknown)', fmtDuration(newCfg.baseVotingTime)],
    ['votingCoolOffTime', 'Cool-off (veto-only) time', oldCfg?.votingCoolOffTime !== undefined ? fmtDuration(oldCfg.votingCoolOffTime) : '(unknown)', newCfg.votingCoolOffTime !== undefined ? fmtDuration(newCfg.votingCoolOffTime) : '(not set)'],
    ['communityVoteTipping', 'Community vote tipping', oldCfg?.communityVoteTipping ?? '(unknown)', newCfg.communityVoteTipping],
    ['councilVoteTipping', 'Council vote tipping', oldCfg?.councilVoteTipping ?? '(unknown)', newCfg.councilVoteTipping ?? '(not set)'],
    ['minCommunityTokensToCreateProposal', 'Min community tokens to create proposal (raw)', oldCfg?.minCommunityTokensToCreateProposal ?? '(unknown)', newCfg.minCommunityTokensToCreateProposal],
    ['minCouncilTokensToCreateProposal', 'Min council tokens to create proposal (raw)', oldCfg?.minCouncilTokensToCreateProposal ?? '(unknown)', newCfg.minCouncilTokensToCreateProposal],
  ]
  return rows.map(([key, label, o, n]) => ({
    key: `governance.${key}`,
    label,
    old: o,
    new: n,
    changed: o !== n,
    instructionIndex: ix,
  }))
}

function analyzeInstruction(ctx: Ctx, ix: InstructionInput, d: Decoded, opts: Required<Pick<AnalyzeOptions, 'outflowRedFraction'>>, execOutflow: Map<string, bigint>, execMintOutflow: Map<string, bigint>): IxAnalysis {
  const input = ctx.input
  const pid = ix.programId
  const programName = ctx.programName(pid)
  const action: DecodedAction = {
    index: ix.index,
    txIndex: ix.txIndex,
    ixIndexInTx: ix.ixIndexInTx,
    optionIndex: ix.optionIndex,
    holdUpTime: ix.holdUpTime,
    executed: !!ix.executedAt,
    programId: pid,
    programName,
    kind: d.type,
    known: d.type !== 'unknown',
    summary: '',
    details: [],
    changes: [],
    severity: 'none',
  }
  const res: IxAnalysis = { action, findings: [], sensitive: false, flags: {} }
  const n = ix.index + 1 // human numbering
  const add = (f: Omit<SafetyFinding, 'instructionIndex'>) =>
    res.findings.push({ ...f, instructionIndex: ix.index })
  const detail = (label: string, value: string) => action.details.push({ label, value })
  const redPct = opts.outflowRedFraction * 100

  const outflow = (p: {
    verb: string
    source: string
    destination: string
    raw: bigint
    mint: string | undefined
    decimals: number
    sourceBalance?: bigint
  }) => {
    const sym = ctx.symbol(p.mint)
    const amt = formatUnits(p.raw, p.decimals)
    const compact = formatCompact(p.raw, p.decimals)
    const destOwner = ctx.ownerOf(p.destination)
    detail('Amount', `${formatUnitsFull(p.raw, p.decimals)} ${sym}`)
    detail('From', ctx.label(p.source))
    detail('To', ctx.label(p.destination))
    if (destOwner) detail('Destination owner', destOwner)

    if (ctx.isDao(p.destination)) {
      action.summary = `${p.verb} ${amt} ${sym} from ${ctx.label(p.source)} to ${ctx.label(p.destination)} (both DAO-owned).`
      add({
        id: 'INTERNAL_TRANSFER',
        severity: 'info',
        title: `Moves ${compact} ${sym} between DAO accounts`,
        explanation: `${ctx.label(p.destination)} is controlled by this DAO, so funds stay inside the DAO.`,
      })
      return
    }
    res.sensitive = true
    const pv = ctx.payee(p.destination)
    const known = pv.known
    // Balances: for already-executed instructions the on-chain balance is post-execution;
    // reconstruct the pre-execution balance by adding back executed outflows (approximate).
    let bal = p.sourceBalance
    if (bal !== undefined) bal += execOutflow.get(p.source) ?? ZERO
    const mintKey = p.mint ?? '?'
    let total = ctx.holdingsByMint.get(mintKey)
    if (total !== undefined) total += execMintOutflow.get(mintKey) ?? ZERO
    const pctAcct = bal !== undefined ? percent(p.raw, bal) : null
    const pctTotal = total !== undefined ? percent(p.raw, total) : null
    if (pctAcct !== null) detail('Share of source account', fmtPct(pctAcct))
    if (pctTotal !== null) detail(`Share of all DAO ${sym}`, fmtPct(pctTotal))

    const big = (pctTotal ?? 0) >= redPct
    const severity: Severity = known === false || big ? 'red' : 'yellow'
    const destText =
      `${short(p.destination)}` +
      (destOwner ? ` (a ${sym} account owned by ${short(destOwner)})` : '')
    const shareText =
      pctAcct !== null
        ? `that is ${fmtPct(pctAcct)} of that treasury account` +
          (pctTotal !== null ? ` and ${fmtPct(pctTotal)} of all ${sym} held by this DAO` : '')
        : `the balance of the source account is unknown`
    const knownText = pv.text
    action.summary = `${p.verb} ${amt} ${sym} from ${ctx.label(p.source)} to ${destText}.`
    const title =
      severity === 'red'
        ? `Sends ${pctAcct !== null ? fmtPct(pctAcct) + ' of a treasury account' : 'treasury funds'} (${compact} ${sym}) to ${pv.titleText}`
        : known === null
        ? `Sends ${compact} ${sym} to an outside address (payment history pending)`
        : `Pays ${compact} ${sym} to a previous payee`
    add({
      id: 'TREASURY_OUTFLOW',
      severity,
      title,
      explanation: `${p.verb} ${amt} ${sym} (~${compact}) from ${ctx.label(p.source)} — ${shareText} — to ${destText}. ${knownText}`,
    })
    res.flags.outflow = {
      severity,
      destination: p.destination,
      destinationOwner: destOwner,
      uiAmount: Number(p.raw) / Math.pow(10, p.decimals),
      rawAmount: p.raw,
      decimals: p.decimals,
      known,
    }
    res.actually = `moves ${compact} ${sym}${pctAcct !== null ? ` (${fmtPct(pctAcct)} of a treasury account)` : ''} to ${short(p.destination)}${known === false ? ', an address this DAO has never paid' : ''}`
  }

  switch (d.type) {
    case 'token-transfer': {
      const t = ctx.tokenInfo(d.source)
      const mint = d.mint ?? t?.mint
      const decimals = d.decimals ?? ctx.decimals(mint, t?.decimals) ?? 0
      if (!ctx.isDao(d.source) && !ctx.isDao(d.authority)) {
        action.summary = `Transfer ${formatUnits(d.amount, decimals)} ${ctx.symbol(mint)} from ${ctx.label(d.source)} to ${ctx.label(d.destination)} (source is not a DAO account).`
        detail('Authority', ctx.label(d.authority))
        break
      }
      outflow({
        verb: 'Sends',
        source: d.source,
        destination: d.destination,
        raw: d.amount,
        mint,
        decimals,
        sourceBalance: t?.amount !== undefined ? BigInt(t.amount) : undefined,
      })
      detail('Signed by', ctx.label(d.authority))
      break
    }
    case 'sol-transfer': {
      if (!ctx.isDao(d.from)) {
        action.summary = `Transfer ${formatUnits(d.lamports, SOL_DECIMALS)} SOL from ${ctx.label(d.from)} to ${ctx.label(d.to)}.`
        break
      }
      const g = ctx.governances.get(ctx.treasuryToGovernance.get(d.from) ?? '')
      const lam = g?.nativeTreasuryLamports ?? input.accounts[d.from]?.lamports
      outflow({
        verb: 'Sends',
        source: d.from,
        destination: d.to,
        raw: d.lamports,
        mint: 'SOL',
        decimals: SOL_DECIMALS,
        sourceBalance: lam !== undefined ? BigInt(lam) : undefined,
      })
      break
    }
    case 'token-approve': {
      const t = ctx.tokenInfo(d.source)
      const decimals = ctx.decimals(t?.mint, t?.decimals) ?? 0
      const sym = ctx.symbol(t?.mint)
      detail('Account', ctx.label(d.source))
      detail('Delegate', ctx.label(d.delegate))
      detail('Allowance', `${formatUnitsFull(d.amount, decimals)} ${sym}`)
      action.summary = `Allow ${ctx.label(d.delegate)} to spend up to ${formatUnits(d.amount, decimals)} ${sym} from ${ctx.label(d.source)}.`
      if (ctx.isDao(d.source) && !ctx.isDao(d.delegate)) {
        res.sensitive = true
        const pv = ctx.payee(d.delegate)
        const known = pv.known
        const bal = t?.amount !== undefined ? BigInt(t.amount) : undefined
        const pct = bal !== undefined ? percent(d.amount, bal) : null
        const sev: Severity = known !== true || (pct ?? 100) >= redPct ? 'red' : 'yellow'
        add({
          id: 'TREASURY_OUTFLOW',
          severity: sev,
          title: `Lets an outside address spend ${formatCompact(d.amount, decimals)} ${sym} from the treasury`,
          explanation: `Approves ${short(d.delegate)} as a delegate who can move up to ${formatUnits(d.amount, decimals)} ${sym} (${fmtPct(pct)} of ${ctx.label(d.source)}) at any time without another vote. ${pv.text}`,
        })
        res.flags.outflow = { severity: sev, destination: d.delegate, uiAmount: Number(d.amount) / Math.pow(10, decimals), rawAmount: d.amount, decimals, known }
        res.actually = `lets ${short(d.delegate)} spend ${formatCompact(d.amount, decimals)} ${sym} from the treasury`
      }
      break
    }
    case 'token-mint-to': {
      const decimals = ctx.decimals(d.mint) ?? 0
      const sym = ctx.symbol(d.mint)
      action.summary = `Mint ${formatUnits(d.amount, decimals)} new ${sym} to ${ctx.label(d.destination)}.`
      detail('Mint', d.mint)
      detail('To', ctx.label(d.destination))
      if (!ctx.isDao(d.destination)) {
        res.sensitive = true
        const pv = ctx.payee(d.destination)
        const known = pv.known
        const sev: Severity = known === false ? 'red' : 'yellow'
        add({
          id: 'TREASURY_OUTFLOW',
          severity: sev,
          title: `Mints ${formatCompact(d.amount, decimals)} new ${sym} to ${known ? 'a previous payee' : pv.titleText}`,
          explanation: `Creates ${formatUnits(d.amount, decimals)} new ${sym} and sends them to ${ctx.label(d.destination)}. ${pv.text}`,
        })
        res.flags.outflow = { severity: sev, destination: d.destination, uiAmount: Number(d.amount) / Math.pow(10, decimals), rawAmount: d.amount, decimals, known }
        res.actually = `mints ${formatCompact(d.amount, decimals)} new ${sym} to ${short(d.destination)}`
      }
      break
    }
    case 'token-burn': {
      const t = ctx.tokenInfo(d.account)
      const decimals = ctx.decimals(d.mint, t?.decimals) ?? 0
      const sym = ctx.symbol(d.mint)
      const bal = t?.amount !== undefined ? BigInt(t.amount) + (execOutflow.get(d.account) ?? ZERO) : undefined
      const pct = bal !== undefined ? percent(d.amount, bal) : null
      action.summary = `Permanently burn ${formatUnits(d.amount, decimals)} ${sym} from ${ctx.label(d.account)}${pct !== null ? ` (${fmtPct(pct)} of that account)` : ''}.`
      if (ctx.isDao(d.account)) {
        res.sensitive = true
        add({
          id: 'TREASURY_OUTFLOW',
          severity: 'yellow',
          title: `Burns ${formatCompact(d.amount, decimals)} ${sym} from the treasury`,
          explanation: `Destroys ${formatUnits(d.amount, decimals)} ${sym}${pct !== null ? ` (${fmtPct(pct)} of ${ctx.label(d.account)})` : ''}. Burned tokens cannot be recovered.`,
        })
        res.actually = `burns ${formatCompact(d.amount, decimals)} ${sym}`
      }
      break
    }
    case 'token-close': {
      action.summary = `Close token account ${ctx.label(d.account)}; its rent SOL goes to ${ctx.label(d.destination)}.`
      if (ctx.isDao(d.account) && !ctx.isDao(d.destination)) {
        add({
          id: 'TREASURY_OUTFLOW',
          severity: 'yellow',
          title: 'Closes a DAO token account and sends its rent to an outside address',
          explanation: `${ctx.label(d.account)} is closed (it must be empty) and its rent-exempt SOL goes to ${ctx.label(d.destination)}.`,
        })
      }
      break
    }
    case 'token-set-authority': {
      const t = ctx.tokenInfo(d.account)
      const what =
        d.authorityType === 'AccountOwner'
          ? 'owner'
          : d.authorityType === 'CloseAccount'
          ? 'close authority'
          : d.authorityType === 'MintTokens'
          ? 'mint authority'
          : d.authorityType === 'FreezeAccount'
          ? 'freeze authority'
          : `${d.authorityType} authority`
      action.summary = d.newAuthority
        ? `Change the ${what} of ${ctx.label(d.account)} to ${ctx.label(d.newAuthority)}.`
        : `Remove the ${what} of ${ctx.label(d.account)} (cannot be undone).`
      detail('Account', d.account)
      detail('New authority', d.newAuthority ?? '(none)')
      action.changes.push({ key: `token.${d.account}.${d.authorityType}`, label: `${what} of ${short(d.account)}`, old: d.currentAuthority, new: d.newAuthority ?? '(none)', changed: d.currentAuthority !== d.newAuthority, instructionIndex: ix.index })
      const daoControlled = ctx.isDao(d.account) || ctx.isDao(d.currentAuthority)
      if (daoControlled) {
        res.sensitive = true
        res.flags.authorityChange = true
        const away = d.newAuthority !== null && !ctx.isDao(d.newAuthority)
        const holding = t?.amount !== undefined && t.mint ? ` (currently holding ${formatUnits(BigInt(t.amount), ctx.decimals(t.mint, t.decimals) ?? 0)} ${ctx.symbol(t.mint)})` : ''
        add({
          id: 'AUTHORITY_CHANGE',
          severity: away ? 'red' : 'yellow',
          title: away ? `Hands the ${what} of a DAO account to an outside address` : `Changes the ${what} of a DAO account`,
          explanation: away
            ? `After this executes, ${short(d.newAuthority)} — not the DAO — controls ${ctx.label(d.account)}${holding}.`
            : d.newAuthority
            ? `The new ${what} ${ctx.label(d.newAuthority)} is controlled by this DAO.`
            : `The ${what} of ${ctx.label(d.account)} is removed permanently.`,
        })
        res.actually = away ? `gives control of ${short(d.account)} to ${short(d.newAuthority)}` : `changes the ${what} of ${short(d.account)}`
      }
      break
    }
    case 'bpf-upgrade': {
      res.sensitive = true
      res.flags.upgrade = true
      const prog = d.program
      const pname = ctx.programName(prog)
      const buf = input.buffers?.[d.buffer]
      const pinfo = input.programs?.[prog]
      detail('Program', `${pname} (${prog})`)
      detail('New code from buffer', d.buffer)
      if (buf?.exists) detail('Buffer size', `${buf.dataLen.toLocaleString('en-US')} bytes`)
      if (buf) detail('Buffer authority', buf.authority ?? '(none)')
      detail('Spill (receives buffer rent)', ctx.label(d.spill))
      detail('Upgrade authority (signer)', ctx.label(d.authority))
      action.summary = `Replace the code of program ${pname} (${short(prog)}) with the code in buffer ${short(d.buffer)}${buf?.exists ? ` (${buf.dataLen.toLocaleString('en-US')} bytes)` : ''}.`
      action.changes.push({ key: `program.${prog}.code`, label: `Code of ${pname}`, old: 'current deployed code', new: `contents of buffer ${short(d.buffer)}`, changed: true, instructionIndex: ix.index })

      const role = ctx.voterWeightAddins.get(prog)
      if (role) {
        res.flags.pluginReplacement = true
        add({
          id: 'VOTER_WEIGHT_PLUGIN_REPLACEMENT',
          severity: 'red',
          title: 'Replaces the program that counts votes',
          explanation: `This replaces the code of the program that counts votes (${pname}, ${short(prog)} — the realm's ${role}). Whoever writes that code decides voting power: new code could give any wallet unlimited votes on every future proposal, including ones that drain the treasury.`,
        })
        res.actually = `replaces the code of the voting program (${pname.replace(/ \(.*\)$/, '')}) that decides everyone's voting power`
      } else {
        res.actually = `upgrades program ${pname}`
      }
      const bufferOk = buf?.exists && buf.authority !== null && ctx.isDao(buf.authority)
      const isGovProgram = prog === input.realm.programId
      const reasons: string[] = []
      if (isGovProgram) reasons.push('it upgrades the governance program that runs this DAO')
      if (!buf) reasons.push('the upgrade buffer could not be inspected')
      else if (!buf.exists) {
        if (!ix.executedAt) reasons.push('the upgrade buffer does not exist (the instruction would fail, or the buffer was closed/replaced)')
      } else if (!bufferOk)
        reasons.push(`the buffer's authority ${short(buf.authority)} is not the DAO, so it can still swap the code while you vote`)
      if (pinfo && pinfo.upgradeAuthority !== null && pinfo.upgradeAuthority !== d.authority)
        reasons.push(`the signer ${short(d.authority)} is not the program's current upgrade authority ${short(pinfo.upgradeAuthority)} (the instruction would fail)`)
      const spillNote = ctx.isDao(d.spill) ? '' : ` The buffer's rent goes to ${short(d.spill)}, which is not a DAO account.`
      const sev: Severity = reasons.length ? 'red' : 'yellow'
      add({
        id: 'PROGRAM_UPGRADE',
        severity: sev,
        title: sev === 'red' ? `Dangerous program upgrade: ${pname}` : `Upgrades program ${pname}`,
        explanation:
          (sev === 'red' ? `Red because ${reasons.join('; ')}. ` : '') +
          `The new code (buffer ${short(d.buffer)}${buf?.exists ? `, ${buf.dataLen.toLocaleString('en-US')} bytes` : ''}) is not verified by this UI — compare its hash with a verified, reviewed build before voting.` +
          (ix.executedAt && buf && !buf.exists ? ' (Already executed; the buffer was consumed by the upgrade.)' : '') +
          spillNote,
      })
      break
    }
    case 'bpf-set-authority': {
      // target is a ProgramData account or a Buffer
      const progEntry = Object.entries(input.programs || {}).find(([, p]) => p.programData === d.target)
      const prog = progEntry?.[0]
      const isBuffer = input.accounts[d.target]?.kind === 'buffer' || !!input.buffers?.[d.target]
      const what = prog ? `program ${ctx.programName(prog)} (${short(prog)})` : isBuffer ? `buffer ${short(d.target)}` : `program/buffer account ${short(d.target)}`
      action.summary = d.newAuthority
        ? `Change the upgrade authority of ${what} to ${ctx.label(d.newAuthority)}.`
        : `Remove the upgrade authority of ${what} — it becomes permanently immutable.`
      detail('Account', d.target)
      detail('New authority', d.newAuthority ?? '(none — immutable)')
      action.changes.push({ key: `program.${prog ?? d.target}.upgradeAuthority`, label: `Upgrade authority of ${what}`, old: d.currentAuthority, new: d.newAuthority ?? '(none — immutable)', changed: d.currentAuthority !== d.newAuthority, instructionIndex: ix.index })
      res.sensitive = true
      res.flags.authorityChange = true
      const away = d.newAuthority !== null && !ctx.isDao(d.newAuthority)
      if (prog && ctx.voterWeightAddins.has(prog)) {
        res.flags.pluginReplacement = true
        add({
          id: 'VOTER_WEIGHT_PLUGIN_REPLACEMENT',
          severity: 'red',
          title: 'Changes who controls the program that counts votes',
          explanation: `This changes the upgrade authority of the program that counts votes (${ctx.programName(prog)}). Whoever controls that code decides voting power.`,
        })
      }
      add({
        id: 'AUTHORITY_CHANGE',
        severity: away || (prog === input.realm.programId) ? 'red' : 'yellow',
        title: away ? `Hands upgrade control of ${what} to an outside address` : `Changes upgrade authority of ${what}`,
        explanation: away
          ? `After this executes, ${short(d.newAuthority)} — not the DAO — can replace the code of ${what} at any time without a vote.`
          : d.newAuthority
          ? `The new authority ${ctx.label(d.newAuthority)} is controlled by this DAO.`
          : `Nobody will be able to upgrade ${what} ever again (including to fix bugs).`,
      })
      res.actually = away ? `gives upgrade control of ${what} to ${short(d.newAuthority)}` : `changes the upgrade authority of ${what}`
      break
    }
    case 'bpf-close': {
      const progEntry = Object.entries(input.programs || {}).find(([, p]) => p.programData === d.target)
      action.summary = progEntry
        ? `Close (delete) program ${ctx.programName(progEntry[0])}; rent goes to ${ctx.label(d.recipient)}.`
        : `Close buffer/account ${short(d.target)}; rent goes to ${ctx.label(d.recipient)}.`
      if (progEntry) {
        res.sensitive = true
        add({ id: 'PROGRAM_UPGRADE', severity: 'red', title: `Deletes program ${ctx.programName(progEntry[0])}`, explanation: 'Closing a program account permanently removes the program; it can never be redeployed at the same address.' })
        res.actually = `deletes program ${ctx.programName(progEntry[0])}`
      } else if (!ctx.isDao(d.recipient)) {
        add({ id: 'TREASURY_OUTFLOW', severity: 'yellow', title: 'Closes a buffer and sends its rent to an outside address', explanation: `Rent SOL from ${short(d.target)} goes to ${ctx.label(d.recipient)}.` })
      }
      break
    }
    case 'bpf-extend':
      action.summary = `Extend program ${ctx.programName(d.program)} by ${d.additionalBytes} bytes (paid from the DAO).`
      break
    case 'bpf-other':
      action.summary = `Program loader: ${d.name}.`
      add({ id: 'PROGRAM_UPGRADE', severity: 'yellow', title: `Program loader instruction: ${d.name}`, explanation: 'Unusual loader instruction for a proposal; check the accounts carefully.' })
      res.sensitive = true
      break
    case 'gov-set-governance-config': {
      const old = ctx.governances.get(d.governance)?.config
      const changes = governanceConfigChanges(old, d.config, ix.index)
      action.changes.push(...changes)
      const changed = changes.filter((c) => c.changed)
      action.summary = `Change the voting rules of ${ctx.label(d.governance)}: ${changed.length ? changed.map((c) => `${c.label} ${c.old} → ${c.new}`).join('; ') : 'no effective changes'}.`
      res.sensitive = true
      res.flags.configChange = changed.length > 0
      const vetoRemoved = old && old.councilVetoVoteThreshold.type !== 'Disabled' && d.config.councilVetoVoteThreshold.type === 'Disabled'
      add({
        id: 'GOVERNANCE_CONFIG_CHANGE',
        severity: vetoRemoved ? 'red' : 'yellow',
        title: vetoRemoved ? 'Removes the council veto' : 'Changes how this governance votes',
        explanation:
          (vetoRemoved ? 'The council veto is the last line of defence against a malicious proposal; this disables it. ' : '') +
          (changed.length ? changed.map((c) => `${c.label}: ${c.old} → ${c.new}`).join('; ') + '.' : 'No effective changes compared with the current config.') +
          (old ? '' : ' (Current config unknown — old values could not be loaded.)'),
      })
      if (changed.length) res.actually = `changes the voting rules (${changed.map((c) => c.label.toLowerCase()).join(', ')})`
      break
    }
    case 'gov-set-realm-config': {
      const rc = input.realmConfig
      const cur = (v: string | null) => v ?? '(none)'
      const changes: ConfigChange[] = []
      const push = (key: string, label: string, o: string, nv: string) =>
        changes.push({ key, label, old: o, new: nv, changed: o !== nv, instructionIndex: ix.index })
      if (d.community) {
        push('realm.communityVoterWeightAddin', 'Community voter-weight plugin (counts votes)', cur(rc.communityVoterWeightAddin), cur(d.community.voterWeightAddin))
        push('realm.communityMaxVoterWeightAddin', 'Community max-voter-weight plugin', cur(rc.communityMaxVoterWeightAddin), cur(d.community.maxVoterWeightAddin))
        if (d.layoutVersion === 3) push('realm.communityTokenType', 'Community token type', rc.communityTokenType ?? '(unknown)', d.community.tokenType)
      }
      if (d.council) {
        push('realm.councilVoterWeightAddin', 'Council voter-weight plugin', cur(rc.councilVoterWeightAddin), cur(d.council.voterWeightAddin))
        push('realm.councilMaxVoterWeightAddin', 'Council max-voter-weight plugin', cur(rc.councilMaxVoterWeightAddin), cur(d.council.maxVoterWeightAddin))
        push('realm.councilTokenType', 'Council token type', rc.councilTokenType ?? '(unknown)', d.council.tokenType)
      }
      push('realm.councilMint', 'Council mint', cur(input.realm.councilMint), d.useCouncilMint ? cur(d.councilMint ?? input.realm.councilMint) : '(none — council removed)')
      push('realm.minCommunityTokensToCreateGovernance', 'Min community tokens to create a governance (raw)', input.realm.minCommunityTokensToCreateGovernance ?? '(unknown)', d.minCommunityTokensToCreateGovernance.toString())
      const src = input.realm.communityMintMaxVoteWeightSource
      push('realm.communityMintMaxVoteWeightSource', 'Community max vote weight source', src ? `${src.type} ${src.value}` : '(unknown)', `${d.maxVoteWeightSource.type} ${d.maxVoteWeightSource.value.toString()}`)
      action.changes.push(...changes)
      const changed = changes.filter((c) => c.changed && !c.old.startsWith('(unknown'))
      action.summary = `Change the realm configuration: ${changed.length ? changed.map((c) => `${c.label} ${c.old === '(none)' ? '(none)' : short(c.old)} → ${short(c.new)}`).join('; ') : 'no effective changes'}.`
      res.sensitive = true
      res.flags.configChange = changed.length > 0
      const plugin = changes.filter((c) => /Addin$/.test(c.key) && c.changed)
      if (plugin.length) {
        res.flags.pluginReplacement = true
        add({
          id: 'VOTER_WEIGHT_PLUGIN_REPLACEMENT',
          severity: 'red',
          title: 'Replaces the plugin that counts votes',
          explanation: `This changes which program counts votes: ${plugin.map((c) => `${c.label}: ${c.old} → ${c.new}`).join('; ')}. Whoever writes that program decides voting power.`,
        })
        res.actually = 'replaces the plugin that counts votes'
      }
      const councilRemoved = input.realm.councilMint && !d.useCouncilMint
      const other = changed.filter((c) => !/Addin$/.test(c.key))
      if (councilRemoved || other.length) {
        add({
          id: 'REALM_CONFIG_CHANGE',
          severity: councilRemoved ? 'red' : 'yellow',
          title: councilRemoved ? 'Removes the council (and its veto)' : 'Changes the realm configuration',
          explanation: other.map((c) => `${c.label}: ${c.old} → ${c.new}`).join('; ') + '.',
        })
        if (!res.actually) res.actually = 'changes the realm configuration'
      }
      break
    }
    case 'gov-set-realm-authority': {
      res.sensitive = true
      res.flags.authorityChange = true
      const away = d.newAuthority === null || !ctx.isDao(d.newAuthority)
      action.summary = d.newAuthority ? `Make ${ctx.label(d.newAuthority)} the realm authority.` : 'Remove the realm authority permanently.'
      action.changes.push({ key: 'realm.authority', label: 'Realm authority', old: input.realm.authority ?? '(none)', new: d.newAuthority ?? '(none)', changed: input.realm.authority !== d.newAuthority, instructionIndex: ix.index })
      add({
        id: 'AUTHORITY_CHANGE',
        severity: away ? 'red' : 'yellow',
        title: d.newAuthority ? (away ? 'Hands the realm authority to an outside address' : 'Moves the realm authority to another DAO governance') : 'Removes the realm authority',
        explanation: d.newAuthority
          ? `The realm authority can change the realm config, including which program counts votes. New authority: ${ctx.label(d.newAuthority)}${away ? ' — not controlled by this DAO' : ''}.`
          : 'Nobody will be able to change the realm configuration again.',
      })
      res.actually = d.newAuthority ? `changes the realm authority to ${short(d.newAuthority)}` : 'removes the realm authority'
      break
    }
    case 'gov-other': {
      action.summary = `Governance program: ${d.name}.`
      if (['RevokeGoverningTokens', 'SetGovernanceDelegate', 'CreateGovernance', 'CreateProgramGovernance', 'CreateMintGovernance', 'CreateTokenGovernance'].includes(d.name)) {
        add({ id: 'GOVERNANCE_CONFIG_CHANGE', severity: 'yellow', title: `Governance action: ${d.name}`, explanation: d.name === 'RevokeGoverningTokens' ? 'Removes (revokes) governing tokens from a member — this changes who can vote.' : 'Changes the governance structure of this DAO; check the accounts.' })
      }
      break
    }
    case 'vsr-configure-voting-mint': {
      const reg = input.vsrRegistrars?.[d.registrar]
      const cur = reg?.votingMints[d.idx]
      const sym = ctx.symbol(d.mint)
      const f = (v: bigint) => (Number(v) / 1e9).toString()
      const days = (v: bigint | string) => `${(Number(v) / 86400).toString()} days`
      const rows: [string, string, string | undefined, string][] = [
        ['mint', `Voting mint #${d.idx}`, cur?.mint, d.mint],
        ['baseline', 'Voting power per unlocked token (factor)', cur && f(BigInt(cur.baselineVoteWeightScaledFactor)), f(d.baselineVoteWeightScaledFactor)],
        ['maxExtra', 'Extra voting power for max lockup (factor)', cur && f(BigInt(cur.maxExtraLockupVoteWeightScaledFactor)), f(d.maxExtraLockupVoteWeightScaledFactor)],
        ['saturation', 'Lockup needed for full bonus', cur && days(cur.lockupSaturationSecs), days(d.lockupSaturationSecs)],
        ['digitShift', 'Digit shift', cur?.digitShift?.toString(), d.digitShift.toString()],
        ['grantAuthority', 'Grant authority (can create locked deposits)', cur?.grantAuthority, d.grantAuthority ?? '(none)'],
      ]
      for (const [k, label, o, nv] of rows)
        action.changes.push({ key: `vsr.${d.registrar}.${d.idx}.${k}`, label, old: o ?? '(unknown)', new: nv, changed: (o ?? '(unknown)') !== nv, instructionIndex: ix.index })
      action.summary = `Change how ${sym} voting power is calculated in the VSR registrar ${short(d.registrar)}: unlocked factor ${f(d.baselineVoteWeightScaledFactor)}, max lockup bonus ${f(d.maxExtraLockupVoteWeightScaledFactor)}, full bonus after ${days(d.lockupSaturationSecs)}.`
      res.sensitive = true
      res.flags.configChange = true
      const grantAway = d.grantAuthority !== null && !ctx.isDao(d.grantAuthority)
      const same = cur && action.changes.every((c) => !c.changed)
      add({
        id: 'VOTING_POWER_CONFIG_CHANGE',
        severity: grantAway ? 'red' : 'yellow',
        title: grantAway ? 'Gives an outside address power to create voting power' : `Changes how ${sym} voting power is calculated`,
        explanation:
          (grantAway ? `The grant authority ${short(d.grantAuthority)} is not controlled by this DAO and could create locked deposits (= voting power) for anyone. ` : '') +
          `New values: unlocked factor ${f(d.baselineVoteWeightScaledFactor)}, max lockup bonus factor ${f(d.maxExtraLockupVoteWeightScaledFactor)}, lockup for full bonus ${days(d.lockupSaturationSecs)}, grant authority ${d.grantAuthority ? ctx.label(d.grantAuthority) : '(none)'}.` +
          (same ? ' These match the current on-chain registrar (already applied or no-op).' : cur ? '' : ' Current registrar values unknown.'),
      })
      res.actually = `changes how ${sym} voting power is calculated`
      break
    }
    case 'vsr-other':
      action.summary = `${programName}: instruction ${d.discriminator} that this UI cannot decode.`
      add({ id: 'UNKNOWN_INSTRUCTION', severity: 'yellow', title: `Unrecognised instruction to ${programName}`, explanation: `This calls the voting plugin ${short(pid)} with an instruction we cannot decode (discriminator ${d.discriminator}). It could change how votes are counted.` })
      res.sensitive = true
      break
    case 'ata-create':
      action.summary = `Create the ${ctx.symbol(d.mint)} token account ${short(d.ata)} for ${ctx.label(d.owner)} (rent paid by ${ctx.label(d.payer)}).`
      break
    case 'memo':
      action.summary = `Attach a memo: “${quoteText(d.text, 120)}”.`
      break
    case 'compute-budget':
      action.summary = 'Set compute budget (fees/limits only).'
      break
    case 'system-other':
      action.summary = `System program: ${d.name}${d.lamports !== undefined ? ` (${formatUnits(d.lamports, SOL_DECIMALS)} SOL${d.from ? ` from ${ctx.label(d.from)}` : ''})` : ''}.`
      break
    case 'token-other':
      action.summary = `Token program: ${d.name}.`
      break
    case 'unknown': {
      action.known = false
      const daoSigners = ix.accounts.filter((a) => a.isSigner && ctx.isDao(a.pubkey)).map((a) => ctx.label(a.pubkey))
      const daoWritable = ix.accounts.filter((a) => a.isWritable && ctx.isDao(a.pubkey) && !ctx.daoOwners.has(a.pubkey)).length
      const isKnownProgram = !!PROGRAM_NAMES[pid] || pid === input.realm.programId
      action.summary = isKnownProgram
        ? `${programName}: instruction we cannot decode (${d.reason}).`
        : `Unknown program ${pid} — cannot explain what this does.`
      detail('Program', pid)
      detail('Accounts', `${ix.accounts.length}`)
      if (daoSigners.length) detail('Signed by DAO', daoSigners.join(', '))
      res.sensitive = daoSigners.length > 0
      add({
        id: isKnownProgram ? 'UNKNOWN_INSTRUCTION' : 'UNKNOWN_PROGRAM',
        severity: 'yellow',
        title: isKnownProgram ? `Cannot decode instruction to ${programName}` : `Unknown program ${short(pid)} — cannot explain what this does`,
        explanation:
          (isKnownProgram ? `We know ${programName} but not this instruction (${d.reason}).` : `Program ${pid} is not one this UI can decode.`) +
          (daoSigners.length ? ` It is signed by ${daoSigners.join(', ')}` + (daoWritable ? ` and can write to ${daoWritable} DAO-owned account(s).` : '.') : '') +
          ' Ask the proposer for the program source / IDL before voting.',
      })
      res.actually = `calls ${isKnownProgram ? programName : 'an unknown program ' + short(pid)}`
      break
    }
  }
  if (!action.summary) action.summary = `${programName} instruction.`
  return res
}

// ---------------------------------------------------------------------------
// Description vs actions
// ---------------------------------------------------------------------------
const NO_CHANGE_RE = /\bno (?:parameter|param|config(?:uration)?|functional|material|behaviou?ral|logic|governance)?\s?changes?\b/i
const ROUTINE_RE = /\b(?:routine|maintenance|housekeeping|cosmetic|minor (?:fix|update|upgrade|change)s?)\b/i
const NO_FUNDS_RE = /\bno (?:funds?|tokens?|transfers?|payments?|treasury)\b/i
const CONSOLIDATE_RE = /\bconsolidat\w*/i

function sentencesMatching(text: string, re: RegExp): string[] {
  // sentences keep their terminator; simple linear regex on untrusted text
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s && re.test(s))
}

/** Extract numbers mentioned in the (untrusted) text, with k/M/B suffixes. */
function mentionedNumbers(text: string): number[] {
  const cleaned = text.replace(/\bMIP[-. ]?\d+(?:\.\d+)?/gi, ' ')
  const out: number[] = []
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|mn|million|b|bn|billion)?\b/gi
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = re.exec(cleaned)) && guard++ < 500) {
    let v = parseFloat(m[1].replace(/,/g, ''))
    const s = (m[2] || '').toLowerCase()
    if (s === 'k') v *= 1e3
    else if (s === 'm' || s === 'mm' || s === 'mn' || s === 'million') v *= 1e6
    else if (s === 'b' || s === 'bn' || s === 'billion') v *= 1e9
    if (isFinite(v)) out.push(v)
  }
  return out
}

function mentionsAmount(nums: number[], ui: number): boolean {
  if (!(ui > 0)) return false
  return nums.some((v) => Math.abs(v - ui) / ui <= 0.01 || Math.abs(v - ui) < 0.5)
}

function checkDescription(
  ctx: Ctx,
  per: IxAnalysis[],
): { check: DescriptionCheck; findings: SafetyFinding[] } {
  const p = ctx.input.proposal
  const body = p.descriptionText ?? ''
  const text = `${p.name}\n${body}`
  const findings: SafetyFinding[] = []
  const claims: string[] = []
  const actually = Array.from(new Set(per.map((x) => x.actually).filter(Boolean) as string[]))

  // quote the description body when it contains the claim, else the title
  const quoteOf = (re: RegExp) => {
    const inBody = sentencesMatching(body, re)
    return quoteText((inBody.length ? inBody : sentencesMatching(p.name, re)).join(' '), 200)
  }
  const say = (sev: Severity, claim: string, actual: string, extra = '') => {
    findings.push({
      id: 'DESCRIPTION_MISMATCH',
      severity: sev,
      title: 'The description does not match what the proposal does',
      explanation: `Description says: '${claim.replace(/[.!?\s]+$/, '')}'. Actually: ${actual}.${extra}`,
    })
  }

  // 1. "no changes" / "routine" vs config, authority or vote-counting changes
  const noChange = NO_CHANGE_RE.test(text) || ROUTINE_RE.test(text)
  if (noChange) {
    const q = quoteOf(new RegExp(`${NO_CHANGE_RE.source}|${ROUTINE_RE.source}`, 'i'))
    claims.push(q)
    const bad = per.filter((x) => x.flags.pluginReplacement || x.flags.authorityChange || x.flags.configChange)
    if (bad.length) {
      const red = bad.some((x) => x.flags.pluginReplacement || x.flags.authorityChange || x.findings.some((f) => f.severity === 'red'))
      say(red ? 'red' : 'yellow', q, bad.map((x) => x.actually).filter(Boolean).join('; '))
    }
  }

  // 2. funds move but the description names neither amount nor recipient
  const outs = per.filter((x) => x.flags.outflow)
  if (outs.length) {
    const nums = mentionedNumbers(text)
    const missing = outs.filter((x) => {
      const o = x.flags.outflow!
      const addrs = [o.destination, o.destinationOwner].filter(Boolean) as string[]
      const namesRecipient = addrs.some((a) => text.includes(a) || text.includes(a.slice(0, 6)))
      return !namesRecipient && !mentionsAmount(nums, o.uiAmount)
    })
    if (missing.length) {
      const red = missing.some((x) => x.flags.outflow!.severity === 'red')
      say(
        red ? 'red' : 'yellow',
        quoteText(body.trim() ? body : p.name, 200),
        missing.map((x) => x.actually).join('; '),
        ' The description names neither the amount nor the recipient of these transfers.',
      )
    }
    // 3. "consolidate" but destination is not DAO-owned
    if (CONSOLIDATE_RE.test(text)) {
      const q = quoteOf(CONSOLIDATE_RE)
      claims.push(q)
      const owners = Array.from(
        new Set(outs.map((x) => short(x.flags.outflow!.destinationOwner ?? x.flags.outflow!.destination))),
      )
      say(
        'red',
        q,
        `${outs.length === 1 ? 'the transfer sends' : `all ${outs.length} transfers send`} funds out of the DAO, to ${owners.length === 1 ? 'a wallet' : 'wallets'} the DAO does not control (${owners.join(', ')})`,
        ' Consolidating would move funds between DAO-owned accounts; these destinations are not owned by the DAO.',
      )
    }
    // 4. explicit "no funds/transfers" claim
    if (NO_FUNDS_RE.test(text)) {
      const q = quoteOf(NO_FUNDS_RE)
      claims.push(q)
      say('red', q, outs.map((x) => x.actually).join('; '))
    }
  }

  // 5. no description at all for a sensitive proposal
  const sensitive = per.some((x) => x.sensitive)
  if (sensitive && body.replace(/<[^>]*>/g, '').trim().length < 10 && !p.descriptionUnresolved) {
    findings.push({
      id: 'DESCRIPTION_MISMATCH',
      severity: 'yellow',
      title: 'Sensitive actions with (almost) no description',
      explanation: `This proposal ${actually.join('; ') || 'changes DAO state'} but its description is empty or a placeholder.`,
    })
  }
  return {
    check: {
      text: quoteText(body, 600),
      unresolvedLink: !!p.descriptionUnresolved,
      claims,
      actually,
      mismatch: findings.length > 0,
    },
    findings,
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function analyzeProposal(
  input: ProposalSafetyInput,
  opts: AnalyzeOptions = {},
): ProposalSafetyReport {
  const outflowRedFraction = opts.outflowRedFraction ?? 0.1
  const ctx = new Ctx(input)
  const governanceProgramIds = new Set<string>([input.realm.programId, ...Object.keys(GOVERNANCE_PROGRAMS)])
  const vsrProgramIds = new Set<string>([...Object.keys(VSR_PROGRAMS)])
  for (const p of ctx.voterWeightAddins.keys()) if (VSR_PROGRAMS[p]) vsrProgramIds.add(p)

  const ixs = [...input.instructions].sort((a, b) => a.index - b.index)
  const decoded = ixs.map((ix) =>
    decodeInstruction(ix.programId, ix.accounts, b64ToBytes(ix.dataBase64), { governanceProgramIds, vsrProgramIds }),
  )

  // executed outflows per source / per mint (to reconstruct pre-execution balances)
  const execOutflow = new Map<string, bigint>()
  const execMintOutflow = new Map<string, bigint>()
  ixs.forEach((ix, i) => {
    const d = decoded[i]
    if (!ix.executedAt) return
    if (d.type === 'token-transfer' || d.type === 'token-burn') {
      const src = d.type === 'token-transfer' ? d.source : d.account
      const dest = d.type === 'token-transfer' ? d.destination : null
      const mint = (d.type === 'token-transfer' ? d.mint : d.mint) ?? ctx.tokenInfo(src)?.mint
      execOutflow.set(src, (execOutflow.get(src) ?? ZERO) + d.amount)
      if (mint && !(dest && ctx.isDao(dest))) execMintOutflow.set(mint, (execMintOutflow.get(mint) ?? ZERO) + d.amount)
    } else if (d.type === 'sol-transfer') {
      execOutflow.set(d.from, (execOutflow.get(d.from) ?? ZERO) + d.lamports)
      if (!ctx.isDao(d.to)) execMintOutflow.set('SOL', (execMintOutflow.get('SOL') ?? ZERO) + d.lamports)
    }
  })
  if (execOutflow.size)
    ctx.notes.push('Some instructions already executed: treasury shares were computed against reconstructed pre-execution balances (current balance + executed amounts), which is approximate.')

  const per = ixs.map((ix, i) =>
    analyzeInstruction(ctx, ix, decoded[i], { outflowRedFraction }, execOutflow, execMintOutflow),
  )
  const findings: SafetyFinding[] = per.flatMap((p) => p.findings)

  // Aggregate outflows per mint when several instructions drain the same asset
  const byMint = new Map<string, { raw: bigint; decimals: number; idx: number[]; red: boolean }>()
  per.forEach((p, i) => {
    const o = p.flags.outflow
    const d = decoded[i]
    if (!o || (d.type !== 'token-transfer' && d.type !== 'sol-transfer')) return
    const mint = d.type === 'sol-transfer' ? 'SOL' : d.mint ?? ctx.tokenInfo(d.source)?.mint ?? '?'
    const e = byMint.get(mint) ?? { raw: ZERO, decimals: o.decimals, idx: [], red: false }
    e.raw += o.rawAmount
    e.idx.push(p.action.index)
    e.red = e.red || o.severity === 'red'
    byMint.set(mint, e)
  })
  for (const [mint, e] of byMint) {
    if (e.idx.length < 2) continue
    const total = ctx.holdingsByMint.get(mint)
    const tot = total !== undefined ? total + (execMintOutflow.get(mint) ?? ZERO) : undefined
    const pct = tot !== undefined ? percent(e.raw, tot) : null
    const sym = ctx.symbol(mint)
    findings.push({
      id: 'TREASURY_OUTFLOW',
      severity: e.red || (pct ?? 0) >= outflowRedFraction * 100 ? 'red' : 'yellow',
      title: `In total this proposal sends ${formatCompact(e.raw, e.decimals)} ${sym} out of the DAO`,
      explanation: `${e.idx.length} instructions (#${e.idx.map((i) => i + 1).join(', #')}) together send ${formatUnits(e.raw, e.decimals)} ${sym} out of the DAO${pct !== null ? ` — ${fmtPct(pct)} of all ${sym} held by this DAO` : ''}.`,
      instructionIndex: e.idx[0],
    })
  }

  // NO_HOLDUP: sensitive instructions that execute the moment the vote passes
  const instant = per.filter((p) => p.sensitive && (p.action.holdUpTime ?? 0) === 0)
  if (instant.length) {
    const hasRed = instant.some((p) => p.findings.some((f) => f.severity === 'red'))
    const onlyBenignOutflows = instant.every((p) => p.flags.outflow && p.flags.outflow.severity !== 'red' && !p.flags.upgrade && !p.flags.configChange && !p.flags.authorityChange && !p.flags.pluginReplacement)
    const sev: Severity = hasRed ? 'red' : onlyBenignOutflows ? 'info' : 'yellow'
    const govHold = input.governance.config?.minInstructionHoldUpTime
    findings.push({
      id: 'NO_HOLDUP',
      severity: sev,
      title: hasRed ? 'Dangerous actions execute instantly (hold-up time 0)' : 'No hold-up time',
      explanation: `Instruction${instant.length > 1 ? 's' : ''} #${instant.map((p) => p.action.index + 1).join(', #')} can be executed the moment voting ends — hold-up time is 0, so nobody has time to react (withdraw funds, alert the council) if the vote is won by an attacker.${govHold !== undefined ? ` This governance's minimum hold-up time is ${fmtDuration(govHold)}.` : ''}`,
      instructionIndex: instant[0].action.index,
    })
  }

  const desc = checkDescription(ctx, per)
  findings.push(...desc.findings)

  // order: red, yellow, info; stable within severity
  const order = (s: Severity) => (s === 'red' ? 0 : s === 'yellow' ? 1 : 2)
  findings.sort((a, b) => order(a.severity) - order(b.severity))

  const actions = per.map((p) => {
    let s: MaxSeverity = 'none'
    for (const f of findings) if (f.instructionIndex === p.action.index && f.id !== 'NO_HOLDUP' && f.id !== 'DESCRIPTION_MISMATCH') s = maxSev(s, f.severity)
    return { ...p.action, severity: s }
  })
  let maxSeverity: MaxSeverity = 'none'
  for (const f of findings) maxSeverity = maxSev(maxSeverity, f.severity)

  if (input.proposal.descriptionUnresolved)
    ctx.notes.push('The description is a link that could not be fetched; description checks used the link text only.')

  return {
    actions,
    findings,
    maxSeverity,
    changes: actions.flatMap((a) => a.changes),
    description: desc.check,
    notes: ctx.notes,
    engineVersion: ENGINE_VERSION,
  }
}
