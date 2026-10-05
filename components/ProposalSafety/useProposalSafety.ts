import { useConnection } from '@solana/wallet-adapter-react'
import { useQuery } from '@tanstack/react-query'
import { useRouteProposalQuery } from '@hooks/queries/proposal'
import {
  analyzeProposal,
  loadProposalSafetyInput,
  ProposalSafetyInput,
  ProposalSafetyReport,
} from '@tools/proposalSafety'

export const proposalSafetyQueryKeys = {
  byProposal: (endpoint: string, proposal: string) => [
    endpoint,
    'ProposalSafety',
    proposal,
  ],
}

/**
 * Loads everything the safety engine needs for the route proposal and runs the rules.
 * The realm-level context (treasury, known payees) is cached inside the loader per realm.
 */
export const useProposalSafetyQuery = () => {
  const { connection } = useConnection()
  const proposal = useRouteProposalQuery().data?.result
  const enabled = proposal !== undefined

  return useQuery<{ input: ProposalSafetyInput; report: ProposalSafetyReport }>({
    queryKey: enabled
      ? proposalSafetyQueryKeys.byProposal(
          connection.rpcEndpoint,
          proposal.pubkey.toBase58(),
        )
      : undefined,
    queryFn: async () => {
      if (!enabled) throw new Error()
      const input = await loadProposalSafetyInput(connection, proposal.pubkey, {
        programId: proposal.owner,
      })
      return { input, report: analyzeProposal(input) }
    },
    enabled,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}
