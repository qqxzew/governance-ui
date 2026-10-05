/**
 * Pure TypeScript port of the voter-stake-registry (VSR) voting power math, as deployed by Marinade
 * (program VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS).
 *
 * Source of truth: github.com/marinade-finance/voter-stake-registry, branch `governance-v3.1.0-marinade`
 * (HEAD 2515cba7eb5a "[create_voter] removing check for CPI calls with errors", 2023-12-29),
 * directory programs/voter-stake-registry/src/. Every function below cites the Rust function it ports.
 *
 * Rules:
 *  - Integer math only (BN). Rust `u64`/`i64`/`u128` checked ops that `unwrap()` (panic) or return an
 *    error are mirrored by throwing `VsrMathError`, so a voter the program would reject is never given a
 *    silently-wrong number.
 *  - No RPC, no React. Safe to import from UI, scripts and tests.
 *  - Verified bit-exact against the deployed program: tools/vsr/__tests__/votingPower.test.ts
 *    (fixtures in fixtures/marinade/vsr/, ground truth from simulated update_voter_weight_record).
 */
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'

export class VsrMathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VsrMathError'
  }
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** state/lockup.rs `SECS_PER_DAY` */
export const SECS_PER_DAY = new BN(86_400)
/** state/lockup.rs `SECS_PER_MONTH = 365 * SECS_PER_DAY / 12` (= 2_628_000, i.e. 30.4166 days) */
export const SECS_PER_MONTH = new BN(365 * 86_400).divn(12)
/** state/voting_mint_config.rs `SCALED_FACTOR_BASE` */
export const SCALED_FACTOR_BASE = new BN(1_000_000_000)

const ZERO = new BN(0)
const ONE = new BN(1)
const U64_MAX = new BN(1).shln(64).subn(1)
const I64_MAX = new BN(1).shln(63).subn(1)
const I64_MIN = new BN(1).shln(63).neg()

function assertU64(v: BN, what: string): BN {
  if (v.isNeg() || v.gt(U64_MAX))
    throw new VsrMathError(`${what}: u64 overflow (${v.toString()})`)
  return v
}
function assertI64(v: BN, what: string): BN {
  if (v.lt(I64_MIN) || v.gt(I64_MAX))
    throw new VsrMathError(`${what}: i64 overflow (${v.toString()})`)
  return v
}
/** u64::checked_sub(..).unwrap() */
function subU64(a: BN, b: BN, what: string): BN {
  if (a.lt(b)) throw new VsrMathError(`${what}: u64 underflow`)
  return a.sub(b)
}
/** u64::saturating_sub */
function satSub(a: BN, b: BN): BN {
  return a.lt(b) ? ZERO : a.sub(b)
}
const minBN = (a: BN, b: BN) => (a.lt(b) ? a : b)

// ---------------------------------------------------------------------------------------------
// Account types (field names follow the Rust structs; layout in the decoders below)
// ---------------------------------------------------------------------------------------------

/** state/lockup.rs `enum LockupKind` (#[repr(u8)]) */
export enum LockupKind {
  None = 0,
  Daily = 1,
  Monthly = 2,
  Cliff = 3,
  Constant = 4,
}
export const LOCKUP_KIND_NAMES: Record<LockupKind, string> = {
  [LockupKind.None]: 'None',
  [LockupKind.Daily]: 'Daily vesting',
  [LockupKind.Monthly]: 'Monthly vesting',
  [LockupKind.Cliff]: 'Cliff',
  [LockupKind.Constant]: 'Constant',
}

/** state/lockup.rs `struct Lockup` (32 bytes) */
export interface VsrLockup {
  startTs: BN // i64
  endTs: BN // i64
  kind: LockupKind
}

/** state/deposit_entry.rs `struct DepositEntry` (80 bytes) */
export interface VsrDepositEntry {
  lockup: VsrLockup
  amountDepositedNative: BN // u64
  amountInitiallyLockedNative: BN // u64
  isUsed: boolean
  allowClawback: boolean
  votingMintConfigIdx: number // u8
}

