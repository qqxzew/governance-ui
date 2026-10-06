import { PublicKey } from '@solana/web3.js'
import { GovernanceAccountParser, Proposal } from '@solana/spl-governance'
import {
  analyzeProposal,
  loadProposalSafetyInput,
  loadRealmSafetyContext,
  ProposalSafetyReport,
  RealmSafetyContext,
} from '../../../tools/proposalSafety'
import { cached } from './cache'
import { getConnection } from './rpc'
import { FINAL_STATES, STATE_NAMES } from '../format'

/** DAO-level context (treasury, payment history, governed programs). 30 min, stale-while-revalidate. */
export function getRealmContext(realmPk: string, programId: string): Promise<RealmSafetyContext> {
  return cached(
    `ctx|${realmPk}`,
    30 * 60_000,
    () =>
      loadRealmSafetyContext(getConnection(), new PublicKey(programId), new PublicKey(realmPk), {
        concurrency: 6,
        knownPayeesTimeoutMs: 20_000,
      }),
    { staleWhileRevalidate: true },
  )
}

export interface ProposalMeta {
  pk: string
  realm: string
  name: string
  state: number
  stateName: string
  description: string
  descriptionLink: string
  descriptionUnresolved: boolean
  governance: string
  proposer?: string
  draftAt: number | null
  votingAt: number | null
  votes: { yes: string; no: string; veto: string; decimals: number; council: boolean }
}

export interface ProposalAnalysis {
  meta: ProposalMeta
  report: ProposalSafetyReport
  analyzedAt: number
}

async function mintDecimals(mint: string, ctx: RealmSafetyContext): Promise<number> {
  const known = ctx.mints[mint]?.decimals
  if (known !== undefined) return known
  const info = await getConnection().getAccountInfo(new PublicKey(mint))
  return info && info.data.length >= 45 ? info.data[44] : 0
}

/** Full analysis of one proposal. Finished proposals are cached forever, live ones for 90 s. */
export function getProposalAnalysis(pk: string): Promise<ProposalAnalysis> {
  return cached<ProposalAnalysis>(
    `analysis|${pk}`,
    (v) => (FINAL_STATES.has(v.meta.state) ? Infinity : 90_000),
    async () => {
      const conn = getConnection()
      const proposalPk = new PublicKey(pk)
      const pInfo = await conn.getAccountInfo(proposalPk)
      if (!pInfo) throw new Error('proposal not found')
      const p = GovernanceAccountParser(Proposal)(proposalPk, pInfo).account
      const gInfo = await conn.getAccountInfo(p.governance)
      if (!gInfo) throw new Error('governance not found')
      const realmPk = new PublicKey(gInfo.data.subarray(1, 33)).toBase58()
      const programId = pInfo.owner.toBase58()

      const ctx = await getRealmContext(realmPk, programId)
      const input = await loadProposalSafetyInput(conn, proposalPk, {
        programId: pInfo.owner,
        realmContext: ctx,
      })
      const report = analyzeProposal(input)
      const mint = p.governingTokenMint.toBase58()
      const decimals = await mintDecimals(mint, ctx)
      let yes = '0'
      let no = '0'
      try {
        yes = p.getYesVoteCount().toString()
        no = p.getNoVoteCount().toString()
      } catch {
        /* multi-choice proposals */
      }
      return {
        analyzedAt: Date.now(),
        report,
        meta: {
          pk,
          realm: realmPk,
          name: p.name,
          state: p.state,
          stateName: STATE_NAMES[p.state] ?? String(p.state),
          description: input.proposal.descriptionText,
          descriptionLink: input.proposal.descriptionLink,
          descriptionUnresolved: !!input.proposal.descriptionUnresolved,
          governance: p.governance.toBase58(),
          proposer: input.proposal.tokenOwnerRecord,
          draftAt: input.proposal.draftAt ?? null,
          votingAt: input.proposal.votingAt ?? null,
          votes: {
            yes,
            no,
            veto: p.vetoVoteWeight?.toString() ?? '0',
            decimals,
            council: mint === ctx.realm.councilMint,
          },
        },
      }
    },
  )
}

export interface Verdict {
  pk: string
  maxSeverity: ProposalSafetyReport['maxSeverity']
  red: number
  yellow: number
  headline?: string
}

export async function getVerdict(pk: string): Promise<Verdict> {
  const { report } = await getProposalAnalysis(pk)
  const red = report.findings.filter((f) => f.severity === 'red')
  const yellow = report.findings.filter((f) => f.severity === 'yellow')
  return {
    pk,
    maxSeverity: report.maxSeverity,
    red: red.length,
    yellow: yellow.length,
    headline: (red[0] ?? yellow[0])?.title,
  }
}
