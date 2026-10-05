/**
 * Instruction decoders. Pure functions: (programId, accounts, data) -> structured meaning.
 *
 * Layout sources (do not change without re-checking):
 * - SPL Token: spl-token program `instruction.rs` (tags 3 Transfer, 4 Approve, 6 SetAuthority,
 *   7 MintTo, 8 Burn, 9 CloseAccount, 12 TransferChecked, 14 MintToChecked, 15 BurnChecked);
 *   cross-checked by tests against @solana/spl-token 0.1.8 builders.
 * - BPF Upgradeable Loader: anza solana-sdk loader-v3-interface/src/instruction.rs,
 *   bincode u32 LE tag (3 Upgrade, 4 SetAuthority, 5 Close, 6 ExtendProgram, 7 SetAuthorityChecked);
 *   matches tools/sdk/bpfUpgradeableLoader/*.ts in this repo.
 * - System: u32 LE tag, 2 = Transfer { lamports: u64 } (cross-checked vs web3.js SystemProgram.transfer).
 * - spl-governance: enum GovernanceInstruction in @solana/spl-governance 0.3.28
 *   (19 SetGovernanceConfig, 21 SetRealmAuthority, 22 SetRealmConfig), borsh schema in
 *   lib/governance/serialisation.js; cross-checked by tests against the SDK serializers.
 * - VSR configure_voting_mint: VoteStakeRegistry/sdk/voter_stake_registry.ts IDL
 *   (idx u16, digit_shift i8, baseline u64, max_extra u64, lockup_saturation_secs u64,
 *   grant_authority Option<Pubkey>), anchor discriminator 71998decb809870f.
 */
import {
  AccountMetaInput,
  GovernanceConfigInput,
  VoteThresholdInput,
} from './types'
import {
  ATA_PROGRAM,
  BPF_UPGRADEABLE_LOADER,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
  MEMO_PROGRAM_V1,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VSR_CONFIGURE_VOTING_MINT_DISC,
} from './constants'
import { readPubkey, readU64 } from './util'

export type TokenAuthorityType =
  | 'MintTokens'
  | 'FreezeAccount'
  | 'AccountOwner'
  | 'CloseAccount'
  | string

export interface TokenConfigDecoded {
  useVoterWeightAddin: boolean
  useMaxVoterWeightAddin: boolean
  tokenType: string
  voterWeightAddin: string | null
  maxVoterWeightAddin: string | null
}

export type Decoded =
  | {
      type: 'token-transfer'
      checked: boolean
      source: string
      destination: string
      authority: string
      mint?: string
      amount: bigint
      decimals?: number
    }
  | {
      type: 'token-approve'
      source: string
      delegate: string
      owner: string
      amount: bigint
    }
  | {
      type: 'token-set-authority'
      account: string
      currentAuthority: string
      authorityType: TokenAuthorityType
      newAuthority: string | null
    }
  | { type: 'token-close'; account: string; destination: string; owner: string }
  | {
      type: 'token-mint-to'
      mint: string
      destination: string
      authority: string
      amount: bigint
    }
  | {
      type: 'token-burn'
      account: string
      mint: string
      owner: string
      amount: bigint
    }
  | { type: 'token-other'; name: string }
  | { type: 'sol-transfer'; from: string; to: string; lamports: bigint }
  | { type: 'system-other'; name: string; from?: string; lamports?: bigint }
  | {
      type: 'bpf-upgrade'
      programData: string
      program: string
      buffer: string
      spill: string
      authority: string
    }
  | {
      type: 'bpf-set-authority'
      checked: boolean
      target: string
      currentAuthority: string
      newAuthority: string | null
    }
  | {
      type: 'bpf-close'
      target: string
      recipient: string
      authority?: string
      program?: string
    }
  | { type: 'bpf-extend'; programData: string; program: string; additionalBytes: number }
  | { type: 'bpf-other'; name: string }
  | {
      type: 'gov-set-governance-config'
      governance: string
      config: GovernanceConfigInput
    }
  | {
      type: 'gov-set-realm-config'
      realm: string
      realmAuthority: string
      useCouncilMint: boolean
      councilMint: string | null
      minCommunityTokensToCreateGovernance: bigint
      maxVoteWeightSource: { type: string; value: bigint }
      community: TokenConfigDecoded | null
      council: TokenConfigDecoded | null
      layoutVersion: 1 | 2 | 3
    }
  | {
      type: 'gov-set-realm-authority'
      realm: string
      realmAuthority: string
      action: 'SetUnchecked' | 'SetChecked' | 'Remove' | string
      newAuthority: string | null
    }
  | { type: 'gov-other'; name: string; ordinal: number }
  | {
      type: 'vsr-configure-voting-mint'
      registrar: string
      realmAuthority: string
      mint: string
      idx: number
      digitShift: number
      baselineVoteWeightScaledFactor: bigint
      maxExtraLockupVoteWeightScaledFactor: bigint
      lockupSaturationSecs: bigint
      grantAuthority: string | null
    }
  | { type: 'vsr-other'; discriminator: string }
  | { type: 'ata-create'; payer: string; ata: string; owner: string; mint: string; idempotent: boolean }
  | { type: 'memo'; text: string }
  | { type: 'compute-budget' }
  | { type: 'unknown'; reason: string }