/** state/voting_mint_config.rs `struct VotingMintConfig` (152 bytes) */
export interface VsrVotingMintConfig {
  mint: PublicKey
  grantAuthority: PublicKey
  baselineVoteWeightScaledFactor: BN // u64
  maxExtraLockupVoteWeightScaledFactor: BN // u64
  lockupSaturationSecs: BN // u64
  digitShift: number // i8
}

/** state/registrar.rs `struct Registrar` (#[account(zero_copy)], 8 + 872 bytes) */
export interface VsrRegistrar {
  governanceProgramId: PublicKey
  realm: PublicKey
  realmGoverningTokenMint: PublicKey
  realmAuthority: PublicKey
  votingMints: VsrVotingMintConfig[] // always 4 entries; unused ones have mint == default pubkey
  timeOffset: BN // i64
  bump: number
}

/** state/voter.rs `struct Voter` (#[account(zero_copy)], 8 + 2720 bytes) */
export interface VsrVoter {
  voterAuthority: PublicKey
  registrar: PublicKey
  deposits: VsrDepositEntry[] // always 32 entries; check isUsed
  voterBump: number
  voterWeightRecordBump: number
}

// ---------------------------------------------------------------------------------------------
// Decoders (zero-copy, little endian, repr(C) layouts with the const_asserts from the Rust source)
// ---------------------------------------------------------------------------------------------

/** sha256("account:Registrar")[0..8] (anchor account discriminator) */
export const REGISTRAR_DISCRIMINATOR = Buffer.from([
  193, 202, 205, 51, 78, 168, 150, 128,
])
/** sha256("account:Voter")[0..8] */
export const VOTER_DISCRIMINATOR = Buffer.from([
  241, 93, 35, 191, 254, 147, 17, 202,
])
/** sha256("account:VoterWeightRecord")[0..8] (spl_governance_addin_api VoterWeightRecord) */
export const VOTER_WEIGHT_RECORD_DISCRIMINATOR = Buffer.from([
  46, 249, 155, 75, 153, 248, 116, 9,
])

export const REGISTRAR_SIZE = 8 + 5 * 32 + 4 * 152 + 8 + 1 + 95 // 880
export const VOTER_SIZE = 8 + 2 * 32 + 32 * 80 + 2 + 94 // 2728
const VOTING_MINT_CONFIG_SIZE = 152
const DEPOSIT_ENTRY_SIZE = 80

const u64At = (b: Buffer, o: number) => new BN(b.subarray(o, o + 8), 'le')
const i64At = (b: Buffer, o: number) =>
  new BN(b.subarray(o, o + 8), 'le').fromTwos(64)
const pkAt = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32))

function checkDisc(data: Buffer, disc: Buffer, size: number, name: string) {
  if (data.length < size)
    throw new VsrMathError(
      `${name}: account too small (${data.length} < ${size})`,
    )
  if (!data.subarray(0, 8).equals(disc))
    throw new VsrMathError(`${name}: wrong account discriminator`)
}

/** VotingMintConfig: mint[32] grant_authority[32] baseline u64 max_extra u64 saturation u64 digit_shift i8 reserved1[7] reserved2[u64;7] */
function decodeVotingMintConfig(b: Buffer, o: number): VsrVotingMintConfig {
  return {
    mint: pkAt(b, o),
    grantAuthority: pkAt(b, o + 32),
    baselineVoteWeightScaledFactor: u64At(b, o + 64),
    maxExtraLockupVoteWeightScaledFactor: u64At(b, o + 72),
    lockupSaturationSecs: u64At(b, o + 80),
    digitShift: b.readInt8(o + 88),
  }
}

/**
 * Registrar: disc[8] governance_program_id realm realm_governing_token_mint realm_authority reserved1[32]
 * voting_mints[VotingMintConfig;4] time_offset i64 bump u8 reserved2[7] reserved3[u64;11]
 */
