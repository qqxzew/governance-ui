import { Connection, PublicKey } from '@solana/web3.js'
import {
  fetchGovernances,
  fetchProposalDetails,
  fetchProposalSlices,
  fetchTransactionsSignature,
  GovernanceRef,
  ProposalDetails,
  ProposalSlice,
} from './chain'
import { dangerKey, onlyRed, SafetyChecker } from './safety'
import { SeenProposal, WatchedRealm } from './state'
import { formatDanger, formatNewProposal, formatVotingStarted } from './text'

/** Draft, SigningOff, Voting: transactions may still matter / change before execution. */
export const ACTIVE_STATES = new Set([0, 1, 2])
const DRAFT = 0
const VOTING = 2
const NAME_MAX = 120

export type PollEvent =
  | { type: 'new'; pk: string; name: string; state: number }
  | { type: 'voting'; pk: string; name: string }
  | { type: 'danger'; pk: string; name: string; state: number; findings: any[] }

export interface Alert {
  realmPk: string
  proposalPk: string
  type: PollEvent['type']
  text: string
}

/** Which proposals need their full account fetched this round. */
export function planDetailsFetch(
  seen: Record<string, SeenProposal>,
  slices: ProposalSlice[],
): string[] {
  return slices
    .filter((s) => !seen[s.pk] || ACTIVE_STATES.has(s.state) || !seen[s.pk].n)
    .map((s) => s.pk)
}

/** Which proposals need a (more expensive) transaction-content signature this round. */
export function planTxSignatures(
  seen: Record<string, SeenProposal>,
  details: Map<string, ProposalDetails>,
): string[] {
  const out: string[] = []
  for (const d of details.values()) {
    if (!ACTIVE_STATES.has(d.state)) continue
    const prev = seen[d.pk]
    // tx content can only change in Draft; once it left Draft, one final signature suffices.
    if (!prev || d.state === DRAFT || prev.txAt !== d.state || !prev.tx) out.push(d.pk)
  }
  return out
}

export interface DiffResult {
  events: PollEvent[]
  next: Record<string, SeenProposal>
  /** proposals whose safety report must be (re)computed: chk !== tx */
  needsSafety: string[]
}

/**
 * Pure diff of the previously seen proposals against the current listing.
 * Baseline (first poll of a realm): no "new"/"voting" events; already finished
 * proposals are marked as checked, active ones are scheduled for a safety check.
 */
export function diffProposals(
  seen: Record<string, SeenProposal>,
  baselineDone: boolean,
  slices: ProposalSlice[],
  details: Map<string, ProposalDetails>,
  txSigs: Map<string, string>,
): DiffResult {
  const events: PollEvent[] = []
  const next: Record<string, SeenProposal> = {}
  for (const slice of slices) {
    const det = details.get(slice.pk)
    const state = det ? det.state : slice.state
    const prev = seen[slice.pk]
    const name = (det?.name ?? prev?.n ?? '').slice(0, NAME_MAX)
    let rec: SeenProposal
    if (!prev) {
      rec = { s: state, n: name, tx: txSigs.get(slice.pk) ?? det?.countsSig ?? '' }
      if (txSigs.has(slice.pk)) rec.txAt = state
      if (!baselineDone) {
        if (!ACTIVE_STATES.has(state)) rec.chk = rec.tx
      } else {
        events.push({ type: 'new', pk: slice.pk, name, state })
      }
    } else {
      rec = { ...prev, s: state, n: name || prev.n }
      if (txSigs.has(slice.pk)) {
        rec.tx = txSigs.get(slice.pk)
        rec.txAt = state
      }
      if (baselineDone && prev.s !== VOTING && state === VOTING) {
        events.push({ type: 'voting', pk: slice.pk, name: rec.n ?? '' })
      }
    }
    next[slice.pk] = rec
  }
  const needsSafety = Object.keys(next).filter((pk) => next[pk].chk !== next[pk].tx)
  return { events, next, needsSafety }
}

export interface ChainApi {
  fetchGovernances(programId: PublicKey, realm: PublicKey): Promise<GovernanceRef[]>
  fetchProposalSlices(
    programId: PublicKey,
    governances: GovernanceRef[],
    opts: { programWide?: boolean },
  ): Promise<ProposalSlice[]>
  fetchProposalDetails(pks: string[]): Promise<Map<string, ProposalDetails>>
  fetchTransactionsSignature(programId: PublicKey, p: ProposalDetails): Promise<string>
}