const acc = (accounts: AccountMetaInput[], i: number): string => {
  const a = accounts[i]
  if (!a) throw new Error(`missing account #${i}`)
  return a.pubkey
}

// ---------------------------------------------------------------------------
// SPL Token (+ Token-2022, same tags for these instructions)
// ---------------------------------------------------------------------------
const TOKEN_AUTHORITY_TYPES = ['MintTokens', 'FreezeAccount', 'AccountOwner', 'CloseAccount']

export function decodeSplToken(accounts: AccountMetaInput[], data: Buffer): Decoded {
  if (data.length < 1) return { type: 'unknown', reason: 'empty token instruction' }
  const tag = data[0]
  switch (tag) {
    case 3:
      return {
        type: 'token-transfer',
        checked: false,
        source: acc(accounts, 0),
        destination: acc(accounts, 1),
        authority: acc(accounts, 2),
        amount: readU64(data, 1),
      }
    case 12:
      return {
        type: 'token-transfer',
        checked: true,
        source: acc(accounts, 0),
        mint: acc(accounts, 1),
        destination: acc(accounts, 2),
        authority: acc(accounts, 3),
        amount: readU64(data, 1),
        decimals: data[9],
      }
    case 4:
      return {
        type: 'token-approve',
        source: acc(accounts, 0),
        delegate: acc(accounts, 1),
        owner: acc(accounts, 2),
        amount: readU64(data, 1),
      }
    case 6: {
      const t = data[1]
      const hasNew = data[2] === 1
      return {
        type: 'token-set-authority',
        account: acc(accounts, 0),
        currentAuthority: acc(accounts, 1),
        authorityType: TOKEN_AUTHORITY_TYPES[t] ?? `type ${t}`,
        newAuthority: hasNew ? readPubkey(data, 3) : null,
      }
    }
    case 7:
    case 14:
      return {
        type: 'token-mint-to',
        mint: acc(accounts, 0),
        destination: acc(accounts, 1),
        authority: acc(accounts, 2),
        amount: readU64(data, 1),
      }
    case 8:
    case 15:
      return {
        type: 'token-burn',
        account: acc(accounts, 0),
        mint: acc(accounts, 1),
        owner: acc(accounts, 2),
        amount: readU64(data, 1),
      }
    case 9:
      return {
        type: 'token-close',
        account: acc(accounts, 0),
        destination: acc(accounts, 1),
        owner: acc(accounts, 2),
      }
    case 1:
    case 16:
    case 18:
      return { type: 'token-other', name: 'Initialize token account' }
    case 17:
      return { type: 'token-other', name: 'Sync native SOL balance' }
    case 5:
      return { type: 'token-other', name: 'Revoke delegate' }
    case 10:
      return { type: 'token-other', name: 'Freeze token account' }
    case 11:
      return { type: 'token-other', name: 'Thaw token account' }
    default:
      return { type: 'unknown', reason: `token instruction tag ${tag}` }
  }
}