export function decodeRegistrar(data: Buffer): VsrRegistrar {
  checkDisc(data, REGISTRAR_DISCRIMINATOR, REGISTRAR_SIZE, 'Registrar')
  const votingMints: VsrVotingMintConfig[] = []
  for (let i = 0; i < 4; i++)
    votingMints.push(
      decodeVotingMintConfig(data, 168 + i * VOTING_MINT_CONFIG_SIZE),
    )
  const after = 168 + 4 * VOTING_MINT_CONFIG_SIZE // 776
  return {
    governanceProgramId: pkAt(data, 8),
    realm: pkAt(data, 40),
    realmGoverningTokenMint: pkAt(data, 72),
    realmAuthority: pkAt(data, 104),
    votingMints,
    timeOffset: i64At(data, after),
    bump: data[after + 8],
  }
}

/**
 * DepositEntry: lockup{start_ts i64, end_ts i64, kind u8, reserved[15]} amount_deposited_native u64
 * amount_initially_locked_native u64 is_used bool allow_clawback bool voting_mint_config_idx u8 reserved[29]
 */
function decodeDepositEntry(b: Buffer, o: number): VsrDepositEntry {
  const kind = b[o + 16]
  if (kind > LockupKind.Constant)
    throw new VsrMathError(`DepositEntry: unknown LockupKind ${kind}`)
  return {
    lockup: {
      startTs: i64At(b, o),
      endTs: i64At(b, o + 8),
      kind: kind as LockupKind,
    },
    amountDepositedNative: u64At(b, o + 32),
    amountInitiallyLockedNative: u64At(b, o + 40),
    isUsed: b[o + 48] !== 0,
    allowClawback: b[o + 49] !== 0,
    votingMintConfigIdx: b[o + 50],
  }
}

/** Voter: disc[8] voter_authority registrar deposits[DepositEntry;32] voter_bump u8 voter_weight_record_bump u8 reserved[94] */
export function decodeVoter(data: Buffer): VsrVoter {
  checkDisc(data, VOTER_DISCRIMINATOR, VOTER_SIZE, 'Voter')
  const deposits: VsrDepositEntry[] = []
  for (let i = 0; i < 32; i++)
    deposits.push(decodeDepositEntry(data, 72 + i * DEPOSIT_ENTRY_SIZE))
  const after = 72 + 32 * DEPOSIT_ENTRY_SIZE // 2632
  return {
    voterAuthority: pkAt(data, 8),
    registrar: pkAt(data, 40),
    deposits,
    voterBump: data[after],
    voterWeightRecordBump: data[after + 1],
  }
}

/**
 * spl_governance_addin_api::voter_weight::VoterWeightRecord (borsh): disc[8] realm governing_token_mint
 * governing_token_owner voter_weight u64 voter_weight_expiry Option<u64> ... (rest not needed here)
 */
export function decodeVoterWeightRecord(data: Buffer) {
  if (!data.subarray(0, 8).equals(VOTER_WEIGHT_RECORD_DISCRIMINATOR))
    throw new VsrMathError('VoterWeightRecord: wrong account discriminator')
  const hasExpiry = data[112] === 1
  return {
    realm: pkAt(data, 8),
    governingTokenMint: pkAt(data, 40),
    governingTokenOwner: pkAt(data, 72),
    voterWeight: u64At(data, 104),
    voterWeightExpiry: hasExpiry ? u64At(data, 113) : null,
  }
}

// ---------------------------------------------------------------------------------------------
// state/lockup.rs
// ---------------------------------------------------------------------------------------------

/** lockup.rs `LockupKind::period_secs` */
export function periodSecs(kind: LockupKind): BN {
  switch (kind) {
    case LockupKind.None:
      return ZERO
    case LockupKind.Daily:
      return SECS_PER_DAY
    case LockupKind.Monthly:
      return SECS_PER_MONTH
    case LockupKind.Cliff:
      return SECS_PER_DAY // "arbitrary choice" in the Rust source
    case LockupKind.Constant:
      return SECS_PER_DAY // "arbitrary choice" in the Rust source
  }
}

