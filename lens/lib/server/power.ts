import { PublicKey } from '@solana/web3.js'
import { loadVsrVoterState } from '../../../tools/vsr/load'
import {
  describeVotingPowerFormula,
  LOCKUP_KIND_NAMES,
  mintConfigInUse,
} from '../../../tools/vsr/votingPower'
import { KNOWN_MINT_SYMBOLS, VSR_PROGRAMS } from '../../../tools/proposalSafety/constants'
import { cached } from './cache'
import { getConnection } from './rpc'
import { RealmSummary } from './realm'

export interface PowerDeposit {
  kind: string
  locked: string
  unlocked: string
  secondsLeft: number
  endTs: number | null
  votingPower: string
}

export interface VotingPowerResult {
  wallet: string
  supported: boolean
  reason?: string
  token: string
  decimals: number
  hasVoter: boolean
  votingPower: string
  locked: string
  unlocked: string
  unlockedWithoutPower: string
  deposits: PowerDeposit[]
  formula: string
  baselineZero: boolean
  asOf: number
}

export function getVotingPower(realm: RealmSummary, wallet: string): Promise<VotingPowerResult> {
  const walletPk = new PublicKey(wallet) // throws on invalid input
  return cached(`power|${realm.pk}|${walletPk.toBase58()}`, 30_000, async () => {
    const token = KNOWN_MINT_SYMBOLS[realm.communityMint] ?? realm.symbol ?? 'tokens'
    const base = {
      wallet: walletPk.toBase58(),
      token,
      decimals: 0,
      hasVoter: false,
      votingPower: '0',
      locked: '0',
      unlocked: '0',
      unlockedWithoutPower: '0',
      deposits: [],
      formula: '',
      baselineZero: false,
      asOf: Math.floor(Date.now() / 1000),
    }
    const plugin = realm.communityVoterWeightAddin
    if (!plugin || !VSR_PROGRAMS[plugin]) {
      return {
        ...base,
        supported: false,
        reason: plugin
          ? 'This realm uses a voting plugin this page does not compute yet.'
          : 'This realm counts plain deposited tokens (no lockup plugin); voting power = deposited tokens.',
      }
    }
    const conn = getConnection()
    const mintInfo = await conn.getAccountInfo(new PublicKey(realm.communityMint))
    const decimals = mintInfo && mintInfo.data.length >= 45 ? mintInfo.data[44] : 0
    const st = await loadVsrVoterState(conn, {
      realm: new PublicKey(realm.pk),
      communityMint: new PublicKey(realm.communityMint),
      vsrProgramId: new PublicKey(plugin),
      wallet: walletPk,
    })
    const cfg = st.registrar.votingMints.find(
      (c) => mintConfigInUse(c) && c.mint.toBase58() === realm.communityMint,
    )
    const formula = cfg ? describeVotingPowerFormula(cfg, token) : ''
    const baselineZero = !!cfg && cfg.baselineVoteWeightScaledFactor.isZero()
    const s = st.summary
    return {
      ...base,
      supported: true,
      decimals,
      formula,
      baselineZero,
      asOf: st.clockUnixTimestamp.toNumber(),
      hasVoter: !!st.voter,
      votingPower: s ? s.votingPower.toString() : '0',
      locked: s ? s.lockedNative.toString() : '0',
      unlocked: s ? s.unlockedNative.toString() : '0',
      unlockedWithoutPower: s ? s.unlockedWithoutVotingPowerNative.toString() : '0',
      deposits: s
        ? s.deposits.map((d) => ({
            kind: LOCKUP_KIND_NAMES[d.kind] ?? String(d.kind),
            locked: d.lockedNative.toString(),
            unlocked: d.unlockedNative.toString(),
            secondsLeft: d.secondsLeft.toNumber(),
            endTs: d.endTs ? d.endTs.toNumber() : null,
            votingPower: d.votingPower.toString(),
          }))
        : [],
    }
  })
}