// ---------------------------------------------------------------------------
// System program
// ---------------------------------------------------------------------------
const SYSTEM_NAMES = [
  'Create account',
  'Assign account to program',
  'Transfer SOL',
  'Create account with seed',
  'Advance nonce',
  'Withdraw from nonce account',
  'Initialize nonce account',
  'Authorize nonce account',
  'Allocate account space',
  'Allocate account space with seed',
  'Assign with seed',
  'Transfer SOL with seed',
  'Upgrade nonce account',
]

export function decodeSystem(accounts: AccountMetaInput[], data: Buffer): Decoded {
  if (data.length < 4) return { type: 'unknown', reason: 'short system instruction' }
  const tag = data.readUInt32LE(0)
  if (tag === 2) {
    return {
      type: 'sol-transfer',
      from: acc(accounts, 0),
      to: acc(accounts, 1),
      lamports: readU64(data, 4),
    }
  }
  if (tag === 0 && data.length >= 12) {
    return { type: 'system-other', name: SYSTEM_NAMES[0], from: acc(accounts, 0), lamports: readU64(data, 4) }
  }
  if (tag === 11 && data.length >= 12) {
    // TransferWithSeed: accounts [from, base, to]
    return {
      type: 'system-other',
      name: SYSTEM_NAMES[11],
      from: acc(accounts, 0),
      lamports: readU64(data, 4),
    }
  }
  if (tag < SYSTEM_NAMES.length) return { type: 'system-other', name: SYSTEM_NAMES[tag] }
  return { type: 'unknown', reason: `system instruction tag ${tag}` }
}

// ---------------------------------------------------------------------------
// BPF Upgradeable Loader
// ---------------------------------------------------------------------------
const BPF_NAMES = [
  'Initialize buffer',
  'Write to buffer',
  'Deploy program',
  'Upgrade program',
  'Set upgrade authority',
  'Close account',
  'Extend program',
  'Set upgrade authority (checked)',
  'Migrate program',
  'Extend program (checked)',
]

export function decodeBpfLoader(accounts: AccountMetaInput[], data: Buffer): Decoded {
  if (data.length < 4) return { type: 'unknown', reason: 'short loader instruction' }
  const tag = data.readUInt32LE(0)
  switch (tag) {
    case 3:
      return {
        type: 'bpf-upgrade',
        programData: acc(accounts, 0),
        program: acc(accounts, 1),
        buffer: acc(accounts, 2),
        spill: acc(accounts, 3),
        authority: acc(accounts, 6),
      }
    case 4:
      return {
        type: 'bpf-set-authority',
        checked: false,
        target: acc(accounts, 0),
        currentAuthority: acc(accounts, 1),
        newAuthority: accounts[2]?.pubkey ?? null,
      }
    case 7:
      return {
        type: 'bpf-set-authority',
        checked: true,
        target: acc(accounts, 0),
        currentAuthority: acc(accounts, 1),
        newAuthority: acc(accounts, 2),
      }
    case 5:
      return {
        type: 'bpf-close',
        target: acc(accounts, 0),
        recipient: acc(accounts, 1),
        authority: accounts[2]?.pubkey,
        program: accounts[3]?.pubkey,
      }
    case 6:
      return {
        type: 'bpf-extend',
        programData: acc(accounts, 0),
        program: acc(accounts, 1),
        additionalBytes: data.length >= 8 ? data.readUInt32LE(4) : 0,
      }
    default:
      if (tag < BPF_NAMES.length) return { type: 'bpf-other', name: BPF_NAMES[tag] }
      return { type: 'unknown', reason: `loader instruction tag ${tag}` }
  }
}