/** lockup.rs `LockupKind::is_vesting` */
export const isVesting = (kind: LockupKind) =>
  kind === LockupKind.Daily || kind === LockupKind.Monthly

/** lockup.rs `Lockup::seconds_left` (u64). Constant lockups never count down: curr_ts is replaced by start_ts. */
export function secondsLeft(lockup: VsrLockup, currTs: BN): BN {
  const ts = lockup.kind === LockupKind.Constant ? lockup.startTs : currTs
  if (ts.gte(lockup.endTs)) return ZERO
  return lockup.endTs.sub(ts) // `(end_ts - curr_ts) as u64`, positive here
}

/** lockup.rs `Lockup::expired` */
export const lockupExpired = (lockup: VsrLockup, currTs: BN) =>
  secondsLeft(lockup, currTs).isZero()

/** lockup.rs `Lockup::periods_total` (errors with InvalidLockupPeriod if not a whole number of periods) */
export function periodsTotal(lockup: VsrLockup): BN {
  const ps = periodSecs(lockup.kind)
  if (ps.isZero()) return ZERO
  const lockupSecs = secondsLeft(lockup, lockup.startTs)
  if (!lockupSecs.mod(ps).isZero())
    throw new VsrMathError('InvalidLockupPeriod')
  return lockupSecs.div(ps)
}

/** lockup.rs `Lockup::periods_left` */
export function periodsLeft(lockup: VsrLockup, currTs: BN): BN {
  const ps = periodSecs(lockup.kind)
  if (ps.isZero()) return ZERO
  if (currTs.lt(lockup.startTs)) return periodsTotal(lockup)
  // seconds_left(curr_ts).checked_add(period_secs.saturating_sub(1)).checked_div(period_secs)
  return assertU64(
    secondsLeft(lockup, currTs).add(satSub(ps, ONE)),
    'periods_left',
  ).div(ps)
}

/** lockup.rs `Lockup::period_current` */
export function periodCurrent(lockup: VsrLockup, currTs: BN): BN {
  return satSub(periodsTotal(lockup), periodsLeft(lockup, currTs))
}

// ---------------------------------------------------------------------------------------------
// state/voting_mint_config.rs
// ---------------------------------------------------------------------------------------------

/** voting_mint_config.rs `VotingMintConfig::digit_shift_native` (u128 intermediate, must fit u64) */
export function digitShiftNative(
  cfg: VsrVotingMintConfig,
  amountNative: BN,
): BN {
  const pow = new BN(10).pow(new BN(Math.abs(cfg.digitShift)))
  const val = cfg.digitShift < 0 ? amountNative.div(pow) : amountNative.mul(pow)
  return assertU64(val, 'VoterWeightOverflow (digit_shift)')
}

/** voting_mint_config.rs `VotingMintConfig::apply_factor`: base * factor / 1e9 in u128, result must fit u64 */
export function applyFactor(base: BN, factor: BN): BN {
  return assertU64(
    base.mul(factor).div(SCALED_FACTOR_BASE),
    'VoterWeightOverflow (apply_factor)',
  )
}

/** voting_mint_config.rs `VotingMintConfig::baseline_vote_weight` */
export const baselineVoteWeight = (
  cfg: VsrVotingMintConfig,
  amountNative: BN,
) =>
  applyFactor(
    digitShiftNative(cfg, amountNative),
    cfg.baselineVoteWeightScaledFactor,
  )

/** voting_mint_config.rs `VotingMintConfig::max_extra_lockup_vote_weight` */
export const maxExtraLockupVoteWeight = (
  cfg: VsrVotingMintConfig,
  amountNative: BN,
) =>
  applyFactor(
    digitShiftNative(cfg, amountNative),
    cfg.maxExtraLockupVoteWeightScaledFactor,
  )

/** voting_mint_config.rs `VotingMintConfig::in_use` */
export const mintConfigInUse = (cfg: VsrVotingMintConfig) =>
  !cfg.mint.equals(PublicKey.default)

