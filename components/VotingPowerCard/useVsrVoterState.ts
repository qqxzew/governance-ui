import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PublicKey } from '@solana/web3.js'
import { useConnection } from '@solana/wallet-adapter-react'
import { useRealmQuery } from '@hooks/queries/realm'
import { useRealmConfigQuery } from '@hooks/queries/realmConfig'
import { CUSTOM_BIO_VSR_PLUGIN_PK, findPluginName } from '@constants/plugins'
import useDepositStore from 'VoteStakeRegistry/stores/useDepositStore'
import { loadVsrVoterState } from '@tools/vsr/load'
import { Registrar } from 'VoteStakeRegistry/sdk/accounts'
import { useVsrClient } from '../../VoterWeightPlugins/useVsrClient'

/**
 * VSR program id for the realm's community voter-weight addin, or undefined if the realm is not a
 * standard-layout VSR realm (the custom Bio VSR deposits a different mint and is left to the existing UI).
 */
export function useVsrProgramId(): PublicKey | undefined {
  const config = useRealmConfigQuery().data?.result
  const pluginId = config?.account.communityTokenConfig.voterWeightAddin
  return pluginId &&
    findPluginName(pluginId) === 'VSR' &&
    pluginId.toBase58() !== CUSTOM_BIO_VSR_PLUGIN_PK
    ? pluginId
    : undefined
}

/**
 * Registrar + Voter + Clock for `wallet`, decoded and evaluated with tools/vsr/votingPower.ts
 * (bit-exact port of the VSR program math, see tools/vsr/__tests__).
 */
export function useVsrVoterState(wallet: PublicKey | undefined) {
  const { connection } = useConnection()
  const realm = useRealmQuery().data?.result
  const vsrProgramId = useVsrProgramId()
  // refetch when the deposit store changes (after deposit / lock / withdraw)
  const deposits = useDepositStore((s) => s.state.deposits)

  const enabled = !!realm && !!vsrProgramId && !!wallet
  const query = useQuery({
    enabled,
    queryKey: [
      connection.rpcEndpoint,
      'vsr-voter-state',
      realm?.pubkey.toBase58(),
      vsrProgramId?.toBase58(),
      wallet?.toBase58(),
    ],
    queryFn: () =>
      loadVsrVoterState(connection, {
        realm: realm!.pubkey,
        communityMint: realm!.account.communityMint,
        vsrProgramId: vsrProgramId!,
        wallet: wallet!,
      }),
    refetchInterval: 60_000,
  })

  const { refetch } = query
  useEffect(() => {
    if (enabled) refetch()
  }, [deposits, enabled, refetch])

  return query
}

/**
 * True when the realm's VSR registrar gives deposited-but-unlocked community tokens ZERO voting power
 * (baseline_vote_weight_scaled_factor == 0, e.g. Marinade). Generic: read from the registrar, not hardcoded.
 */
export function useUnlockedDepositsGiveNoVotingPower(): boolean {
  const realm = useRealmQuery().data?.result
  const { plugin } = useVsrClient()
  const registrar = plugin?.params as Registrar | undefined
  if (!realm || !registrar) return false
  const cfg = registrar.votingMints.find((m) =>
    m.mint.equals(realm.account.communityMint),
  )
  return !!cfg && cfg.baselineVoteWeightScaledFactor.isZero()
}