// ---------------------------------------------------------------------------
// spl-governance
// ---------------------------------------------------------------------------
/** GovernanceInstruction enum, @solana/spl-governance 0.3.28 lib/governance/instructions.d.ts */
export const GOVERNANCE_INSTRUCTION_NAMES = [
  'CreateRealm',
  'DepositGoverningTokens',
  'WithdrawGoverningTokens',
  'SetGovernanceDelegate',
  'CreateGovernance',
  'CreateProgramGovernance',
  'CreateProposal',
  'AddSignatory',
  'RemoveSignatory',
  'InsertTransaction',
  'RemoveTransaction',
  'CancelProposal',
  'SignOffProposal',
  'CastVote',
  'FinalizeVote',
  'RelinquishVote',
  'ExecuteTransaction',
  'CreateMintGovernance',
  'CreateTokenGovernance',
  'SetGovernanceConfig',
  'FlagTransactionError',
  'SetRealmAuthority',
  'SetRealmConfig',
  'CreateTokenOwnerRecord',
  'UpdateProgramMetadata',
  'CreateNativeTreasury',
  'RevokeGoverningTokens',
  'RefundProposalDeposit',
]

const VOTE_THRESHOLD_TYPES: VoteThresholdInput['type'][] = [
  'YesVotePercentage',
  'QuorumPercentage',
  'Disabled',
]
export const VOTE_TIPPING = ['Strict', 'Early', 'Disabled']
export const GOVERNING_TOKEN_TYPES = ['Liquid', 'Membership', 'Dormant']
const MAX_VOTE_WEIGHT_SOURCE_TYPES = ['SupplyFraction', 'Absolute']
const REALM_AUTHORITY_ACTIONS = ['SetUnchecked', 'SetChecked', 'Remove']

class Reader {
  o = 0
  constructor(public b: Buffer) {}
  u8() {
    if (this.o + 1 > this.b.length) throw new Error('eof')
    return this.b[this.o++]
  }
  i8() {
    if (this.o + 1 > this.b.length) throw new Error('eof')
    const v = this.b.readInt8(this.o)
    this.o += 1
    return v
  }
  u16() {
    if (this.o + 2 > this.b.length) throw new Error('eof')
    const v = this.b.readUInt16LE(this.o)
    this.o += 2
    return v
  }
  u32() {
    if (this.o + 4 > this.b.length) throw new Error('eof')
    const v = this.b.readUInt32LE(this.o)
    this.o += 4
    return v
  }
  u64() {
    const v = readU64(this.b, this.o)
    this.o += 8
    return v
  }
  pubkey() {
    const v = readPubkey(this.b, this.o)
    this.o += 32
    return v
  }
  remaining() {
    return this.b.length - this.o
  }
  voteThreshold(): VoteThresholdInput {
    const t = this.u8()
    const type = VOTE_THRESHOLD_TYPES[t]
    if (!type) throw new Error(`VoteThresholdType ${t}`)
    if (type === 'Disabled') return { type }
    return { type, value: this.u8() }
  }
}

export function decodeGovernanceConfig(r: Reader): GovernanceConfigInput {
  const cfg: GovernanceConfigInput = {
    communityVoteThreshold: r.voteThreshold(),
    minCommunityTokensToCreateProposal: r.u64().toString(),
    minInstructionHoldUpTime: r.u32(),
    baseVotingTime: r.u32(),
    communityVoteTipping: VOTE_TIPPING[r.u8()] ?? 'unknown',
    councilVoteThreshold: r.voteThreshold(),
    councilVetoVoteThreshold: r.voteThreshold(),
    minCouncilTokensToCreateProposal: r.u64().toString(),
  }
  // V3 fields (councilVoteTipping, communityVetoVoteThreshold, votingCoolOffTime, depositExemptProposalCount)
  if (r.remaining() > 0) {
    cfg.councilVoteTipping = VOTE_TIPPING[r.u8()] ?? 'unknown'
    cfg.communityVetoVoteThreshold = r.voteThreshold()
    cfg.votingCoolOffTime = r.u32()
    cfg.depositExemptProposalCount = r.u8()
  }
  return cfg
}