/** voting_mint_config.rs `VotingMintConfig::grants_vote_weight` */
export const grantsVoteWeight = (cfg: VsrVotingMintConfig) =>
  cfg.baselineVoteWeightScaledFactor.gtn(0) ||
  cfg.maxExtraLockupVoteWeightScaledFactor.gtn(0)

// ---------------------------------------------------------------------------------------------
// state/deposit_entry.rs
// ---------------------------------------------------------------------------------------------

/** deposit_entry.rs `DepositEntry::voting_power_cliff` (used for Cliff AND Constant) */
function votingPowerCliff(
  d: VsrDepositEntry,
  currTs: BN,
  maxLocked: BN,
  saturationSecs: BN,
): BN {
  const remaining = minBN(secondsLeft(d.lockup, currTs), saturationSecs)
  if (saturationSecs.isZero())
    throw new VsrMathError('division by zero (lockup_saturation_secs)')
  return assertU64(
    maxLocked.mul(remaining).div(saturationSecs),
    'voting_power_cliff',
  )
}

/** deposit_entry.rs `DepositEntry::voting_power_linear_vesting` (Daily / Monthly) */
function votingPowerLinearVesting(
  d: VsrDepositEntry,
  currTs: BN,
  maxLocked: BN,
  saturationSecs: BN,
): BN {
  const pLeft = periodsLeft(d.lockup, currTs)
  const pTotal = periodsTotal(d.lockup)
  const ps = periodSecs(d.lockup.kind)
  if (pLeft.isZero()) return ZERO

  const secsToClosestCliff = subU64(
    secondsLeft(d.lockup, currTs),
    assertU64(ps.mul(satSub(pLeft, ONE)), 'period_secs * (periods_left-1)'),
    'secs_to_closest_cliff',
  )
  if (secsToClosestCliff.gte(saturationSecs)) return maxLocked

  const denominator = assertU64(pTotal.mul(saturationSecs), 'denominator')
  const lockupSaturationPeriods = assertU64(
    satSub(saturationSecs, secsToClosestCliff).add(ps),
    'sat periods',
  ).div(ps)
  const q = minBN(lockupSaturationPeriods, pLeft)
  const r = satSub(pLeft, q)
  const sumFullPeriods = assertU64(q.mul(satSub(q, ONE)), 'q*(q-1)').divn(2)
  const lockupSecsFractional = assertU64(
    q.mul(secsToClosestCliff),
    'lockup_secs_fractional',
  )
  const lockupSecsFull = assertU64(sumFullPeriods.mul(ps), 'lockup_secs_full')
  const lockupSecsSaturated = assertU64(
    r.mul(saturationSecs),
    'lockup_secs_saturated',
  )
  const lockupSecs = lockupSecsFractional
    .add(lockupSecsFull)
    .add(lockupSecsSaturated) // u128
  if (denominator.isZero())
    throw new VsrMathError('division by zero (denominator)')
  return assertU64(
    maxLocked.mul(lockupSecs).div(denominator),
    'voting_power_linear_vesting',
  )
}

/** deposit_entry.rs `DepositEntry::voting_power_locked`: vote power contribution from locked funds only */
export function votingPowerLocked(
  d: VsrDepositEntry,
  currTs: BN,
  maxLockedVoteWeight: BN,
  lockupSaturationSecs: BN,
): BN {
  if (lockupExpired(d.lockup, currTs) || maxLockedVoteWeight.isZero())
    return ZERO
  switch (d.lockup.kind) {
    case LockupKind.None:
      return ZERO
    case LockupKind.Daily:
    case LockupKind.Monthly:
      return votingPowerLinearVesting(
        d,
        currTs,
        maxLockedVoteWeight,
        lockupSaturationSecs,
      )
    case LockupKind.Cliff:
    case LockupKind.Constant:
      return votingPowerCliff(
        d,
        currTs,
        maxLockedVoteWeight,
        lockupSaturationSecs,
      )
  }
}