export function chainApi(conn: Connection, log: (m: string) => void): ChainApi {
  return {
    fetchGovernances: (programId, realm) => fetchGovernances(conn, programId, realm),
    fetchProposalSlices: (programId, govs, opts) =>
      fetchProposalSlices(conn, programId, govs, opts),
    fetchProposalDetails: (pks) => fetchProposalDetails(conn, pks, log),
    fetchTransactionsSignature: (programId, p) =>
      fetchTransactionsSignature(conn, programId, p),
  }
}

export interface PollDeps {
  chain: ChainApi
  safety: SafetyChecker
  appUrl: string
  log: (m: string) => void
  /** programs hosting a single registered realm: list proposals with one program-wide call */
  isDedicatedProgram?: (programId: string) => boolean
  governanceRefreshMs?: number
  maxSafetyChecksPerPoll?: number
  now?: () => number
}

/**
 * Poll one realm once. Mutates `realm` (proposals, governances, baselineDone) only
 * after all RPC reads succeeded, and returns the alerts to deliver.
 */
export async function pollRealm(realm: WatchedRealm, deps: PollDeps): Promise<Alert[]> {
  const now = deps.now ?? Date.now
  const programId = new PublicKey(realm.programId)
  const refreshMs = deps.governanceRefreshMs ?? 10 * 60_000
  if (
    !realm.governances ||
    !realm.governancesFetchedAt ||
    now() - realm.governancesFetchedAt > refreshMs
  ) {
    realm.governances = await deps.chain.fetchGovernances(
      programId,
      new PublicKey(realm.realmPk),
    )
    realm.governancesFetchedAt = now()
  }
  const slices = await deps.chain.fetchProposalSlices(programId, realm.governances, {
    programWide: deps.isDedicatedProgram?.(realm.programId) ?? false,
  })
  const details = await deps.chain.fetchProposalDetails(
    planDetailsFetch(realm.proposals, slices),
  )
  const txSigs = new Map<string, string>()
  for (const pk of planTxSignatures(realm.proposals, details)) {
    txSigs.set(pk, await deps.chain.fetchTransactionsSignature(programId, details.get(pk)!))
  }

  const wasBaseline = !realm.baselineDone
  const diff = diffProposals(realm.proposals, realm.baselineDone, slices, details, txSigs)

  // Safety checks (bounded per poll; the rest is retried next round because chk stays stale).
  const max = deps.maxSafetyChecksPerPoll ?? 10
  const newPks = new Set(diff.events.filter((e) => e.type === 'new').map((e) => e.pk))
  const ordered = [
    ...diff.needsSafety.filter((pk) => newPks.has(pk)),
    ...diff.needsSafety.filter((pk) => !newPks.has(pk)),
  ].slice(0, max)
  for (const pk of ordered) {
    const rec = diff.next[pk]
    try {
      const res = await deps.safety.check(pk, realm.programId)
      rec.chk = rec.tx
      if (!res.available) continue
      const red = onlyRed(res.findings)
      if (red.length) {
        const key = dangerKey(rec.tx, red)
        if (key !== rec.red) {
          diff.events.push({ type: 'danger', pk, name: rec.n ?? '', state: rec.s, findings: red })
          rec.red = key
        }
      }
    } catch (e: any) {
      deps.log(`[safety] check failed for ${pk}: ${e?.message ?? e} (will retry next poll)`)
    }
  }

  realm.proposals = diff.next
  realm.baselineDone = true
  realm.lastPollAt = now()
  realm.lastError = undefined
  if (wasBaseline) {
    deps.log(
      `[poll] baseline for ${realm.symbol ?? realm.realmPk}: ${slices.length} proposals, ${realm.governances.length} governances`,
    )
  }

  const ref = { realmPk: realm.realmPk, symbol: realm.symbol, name: realm.name }
  return diff.events.map((e) => ({
    realmPk: realm.realmPk,
    proposalPk: e.pk,
    type: e.type,
    text:
      e.type === 'new'
        ? formatNewProposal({ appUrl: deps.appUrl, realm: ref, proposalPk: e.pk, name: e.name, state: e.state })
        : e.type === 'voting'
        ? formatVotingStarted({ appUrl: deps.appUrl, realm: ref, proposalPk: e.pk, name: e.name })
        : formatDanger({
            appUrl: deps.appUrl,
            realm: ref,
            proposalPk: e.pk,
            name: e.name,
            state: e.state,
            findings: e.findings,
          }),
  }))
}