function readTokenConfigArgs(r: Reader) {
  return {
    useVoterWeightAddin: r.u8() !== 0,
    useMaxVoterWeightAddin: r.u8() !== 0,
    tokenType: GOVERNING_TOKEN_TYPES[r.u8()] ?? 'unknown',
  }
}

export function decodeGovernance(accounts: AccountMetaInput[], data: Buffer): Decoded {
  if (data.length < 1) return { type: 'unknown', reason: 'empty governance instruction' }
  const tag = data[0]
  const r = new Reader(data)
  r.u8()
  if (tag === 19) {
    return {
      type: 'gov-set-governance-config',
      governance: acc(accounts, 0),
      config: decodeGovernanceConfig(r),
    }
  }
  if (tag === 21) {
    // V1: Option<Pubkey> new authority (no 3rd account). V2+: u8 action, accounts [realm, authority, new authority?]
    // Ambiguity: V1 None == [21, 0] with only 2 accounts; V2 SetUnchecked == [21, 0] with 3 accounts.
    if (data.length === 2 && !(data[1] === 0 && accounts.length < 3)) {
      const action = REALM_AUTHORITY_ACTIONS[data[1]] ?? `action ${data[1]}`
      return {
        type: 'gov-set-realm-authority',
        realm: acc(accounts, 0),
        realmAuthority: acc(accounts, 1),
        action,
        newAuthority: action === 'Remove' ? null : accounts[2]?.pubkey ?? null,
      }
    }
    const has = data[1] === 1
    return {
      type: 'gov-set-realm-authority',
      realm: acc(accounts, 0),
      realmAuthority: acc(accounts, 1),
      action: has ? 'SetUnchecked' : 'Remove',
      newAuthority: has ? readPubkey(data, 2) : null,
    }
  }
  if (tag === 22) {
    // RealmConfigArgs: useCouncilMint u8, minCommunityTokensToCreateGovernance u64,
    // communityMintMaxVoteWeightSource {u8 type, u64 value}, then
    //   V2: useCommunityVoterWeightAddin u8, useMaxCommunityVoterWeightAddin u8
    //   V3: communityTokenConfigArgs {u8,u8,u8}, councilTokenConfigArgs {u8,u8,u8}
    const useCouncilMint = r.u8() !== 0
    const minCommunity = r.u64()
    const srcType = r.u8()
    const srcValue = r.u64()
    const rest = r.remaining()
    let layoutVersion: 1 | 2 | 3 = 1
    let community: TokenConfigDecoded | null = null
    let council: TokenConfigDecoded | null = null
    if (rest >= 6) {
      layoutVersion = 3
      const c = readTokenConfigArgs(r)
      const k = readTokenConfigArgs(r)
      community = { ...c, voterWeightAddin: null, maxVoterWeightAddin: null }
      council = { ...k, voterWeightAddin: null, maxVoterWeightAddin: null }
    } else if (rest >= 2) {
      layoutVersion = 2
      community = {
        useVoterWeightAddin: r.u8() !== 0,
        useMaxVoterWeightAddin: r.u8() !== 0,
        tokenType: 'Liquid',
        voterWeightAddin: null,
        maxVoterWeightAddin: null,
      }
    }
    // Accounts: 0 realm, 1 realm authority, [2 council mint, 3 council holding] if useCouncilMint,
    // then (V2+) system program, realm config, community addin?, community max addin?,
    // council addin?, council max addin?, payer?  (spl-governance withSetRealmConfig + process_set_realm_config)
    let i = 2
    let councilMint: string | null = null
    if (useCouncilMint) {
      councilMint = accounts[2]?.pubkey ?? null
      i = 4
    }
    if (layoutVersion >= 2) {
      i += 2 // system program, realm config
      const take = () => {
        const a = accounts[i]?.pubkey ?? null
        i += 1
        return a
      }
      if (community) {
        if (community.useVoterWeightAddin) community.voterWeightAddin = take()
        if (community.useMaxVoterWeightAddin) community.maxVoterWeightAddin = take()
      }
      if (council) {
        if (council.useVoterWeightAddin) council.voterWeightAddin = take()
        if (council.useMaxVoterWeightAddin) council.maxVoterWeightAddin = take()
      }
    }
    return {
      type: 'gov-set-realm-config',
      realm: acc(accounts, 0),
      realmAuthority: acc(accounts, 1),
      useCouncilMint,
      councilMint,
      minCommunityTokensToCreateGovernance: minCommunity,
      maxVoteWeightSource: {
        type: MAX_VOTE_WEIGHT_SOURCE_TYPES[srcType] ?? `type ${srcType}`,
        value: srcValue,
      },
      community,
      council,
      layoutVersion,
    }
  }
  const name = GOVERNANCE_INSTRUCTION_NAMES[tag]
  if (name) return { type: 'gov-other', name, ordinal: tag }
  return { type: 'unknown', reason: `governance instruction ${tag}` }
}

