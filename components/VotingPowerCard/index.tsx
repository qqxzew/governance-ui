import { ReactNode, useState } from 'react'
import BN from 'bn.js'
import BigNumber from 'bignumber.js'
import classNames from 'classnames'
import { PublicKey } from '@solana/web3.js'
import { ExclamationIcon, LockClosedIcon } from '@heroicons/react/solid'
import Button from '@components/Button'
import { getMintMetadata } from '@components/instructions/programs/splToken'
import { useRealmQuery } from '@hooks/queries/realm'
import { useRealmCommunityMintInfoQuery } from '@hooks/queries/mintInfo'
import useRealm from '@hooks/useRealm'
import useUserOrDelegator from '@hooks/useUserOrDelegator'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import LockTokensModal from 'VoteStakeRegistry/components/Account/LockTokensModal'
import {
  describeVotingPowerFormula,
  DepositSummary,
  LockupKind,
  LOCKUP_KIND_NAMES,
  mintConfigInUse,
} from '@tools/vsr/votingPower'
import { useVsrProgramId, useVsrVoterState } from './useVsrVoterState'

export const fmtNative = (amount: BN, decimals: number) =>
  new BigNumber(amount.toString())
    .shiftedBy(-decimals)
    .decimalPlaces(Math.min(decimals, 2), BigNumber.ROUND_DOWN)
    .toFormat()

