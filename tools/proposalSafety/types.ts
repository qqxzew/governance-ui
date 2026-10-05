/**
 * Proposal safety engine ("what this proposal really does") — data types.
 *
 * Everything in ProposalSafetyInput is plain JSON (base58 strings, base64
 * instruction data, decimal-string amounts) so that fixtures are just JSON
 * files and analyzeProposal() is pure and deterministic.
 *
 * Unaudited, evaluation-grade.
 */

export type Severity = 'red' | 'yellow' | 'info'
export type MaxSeverity = Severity | 'none'

export type FindingId =
  | 'TREASURY_OUTFLOW'
  | 'VOTER_WEIGHT_PLUGIN_REPLACEMENT'
  | 'VOTING_POWER_CONFIG_CHANGE'
  | 'AUTHORITY_CHANGE'
  | 'PROGRAM_UPGRADE'
  | 'GOVERNANCE_CONFIG_CHANGE'
  | 'REALM_CONFIG_CHANGE'
  | 'NO_HOLDUP'
  | 'DESCRIPTION_MISMATCH'
  | 'UNKNOWN_PROGRAM'
  | 'UNKNOWN_INSTRUCTION'
  | 'INTERNAL_TRANSFER'

/** Public contract (CLAUDE.md). Extra optional fields are additive. */
export interface SafetyFinding {
  id: FindingId | string
  severity: Severity
  title: string
  explanation: string
  instructionIndex?: number
}

export interface ConfigChange {
  /** machine key, e.g. 'realm.communityVoterWeightAddin' */
  key: string
  /** human label, e.g. 'Community voter-weight plugin' */
  label: string
  old: string
  new: string
  changed: boolean
  instructionIndex: number
}

export interface DecodedAction {
  /** global instruction index across the whole proposal (0-based) */
  index: number
  txIndex: number
  ixIndexInTx: number
  optionIndex: number
  holdUpTime: number
  executed: boolean
  programId: string
  programName: string
  /** machine kind, e.g. 'spl-token.transfer', 'bpf-loader.upgrade', 'unknown' */
  kind: string
  /** true if we know how to explain this instruction */
  known: boolean
  /** plain-language one-liner */
  summary: string
  /** key facts shown under the summary */
  details: { label: string; value: string }[]
  changes: ConfigChange[]
  /** worst finding attached to this instruction */
  severity: MaxSeverity
}

export interface DescriptionCheck {
  /** the (untrusted) text we compared, truncated */
  text: string
  /** true if text was only a link we could not resolve */
  unresolvedLink: boolean
  /** short statements of what the description claims (quoted, truncated) */
  claims: string[]
  /** short statements of what the actions actually do */
  actually: string[]
  mismatch: boolean
}

