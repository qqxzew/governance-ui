import useRealm from '@hooks/useRealm'
import { BigNumber } from 'bignumber.js'
import classNames from 'classnames'

import useDepositStore from 'VoteStakeRegistry/stores/useDepositStore'

import { getMintMetadata } from '../instructions/programs/splToken'
import { useRealmQuery } from '@hooks/queries/realm'
import { useRealmCommunityMintInfoQuery } from '@hooks/queries/mintInfo'
import VSRCommunityVotingPower from 'VoteStakeRegistry/components/TokenBalance/VSRVotingPower'
import DepositCommunityTokensBtn from 'VoteStakeRegistry/components/TokenBalance/DepositCommunityTokensBtn'
import useDelegators from '@components/VotePanel/useDelegators'
import { useRealmVoterWeightPlugins } from '@hooks/useRealmVoterWeightPlugins'
import {
  CalculatedWeight,
  VoterWeightPlugins,
} from '../../VoterWeightPlugins/lib/types'
import { BN } from '@coral-xyz/anchor'
import { useRealmConfigQuery } from '@hooks/queries/realmConfig'
import { CUSTOM_BIO_VSR_PLUGIN_PK } from '@constants/plugins'
import VotingPowerCard from '@components/VotingPowerCard'
import {
  useUnlockedDepositsGiveNoVotingPower,
  useVsrProgramId,
} from '@components/VotingPowerCard/useVsrVoterState'

interface Props {
  className?: string
}

const findVSRVoterWeight = (
  calculatedVoterWeight: CalculatedWeight | undefined,
): BN | undefined =>
  calculatedVoterWeight?.details.find((detail) => detail.pluginName === 'VSR')
    ?.pluginWeight ?? undefined

const isVSRLastVoterWeightPlugin = (plugins: VoterWeightPlugins | undefined) =>
  plugins?.voterWeight[plugins.voterWeight.length - 1].name === 'VSR'

export default function LockedCommunityVotingPower(props: Props) {
  const realm = useRealmQuery().data?.result
  const realmConfig = useRealmConfigQuery().data?.result

  const { data: mintData, isLoading: mintLoading } =
    useRealmCommunityMintInfoQuery()
  const mint = mintData?.result

  const { realmTokenAccount } = useRealm()
  const {
    totalCalculatedVoterWeight,
    isReady: votingPowerReady,
    plugins,
  } = useRealmVoterWeightPlugins('community')

  // in case the VSR plugin is the last plugin, this is the final calculated voter weight.
  // however, if it is one in a chain, we are just showing an intermediate calculation here.
  // This affects how it appears in the UI
  const votingPower = findVSRVoterWeight(totalCalculatedVoterWeight)
  const isLastVoterWeightPlugin = isVSRLastVoterWeightPlugin(plugins)

  const isLoading = useDepositStore((s) => s.state.isLoading)
  const unlockedGivesNothing = useUnlockedDepositsGiveNoVotingPower()
  const vsrCardActive = !!useVsrProgramId()

  const depositMint = realm?.account.communityMint
  const depositAmount = realmTokenAccount
    ? new BigNumber(realmTokenAccount.account.amount.toString())
    : new BigNumber(0)

  const tokenName =
    getMintMetadata(depositMint)?.name ?? realm?.account.name ?? ''

  // memoize useAsync inputs to prevent constant refetch
  const relevantDelegators = useDelegators('community')

  const updatedRealmTokenAccount = realmTokenAccount as any

  const decimals = 
    realmConfig?.account.communityTokenConfig.voterWeightAddin?.toBase58() === CUSTOM_BIO_VSR_PLUGIN_PK && updatedRealmTokenAccount ?
      updatedRealmTokenAccount.decimals as number :
      mint?.decimals ?? 0
  
  if (isLoading || !votingPowerReady || mintLoading) {
    return (
      <div
        className={classNames(
          props.className,
          'rounded-md bg-bkg-1 h-[76px] animate-pulse',
        )}
      />
    )
  }

  const hasDelegators = (relevantDelegators?.length ?? 0) > 0
  const legacyVotingPower =
    (votingPower === undefined || votingPower.isZero()) && !hasDelegators ? (
      <div className={'text-xs text-white/50'}>
        You do not have any voting power in this dao.
      </div>
    ) : (
      <VSRCommunityVotingPower
        votingPower={votingPower}
        votingPowerLoading={!votingPowerReady}
        isLastPlugin={isLastVoterWeightPlugin}
      />
    )

  return (
    <div className={props.className}>
      {/* VSR voting power card (locked amount, lockup, decay rule, unlocked-deposit warning, Lock button).
          Falls back to the legacy view for non-standard VSR layouts. */}
      <VotingPowerCard
        walletTokenAmount={
          unlockedGivesNothing && realmTokenAccount
            ? new BN(realmTokenAccount.account.amount.toString())
            : undefined
        }
        fallback={legacyVotingPower}
      />
      {hasDelegators && vsrCardActive && (
        <VSRCommunityVotingPower
          className="mt-3"
          votingPower={votingPower}
          votingPowerLoading={!votingPowerReady}
          isLastPlugin={isLastVoterWeightPlugin}
        />
      )}

      {/* When unlocked deposits give 0 voting power, the card's "Lock tokens" button is the path;
          a plain deposit prompt here would be misleading. */}
      {depositAmount.isGreaterThan(0) && !unlockedGivesNothing && (
        <>
          <div className="mt-3 mb-3 text-xs text-white/50">
            You have{' '}
            {mint
              ? depositAmount.shiftedBy(-decimals).toFormat()
              : depositAmount.toFormat()}{' '}
            more {tokenName} votes in your wallet. Do you want to deposit them
            to increase your voting power in this Dao?
          </div>
          <DepositCommunityTokensBtn inAccountDetails={false} />
        </>
      )}
    </div>
  )
}