export function fmtDuration(secs: BN): string {
  const s = secs.toNumber()
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const fmtDate = (ts: BN) =>
  new Date(ts.toNumber() * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

function LockupLine({
  d,
  decimals,
  tokenName,
}: {
  d: DepositSummary
  decimals: number
  tokenName: string
}) {
  const remaining =
    d.kind === LockupKind.Constant
      ? `${fmtDuration(
          d.secondsLeft,
        )} lockup, not counting down until you start unlocking`
      : `${fmtDuration(d.secondsLeft)} left${
          d.endTs ? ` (ends ${fmtDate(d.endTs)})` : ''
        }`
  return (
    <li className="flex flex-col py-1.5 border-t border-fgd-4 first:border-t-0">
      <div className="flex text-xs">
        <span className="text-fgd-2">
          {fmtNative(d.lockedNative, decimals)} {tokenName} ·{' '}
          {LOCKUP_KIND_NAMES[d.kind]}
        </span>
        <span className="ml-auto font-bold text-fgd-1">
          {fmtNative(d.votingPower, decimals)} votes
        </span>
      </div>
      <div className="text-xs text-fgd-3">{remaining}</div>
    </li>
  )
}

/**
 * VSR voting power card: locked amount, lockup type + remaining time, current voting power (computed with
 * the verified port of the VSR math at the on-chain Clock), the decay rule in one sentence, and an explicit
 * warning for deposited-but-unlocked tokens when the registrar gives them no baseline weight.
 */
export default function VotingPowerCard({
  wallet: walletProp,
  walletTokenAmount,
  className,
  fallback = null,
}: {
  wallet?: PublicKey
  /** rendered when the VSR accounts cannot be loaded/decoded (e.g. a VSR fork with another layout) */
  fallback?: ReactNode
  /** community tokens still in the user's wallet (native units), optional */
  walletTokenAmount?: BN
  className?: string
}) {
  const actingWallet = useUserOrDelegator()
  const wallet = walletProp ?? actingWallet
  const connectedWallet = useWalletOnePointOh()
  const realm = useRealmQuery().data?.result
  const { realmInfo } = useRealm()
  const mint = useRealmCommunityMintInfoQuery().data?.result
  const { data: state, isLoading, error } = useVsrVoterState(wallet)
  const [lockOpen, setLockOpen] = useState(false)
  const vsrProgramId = useVsrProgramId()

  if (!wallet || !realm || !vsrProgramId) return <>{fallback}</>
  if (isLoading || !mint) {
    return (
      <div
        className={classNames(
          className,
          'rounded-md bg-bkg-1 h-[76px] animate-pulse',
        )}
      />
    )
  }
  if (error || !state) {
    // Unknown layout (e.g. a VSR fork with different accounts) -> let the existing UI handle it
    return <>{fallback}</>
  }

  const communityMint = realm.account.communityMint
  const cfg = state.registrar.votingMints.find(
    (c) => mintConfigInUse(c) && c.mint.equals(communityMint),
  )
  if (!cfg) return <>{fallback}</>
  const decimals = mint.decimals
  const tokenName =
    getMintMetadata(communityMint)?.name ?? realmInfo?.symbol ?? 'tokens'
  const unlockedGivesNothing = cfg.baselineVoteWeightScaledFactor.isZero()

  const summary = state.summary
  const deposits = (summary?.deposits ?? []).filter((d) =>
    d.mint.equals(communityMint),
  )
  const lockedDeposits = deposits.filter((d) => d.lockedNative.gtn(0))
  const locked = lockedDeposits.reduce(
    (a, d) => a.add(d.lockedNative),
    new BN(0),
  )
  const unlocked = deposits.reduce((a, d) => a.add(d.unlockedNative), new BN(0))
  const votingPower = summary?.votingPower ?? new BN(0)
  const canAct =
    !!connectedWallet?.publicKey && connectedWallet.publicKey.equals(wallet)
  const hasWalletTokens = !!walletTokenAmount && walletTokenAmount.gtn(0)

  return (
    <div className={classNames(className, 'rounded-md bg-bkg-1 p-3')}>
      <div className="flex items-baseline">
        <span className="text-xs text-fgd-3">Current voting power</span>
        <span className="ml-auto text-xs text-fgd-3">
          at slot {state.slot.toLocaleString()}
        </span>
      </div>
      <div className="text-xl font-bold text-fgd-1 mb-2">
        {fmtNative(votingPower, decimals)}
      </div>

      <div className="flex text-xs mb-1">
        <span>{tokenName} locked</span>
        <span className="ml-auto font-bold text-fgd-1">
          {fmtNative(locked, decimals)}
        </span>
      </div>
      {lockedDeposits.length > 0 && (
        <ul className="mb-2">
          {lockedDeposits.map((d) => (
            <LockupLine
              key={d.index}
              d={d}
              decimals={decimals}
              tokenName={tokenName}
            />
          ))}
        </ul>
      )}

      <p className="text-xs text-fgd-3 mb-2">
        {describeVotingPowerFormula(cfg, tokenName)}
      </p>

      {unlocked.gtn(0) && (
        <div
          className={classNames(
            'flex items-start rounded-md border p-2 mb-2 text-xs',
            unlockedGivesNothing ? 'border-orange' : 'border-bkg-4',
          )}
          role={unlockedGivesNothing ? 'alert' : undefined}
        >
          {unlockedGivesNothing && (
            <ExclamationIcon className="flex-shrink-0 h-4 w-4 mr-1.5 text-orange" />
          )}
          <span>
            {unlockedGivesNothing
              ? `${fmtNative(
                  unlocked,
                  decimals,
                )} ${tokenName} deposited but NOT locked — this gives 0 voting power. Lock it to vote.`
              : `${fmtNative(
                  unlocked,
                  decimals,
                )} ${tokenName} deposited but not locked (baseline voting power only).`}
          </span>
        </div>
      )}
      {hasWalletTokens && unlockedGivesNothing && (
        <p className="text-xs text-fgd-3 mb-2">
          You also hold {fmtNative(walletTokenAmount!, decimals)} {tokenName} in
          your wallet. In this DAO only locked {tokenName} counts: lock them to
          vote.
        </p>
      )}

      {canAct && (unlocked.gtn(0) || hasWalletTokens) && (
        <Button className="w-full" onClick={() => setLockOpen(true)}>
          <div className="flex items-center justify-center">
            <LockClosedIcon className="h-4 w-4 mr-1.5" />
            Lock tokens
          </div>
        </Button>
      )}
      {lockOpen && (
        <LockTokensModal isOpen={lockOpen} onClose={() => setLockOpen(false)} />
      )}
    </div>
  )
}