/** deposit_entry.rs `DepositEntry::voting_power` = baseline(amount_deposited) + locked(amount_initially_locked) */
export function depositVotingPower(
  d: VsrDepositEntry,
  cfg: VsrVotingMintConfig,
  currTs: BN,
): BN {
  const baseline = baselineVoteWeight(cfg, d.amountDepositedNative)
  const maxLocked = maxExtraLockupVoteWeight(cfg, d.amountInitiallyLockedNative)
  const locked = votingPowerLocked(
    d,
    currTs,
    maxLocked,
    cfg.lockupSaturationSecs,
  )
  if (locked.gt(maxLocked))
    throw new VsrMathError('InternalErrorBadLockupVoteWeight')
  return assertU64(baseline.add(locked), 'VoterWeightOverflow')
}

/** deposit_entry.rs `DepositEntry::vested` */
export function vested(d: VsrDepositEntry, currTs: BN): BN {
  if (lockupExpired(d.lockup, currTs)) return d.amountInitiallyLockedNative
  switch (d.lockup.kind) {
    case LockupKind.None:
      return d.amountInitiallyLockedNative
    case LockupKind.Daily:
    case LockupKind.Monthly: {
      // deposit_entry.rs `vested_linearly`
      const cur = periodCurrent(d.lockup, currTs)
      const total = periodsTotal(d.lockup)
      if (cur.isZero()) return ZERO
      if (cur.gte(total)) return d.amountInitiallyLockedNative
      return assertU64(d.amountInitiallyLockedNative.mul(cur), 'vested').div(
        total,
      )
    }
    case LockupKind.Cliff:
    case LockupKind.Constant:
      return ZERO
  }
}

/** deposit_entry.rs `DepositEntry::amount_locked` */
export const amountLocked = (d: VsrDepositEntry, currTs: BN) =>
  subU64(d.amountInitiallyLockedNative, vested(d, currTs), 'amount_locked')

/** deposit_entry.rs `DepositEntry::amount_unlocked` (deposited but withdrawable: gives only baseline weight) */
export const amountUnlocked = (d: VsrDepositEntry, currTs: BN) =>
  subU64(d.amountDepositedNative, amountLocked(d, currTs), 'amount_unlocked')

// ---------------------------------------------------------------------------------------------
// state/registrar.rs + state/voter.rs
// ---------------------------------------------------------------------------------------------

/** registrar.rs `Registrar::clock_unix_timestamp` = Clock::unix_timestamp + time_offset */
export const registrarTimestamp = (
  registrar: VsrRegistrar,
  clockUnixTimestamp: BN | number,
) =>
  assertI64(
    new BN(clockUnixTimestamp).add(registrar.timeOffset),
    'clock_unix_timestamp',
  )

/**
 * voter.rs `Voter::weight`: the value update_voter_weight_record writes into VoterWeightRecord.voter_weight.
 * `clockUnixTimestamp` is the raw Clock sysvar unix_timestamp (the registrar time_offset is applied here).
 */
export function voterWeight(
  voter: VsrVoter,
  registrar: VsrRegistrar,
  clockUnixTimestamp: BN | number,
): BN {
  const currTs = registrarTimestamp(registrar, clockUnixTimestamp)
  let sum = ZERO
  for (const d of voter.deposits) {
    if (!d.isUsed) continue
    const cfg = registrar.votingMints[d.votingMintConfigIdx]
    if (!cfg) throw new VsrMathError('voting_mint_config_idx out of bounds')
    sum = assertU64(
      sum.add(depositVotingPower(d, cfg, currTs)),
      'Voter::weight sum',
    )
  }
  return sum
}

/** voter.rs `Voter::weight_baseline` (weight ignoring all lockup effects) */
export function voterWeightBaseline(
  voter: VsrVoter,
  registrar: VsrRegistrar,
): BN {
  let sum = ZERO
  for (const d of voter.deposits) {
    if (!d.isUsed) continue
    sum = assertU64(
      sum.add(
        baselineVoteWeight(
          registrar.votingMints[d.votingMintConfigIdx],
          d.amountDepositedNative,
        ),
      ),
      'baseline sum',
    )
  }
  return sum
}

