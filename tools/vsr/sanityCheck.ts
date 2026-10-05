/**
 * P5: recompute the expected VSR voter weight for a cast vote and compare it with the weight that
 * spl-governance stored in the VoteRecord. Pure function, no RPC.
 *
 * Results are only ever labelled "match", "needs review" or "inconclusive". A mismatch is NOT evidence of
 * wrongdoing: the most common explanations are (a) the Voter account changed after the vote (deposit,
 * withdraw, lockup reset), (b) the registrar config changed after the vote (configure_voting_mint), or
 * (c) clock vs. block-time drift. Do not publish results for other DAOs (see CLAUDE.md).
 *
 * Only apply to COMMUNITY-mint votes of a VSR realm: council votes (e.g. weight 1 vetoes) are weighted by the
 * council TokenOwnerRecord deposit, not by VSR. Supply the registrar/voter state as of the vote slot when
 * possible (e.g. registrar config replayed from configure_voting_mint history); otherwise expect noise.
 */
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import {
  VsrRegistrar,
  VsrVoter,
  VsrMathError,
  voterWeight,
} from './votingPower'

/** spl-governance GovernanceAccountType::VoteRecordV2 */
export const VOTE_RECORD_V2_ACCOUNT_TYPE = 12

/**
 * spl-governance VoteRecordV2 (borsh): account_type u8, proposal Pubkey, governing_token_owner Pubkey,
 * is_relinquished bool, voter_weight u64, vote Vote, reserved_v2 [u8;8]. Only the fixed prefix is decoded.
 */
export function decodeVoteRecordV2(data: Buffer) {
  if (data[0] !== VOTE_RECORD_V2_ACCOUNT_TYPE)
    throw new Error(`not a VoteRecordV2 (account_type ${data[0]})`)
  return {
    proposal: new PublicKey(data.subarray(1, 33)),
    governingTokenOwner: new PublicKey(data.subarray(33, 65)),
    isRelinquished: data[65] !== 0,
    voterWeight: new BN(data.subarray(66, 74), 'le'),
  }
}

export type SanityStatus = 'match' | 'needs review' | 'inconclusive'

export interface VoteWeightCheckInput {
  /** VoteRecordV2.voter_weight */
  recordedWeight: BN
  /** VSR Voter account (ideally as of the vote slot); null if it does not exist */
  voter: VsrVoter | null
  /** VSR Registrar (ideally as of the vote slot) */
  registrar: VsrRegistrar
  /** block time of the transaction that created the VoteRecord */
  voteUnixTimestamp: BN | number
  /** allowed |Clock.unix_timestamp - blockTime| drift, seconds (default 120) */
  toleranceSecs?: number
  /** true only if voter/registrar were captured at the vote slot (e.g. from the vote tx simulation) */
  accountsAreFromVoteSlot?: boolean
}

export interface VoteWeightCheckResult {
  status: SanityStatus
  recorded: BN
  /** recomputed weight range over [ts - tolerance, ts + tolerance] (null if inconclusive) */
  expectedMin: BN | null
  expectedMax: BN | null
  reasons: string[]
}

export function checkVoteWeight(
  input: VoteWeightCheckInput,
): VoteWeightCheckResult {
  const { recordedWeight: recorded, voter, registrar } = input
  const tol = input.toleranceSecs ?? 120
  const ts = new BN(input.voteUnixTimestamp)
  const caveats: string[] = []
  if (!input.accountsAreFromVoteSlot)
    caveats.push(
      'Voter/registrar state was read after the vote; deposits, withdrawals, lockup resets or registrar config changes since then also explain a difference.',
    )

  if (!voter) {
    return recorded.isZero()
      ? {
          status: 'match',
          recorded,
          expectedMin: new BN(0),
          expectedMax: new BN(0),
          reasons: [],
        }
      : {
          status: 'needs review',
          recorded,
          expectedMin: null,
          expectedMax: null,
          reasons: [
            'No VSR Voter account found for this wallet (it may have been closed after the vote).',
            ...caveats,
          ],
        }
  }

  let a: BN, b: BN
  try {
    a = voterWeight(voter, registrar, ts.subn(tol))
    b = voterWeight(voter, registrar, ts.addn(tol))
  } catch (e) {
    return {
      status: 'inconclusive',
      recorded,
      expectedMin: null,
      expectedMax: null,
      reasons: [
        `Could not recompute: ${
          e instanceof VsrMathError ? e.message : String(e)
        }`,
      ],
    }
  }
  const expectedMin = BN.min(a, b)
  const expectedMax = BN.max(a, b)
  if (recorded.gte(expectedMin) && recorded.lte(expectedMax))
    return { status: 'match', recorded, expectedMin, expectedMax, reasons: [] }

  const reasons = recorded.gt(expectedMax)
    ? [
        `Recorded weight is ${recorded
          .sub(expectedMax)
          .toString()} above the recomputed maximum.`,
      ]
    : [
        `Recorded weight is ${expectedMin
          .sub(recorded)
          .toString()} below the recomputed minimum.`,
      ]
  return {
    status: 'needs review',
    recorded,
    expectedMin,
    expectedMax,
    reasons: [...reasons, ...caveats],
  }
}