export interface ProposalSafetyReport {
  actions: DecodedAction[]
  findings: SafetyFinding[]
  maxSeverity: MaxSeverity
  /** aggregated "What changes" diff across all instructions */
  changes: ConfigChange[]
  description: DescriptionCheck
  /** caveats about the input (stale balances, missing data, ...) */
  notes: string[]
  engineVersion: string
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface AccountMetaInput {
  pubkey: string
  isSigner: boolean
  isWritable: boolean
}

export interface InstructionInput {
  /** global index across the proposal */
  index: number
  /** ProposalTransaction.instructionIndex */
  txIndex: number
  /** position inside that transaction */
  ixIndexInTx: number
  optionIndex: number
  /** seconds */
  holdUpTime: number
  /** unix seconds or null */
  executedAt: number | null
  programId: string
  accounts: AccountMetaInput[]
  dataBase64: string
}

export interface VoteThresholdInput {
  type: 'YesVotePercentage' | 'QuorumPercentage' | 'Disabled'
  value?: number
}

export interface GovernanceConfigInput {
  communityVoteThreshold: VoteThresholdInput
  minCommunityTokensToCreateProposal: string
  minInstructionHoldUpTime: number
  baseVotingTime: number
  communityVoteTipping: string
  councilVoteThreshold: VoteThresholdInput
  councilVetoVoteThreshold: VoteThresholdInput
  minCouncilTokensToCreateProposal: string
  councilVoteTipping?: string
  communityVetoVoteThreshold?: VoteThresholdInput
  votingCoolOffTime?: number
  depositExemptProposalCount?: number
}

export interface GovernanceInput {
  pubkey: string
  /** e.g. 'GovernanceV2', 'ProgramGovernanceV2' */
  accountType: string
  /** governed account (program id for ProgramGovernance) */
  governedAccount: string
  nativeTreasury: string
  nativeTreasuryLamports?: string
  config?: GovernanceConfigInput
}

export interface TokenAccountInput {
  address: string
  /** token-account owner (authority) */
  owner: string
  mint: string
  /** raw amount, decimal string */
  amount: string
  decimals: number
  symbol?: string
}

export interface KnownPayeeInput {
  /** destination address that received funds (token account or wallet) */
  address: string
  /** owner of the destination token account, if known */
  owner?: string
  /** proposal that paid it */
  proposal: string
  /** unix seconds the paying transaction executed */
  executedAt?: number
  mint?: string
}

export interface ProgramInfoInput {
  programData?: string
  /** current upgrade authority; null = immutable */
  upgradeAuthority: string | null
  /** DAO governance that controls it (if any) */
  governedBy?: string
  name?: string
}

export interface BufferInfoInput {
  exists: boolean
  authority: string | null
  /** program bytes in the buffer (account size minus 37-byte header) */
  dataLen: number
}

export interface AccountInfoInput {
  /** 'token' = SPL token account, 'mint', 'program', 'programdata', 'buffer', 'wallet' (system-owned), 'other', 'missing' */
  kind:
    | 'token'
    | 'mint'
    | 'program'
    | 'programdata'
    | 'buffer'
    | 'wallet'
    | 'other'
    | 'missing'
  /** owning program of the account */
  programOwner?: string
  /** token accounts: token owner; buffers/programdata: authority */
  owner?: string | null
  mint?: string
  amount?: string
  decimals?: number
  lamports?: string
}

export interface VsrVotingMintInput {
  mint: string
  grantAuthority: string
  baselineVoteWeightScaledFactor: string
  maxExtraLockupVoteWeightScaledFactor: string
  lockupSaturationSecs: string
  digitShift: number
}

export interface ProposalSafetyInput {
  version: 1
  /** ISO time the input was assembled */
  snapshotAt?: string
  cluster?: string
  proposal: {
    pubkey: string
    name: string
    /** raw descriptionLink as stored on chain */
    descriptionLink: string
    /** resolved description text (= descriptionLink when it is plain text) */
    descriptionText: string
    /** true when descriptionLink is a URL that could not be fetched */
    descriptionUnresolved?: boolean
    state: string
    governance: string
    tokenOwnerRecord?: string
    governingTokenMint?: string
    draftAt?: number | null
    votingAt?: number | null
  }
  governance: GovernanceInput
  realm: {
    pubkey: string
    name: string
    programId: string
    programVersion?: number
    communityMint: string
    councilMint: string | null
    authority: string | null
    minCommunityTokensToCreateGovernance?: string
    communityMintMaxVoteWeightSource?: { type: string; value: string }
  }
  realmConfig: {
    pubkey: string
    communityVoterWeightAddin: string | null
    communityMaxVoterWeightAddin: string | null
    councilVoterWeightAddin: string | null
    councilMaxVoterWeightAddin: string | null
    communityTokenType?: string
    councilTokenType?: string
  }
  instructions: InstructionInput[]
  treasury: {
    governances: GovernanceInput[]
    tokenAccounts: TokenAccountInput[]
  }
  mints: Record<string, { decimals: number; symbol?: string }>
  knownPayees: KnownPayeeInput[]
  /** how complete the payment-history scan behind knownPayees is (absent in older fixtures = 'complete') */
  knownPayeesStatus?: 'complete' | 'partial' | 'not-loaded'
  /** human-readable description of the scanned history, e.g. "last 1000 treasury transactions" */
  knownPayeesScope?: string
  /** program id -> info (programs referenced by the proposal + DAO-governed programs) */
  programs: Record<string, ProgramInfoInput>
  /** upgrade buffers referenced by the proposal */
  buffers: Record<string, BufferInfoInput>
  /** every account referenced by the proposal's instructions */
  accounts: Record<string, AccountInfoInput>
  /** VSR registrar accounts referenced by the proposal */
  vsrRegistrars?: Record<string, { votingMints: VsrVotingMintInput[] }>
}

export interface AnalyzeOptions {
  /** fraction of a treasury account / of all DAO holdings of a mint that makes an outflow red */
  outflowRedFraction?: number
  /**
   * Optional LLM phrasing hook. NOT used yet (rules are authoritative);
   * reserved so the UI/bot can later re-phrase findings.
   */
  phrase?: (finding: SafetyFinding) => Promise<string>
}