// ---------------------------------------------------------------------------------------------
// UI helpers (derived only from the functions above; no extra rules)
// ---------------------------------------------------------------------------------------------

export interface DepositSummary {
  index: number
  mint: PublicKey
  kind: LockupKind
  /** amount_deposited_native */
  depositedNative: BN
  /** amount_locked(curr_ts) */
  lockedNative: BN
  /** amount_unlocked(curr_ts): deposited but not locked any more (withdrawable) */
  unlockedNative: BN
  /** seconds_left(curr_ts); for Constant this is the full (frozen) lockup duration */
  secondsLeft: BN
  /** end of lockup (unix ts) for non-Constant kinds while still locked, else null */
  endTs: BN | null
  votingPower: BN
  baselineVotingPower: BN
}

export interface VoterSummary {
  currTs: BN
  votingPower: BN
  baselineVotingPower: BN
  /** sum of locked amounts (native units, all mints) */
  lockedNative: BN
  /** sum of deposited-but-unlocked amounts (native units, all mints) */
  unlockedNative: BN
  /** unlocked amount that earns ZERO voting power because the mint's baseline factor is 0 */
  unlockedWithoutVotingPowerNative: BN
  deposits: DepositSummary[]
}

export function summarizeVoter(
  voter: VsrVoter,
  registrar: VsrRegistrar,
  clockUnixTimestamp: BN | number,
): VoterSummary {
  const currTs = registrarTimestamp(registrar, clockUnixTimestamp)
  const deposits: DepositSummary[] = []
  let lockedNative = ZERO
  let unlockedNative = ZERO
  let unlockedWithoutVp = ZERO
  voter.deposits.forEach((d, index) => {
    if (!d.isUsed) return
    const cfg = registrar.votingMints[d.votingMintConfigIdx]
    const locked = amountLocked(d, currTs)
    const unlocked = amountUnlocked(d, currTs)
    const left = secondsLeft(d.lockup, currTs)
    deposits.push({
      index,
      mint: cfg.mint,
      kind: d.lockup.kind,
      depositedNative: d.amountDepositedNative,
      lockedNative: locked,
      unlockedNative: unlocked,
      secondsLeft: left,
      endTs:
        d.lockup.kind !== LockupKind.Constant && left.gtn(0)
          ? currTs.add(left)
          : null,
      votingPower: depositVotingPower(d, cfg, currTs),
      baselineVotingPower: baselineVoteWeight(cfg, d.amountDepositedNative),
    })
    lockedNative = lockedNative.add(locked)
    unlockedNative = unlockedNative.add(unlocked)
    if (cfg.baselineVoteWeightScaledFactor.isZero())
      unlockedWithoutVp = unlockedWithoutVp.add(unlocked)
  })
  return {
    currTs,
    votingPower: voterWeight(voter, registrar, clockUnixTimestamp),
    baselineVotingPower: voterWeightBaseline(voter, registrar),
    lockedNative,
    unlockedNative,
    unlockedWithoutVotingPowerNative: unlockedWithoutVp,
    deposits,
  }
}

/**
 * True when the registrar gives deposited-but-unlocked tokens of `mint` no voting power at all
 * (baseline_vote_weight_scaled_factor == 0). Generic: derived from registrar config, not hardcoded.
 */
export function unlockedDepositsHaveNoVotingPower(
  registrar: VsrRegistrar,
  mint: PublicKey,
): boolean {
  const cfg = registrar.votingMints.find(
    (c) => mintConfigInUse(c) && c.mint.equals(mint),
  )
  return !!cfg && cfg.baselineVoteWeightScaledFactor.isZero()
}

/**
 * Voting power a NEW deposit would have the moment it is created with `periods` lockup periods of `kind`
 * (lockup.rs `Lockup::new_from_periods` with start_ts = curr_ts, then `DepositEntry::voting_power`).
 * Periods: Daily/Cliff/Constant = days, Monthly = months of SECS_PER_MONTH, None = 0.
 */