// ---------------------------------------------------------------------------
// VSR
// ---------------------------------------------------------------------------
export function decodeVsr(accounts: AccountMetaInput[], data: Buffer): Decoded {
  const disc = data.subarray(0, 8).toString('hex')
  if (disc !== VSR_CONFIGURE_VOTING_MINT_DISC) return { type: 'vsr-other', discriminator: disc }
  const r = new Reader(data)
  r.o = 8
  const idx = r.u16()
  const digitShift = r.i8()
  const baseline = r.u64()
  const maxExtra = r.u64()
  const saturation = r.u64()
  const hasGrant = r.u8() === 1
  const grantAuthority = hasGrant ? r.pubkey() : null
  return {
    type: 'vsr-configure-voting-mint',
    registrar: acc(accounts, 0),
    realmAuthority: acc(accounts, 1),
    mint: acc(accounts, 2),
    idx,
    digitShift,
    baselineVoteWeightScaledFactor: baseline,
    maxExtraLockupVoteWeightScaledFactor: maxExtra,
    lockupSaturationSecs: saturation,
    grantAuthority,
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export interface DecodeContext {
  governanceProgramIds: Set<string>
  vsrProgramIds: Set<string>
}

export function decodeInstruction(
  programId: string,
  accounts: AccountMetaInput[],
  data: Buffer,
  ctx: DecodeContext,
): Decoded {
  try {
    if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM)
      return decodeSplToken(accounts, data)
    if (programId === SYSTEM_PROGRAM) return decodeSystem(accounts, data)
    if (programId === BPF_UPGRADEABLE_LOADER) return decodeBpfLoader(accounts, data)
    if (ctx.governanceProgramIds.has(programId)) return decodeGovernance(accounts, data)
    if (ctx.vsrProgramIds.has(programId)) return decodeVsr(accounts, data)
    if (programId === ATA_PROGRAM) {
      return {
        type: 'ata-create',
        payer: acc(accounts, 0),
        ata: acc(accounts, 1),
        owner: acc(accounts, 2),
        mint: acc(accounts, 3),
        idempotent: data[0] === 1,
      }
    }
    if (programId === MEMO_PROGRAM || programId === MEMO_PROGRAM_V1)
      return { type: 'memo', text: data.toString('utf8') }
    if (programId === COMPUTE_BUDGET_PROGRAM) return { type: 'compute-budget' }
    return { type: 'unknown', reason: 'unknown program' }
  } catch (e) {
    return { type: 'unknown', reason: `could not decode: ${(e as Error).message}` }
  }
}