export function previewLockVotingPower(
  cfg: VsrVotingMintConfig,
  amountNative: BN,
  kind: LockupKind,
  periods: number,
): BN {
  if (!Number.isInteger(periods) || periods < 0)
    throw new VsrMathError('InvalidLockupPeriod')
  const endTs = periodSecs(kind).muln(periods)
  const d: VsrDepositEntry = {
    lockup: { startTs: ZERO, endTs, kind },
    amountDepositedNative: amountNative,
    amountInitiallyLockedNative: amountNative,
    isUsed: true,
    allowClawback: false,
    votingMintConfigIdx: 0,
  }
  return depositVotingPower(d, cfg, ZERO)
}

/**
 * Voting power a fresh deposit of `amountNative` would have right now for a lockup of `lockupSecs`
 * (Cliff/Constant semantics; for vesting kinds build a VsrDepositEntry and call depositVotingPower).
 */
export function previewCliffVotingPower(
  cfg: VsrVotingMintConfig,
  amountNative: BN,
  lockupSecs: BN,
  kind:
    | LockupKind.Cliff
    | LockupKind.Constant
    | LockupKind.None = LockupKind.Cliff,
): BN {
  const d: VsrDepositEntry = {
    lockup: {
      startTs: ZERO,
      endTs: kind === LockupKind.None ? ZERO : lockupSecs,
      kind,
    },
    amountDepositedNative: amountNative,
    amountInitiallyLockedNative: kind === LockupKind.None ? ZERO : amountNative,
    isUsed: true,
    allowClawback: false,
    votingMintConfigIdx: 0,
  }
  return depositVotingPower(d, cfg, ZERO)
}

/**
 * One-sentence explanation of the decay rule, generated from the registrar config (not hardcoded).
 * For Marinade (baseline 0, max extra 1.0, saturation 31 days, digit_shift 0) this yields exactly:
 * "Your voting power = locked MNDE × min(remaining lockup / 31 days, 1); it shrinks as your lockup runs out
 *  unless it's a constant lockup."
 * Derivation: DepositEntry::voting_power = baseline(deposited) + max_extra(locked) × min(seconds_left, sat) / sat,
 * and Lockup::seconds_left is frozen at (end_ts - start_ts) for Constant lockups. Vesting lockups apply the
 * same rule to each vesting tranche separately.
 */
export function describeVotingPowerFormula(
  cfg: VsrVotingMintConfig,
  tokenName: string,
): string {
  const fmtFactor = (f: BN) => {
    // factor is in 1e-9 units and applies to amount × 10^digit_shift; display with up to 4 decimals
    let v = f.muln(10_000)
    if (cfg.digitShift >= 0) v = v.mul(new BN(10).pow(new BN(cfg.digitShift)))
    else v = v.div(new BN(10).pow(new BN(-cfg.digitShift)))
    return (v.div(SCALED_FACTOR_BASE).toNumber() / 10_000).toString()
  }
  const satSecs = cfg.lockupSaturationSecs.toNumber()
  const sat =
    satSecs % 86_400 === 0
      ? `${satSecs / 86_400} day${satSecs === 86_400 ? '' : 's'}`
      : `${(satSecs / 86_400).toFixed(2)} days`
  const extra = fmtFactor(cfg.maxExtraLockupVoteWeightScaledFactor)
  const base = fmtFactor(cfg.baselineVoteWeightScaledFactor)
  const lockedTerm =
    extra === '1' ? `locked ${tokenName}` : `locked ${tokenName} × ${extra}`
  const decay = `${lockedTerm} × min(remaining lockup / ${sat}, 1)`
  const formula = cfg.baselineVoteWeightScaledFactor.isZero()
    ? decay
    : `deposited ${tokenName}${base === '1' ? '' : ` × ${base}`} + ${decay}`
  return `Your voting power = ${formula}; it shrinks as your lockup runs out unless it's a constant lockup.`
}
