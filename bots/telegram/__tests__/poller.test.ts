import { PublicKey } from '@solana/web3.js'
import type { ProposalDetails, ProposalSlice } from '../chain'
import {
  ChainApi,
  diffProposals,
  planDetailsFetch,
  planTxSignatures,
  pollRealm,
  PollDeps,
} from '../poller'
import { SafetyChecker, SafetyFinding } from '../safety'
import { SeenProposal, WatchedRealm } from '../state'

const GOV = 'FsrqQfLGdFVtySSSsyZJUzVBA9bvGZSKyhp7nsJCqgJe'
const P1 = '7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj'
const P2 = 'EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9'
const P3 = 'CzXJQfKmd7hSstgEEYmAguN16UunRZfPkmj6yBDy8EZ5'

const slice = (pk: string, state: number): ProposalSlice => ({ pk, governance: GOV, accountType: 14, state })
const det = (pk: string, state: number, name = `name-${pk.slice(0, 4)}`, countsSig = '1/1'): ProposalDetails => ({
  pk,
  name,
  state,
  accountType: 14,
  draftAt: 1,
  countsSig,
})
const mapOf = (...d: ProposalDetails[]) => new Map(d.map((x) => [x.pk, x]))

describe('diffProposals', () => {
  it('baseline: records everything, no events; only active proposals need a safety check', () => {
    const r = diffProposals(
      {},
      false,
      [slice(P1, 5), slice(P2, 2)],
      mapOf(det(P1, 5), det(P2, 2)),
      new Map([[P2, 'sig2']]),
    )
    expect(r.events).toEqual([])
    expect(Object.keys(r.next).sort()).toEqual([P1, P2].sort())
    expect(r.next[P1].chk).toBe(r.next[P1].tx) // finished: no check
    expect(r.next[P2]).toMatchObject({ s: 2, tx: 'sig2', txAt: 2 })
    expect(r.needsSafety).toEqual([P2])
  })

  it('after baseline: new proposals produce events and safety checks; seen ones do not', () => {
    const seen: Record<string, SeenProposal> = { [P1]: { s: 5, n: 'old', tx: '1/1', chk: '1/1' } }
    const r = diffProposals(seen, true, [slice(P1, 5), slice(P2, 0)], mapOf(det(P2, 0, 'Fresh')), new Map([[P2, 's']]))
    expect(r.events).toEqual([{ type: 'new', pk: P2, name: 'Fresh', state: 0 }])
    expect(r.needsSafety).toEqual([P2])
    expect(r.next[P1]).toEqual(seen[P1])
  })

  it('emits a voting event on transition into Voting (only once)', () => {
    const seen = { [P1]: { s: 1, n: 'Prop', tx: 'a', txAt: 1, chk: 'a' } }
    const r = diffProposals(seen, true, [slice(P1, 2)], mapOf(det(P1, 2, 'Prop')), new Map([[P1, 'a']]))
    expect(r.events).toEqual([{ type: 'voting', pk: P1, name: 'Prop' }])
    expect(r.needsSafety).toEqual([])
    const r2 = diffProposals(r.next, true, [slice(P1, 2)], mapOf(det(P1, 2, 'Prop')), new Map())
    expect(r2.events).toEqual([])
  })

  it('re-checks safety when transactions of an active proposal change', () => {
    const seen = { [P1]: { s: 0, n: 'Prop', tx: 'a', txAt: 0, chk: 'a' } }
    const r = diffProposals(seen, true, [slice(P1, 0)], mapOf(det(P1, 0)), new Map([[P1, 'b']]))
    expect(r.events).toEqual([])
    expect(r.needsSafety).toEqual([P1])
    expect(r.next[P1].tx).toBe('b')
  })

  it('drops proposals that disappeared', () => {
    const r = diffProposals({ [P1]: { s: 5 } }, true, [], new Map(), new Map())
    expect(r.next).toEqual({})
  })
})

describe('planning', () => {
  it('fetches details only for new / active / unnamed proposals', () => {
    const seen = { [P1]: { s: 5, n: 'x' }, [P2]: { s: 2, n: 'y' }, [P3]: { s: 7 } }
    expect(planDetailsFetch(seen, [slice(P1, 5), slice(P2, 2), slice(P3, 7), slice(GOV, 0)])).toEqual([P2, P3, GOV])
  })

  it('computes tx signatures in Draft every time, otherwise once per state', () => {
    const seen = {
      [P1]: { s: 0, tx: 't', txAt: 0 },
      [P2]: { s: 2, tx: 't', txAt: 2 },
      [P3]: { s: 0, tx: 't', txAt: 0 },
    }
    const d = mapOf(det(P1, 0), det(P2, 2), det(P3, 2), det(GOV, 5))
    expect(planTxSignatures(seen, d).sort()).toEqual([P1, P3].sort())
  })
})

describe('pollRealm (fake chain + fake safety)', () => {
  const realmPk = '899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo'
  const programId = 'GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs'

  function setup(red: SafetyFinding[]) {
    let slices: ProposalSlice[] = [slice(P1, 5)]
    let details = new Map<string, ProposalDetails>([[P1, det(P1, 5, 'Old one')]])
    const calls = { governances: 0, safety: [] as string[] }
    const chain: ChainApi = {
      fetchGovernances: async () => {
        calls.governances++
        return [{ pk: GOV, t: 18 }]
      },
      fetchProposalSlices: async () => slices,
      fetchProposalDetails: async (pks) => new Map(pks.filter((p) => details.has(p)).map((p) => [p, details.get(p)!])),
      fetchTransactionsSignature: async (_prog: PublicKey, p) => `${p.countsSig}#h`,
    }
    const safety: SafetyChecker = {
      check: async (pk) => {
        calls.safety.push(pk)
        return { available: true, findings: pk === P2 ? red : [] }
      },
    }
    const realm: WatchedRealm = { realmPk, programId, symbol: 'MNDE', name: 'Marinade DAO', subscribers: [1], baselineDone: false, proposals: {} }
    const deps: PollDeps = { chain, safety, appUrl: 'https://gov.example', log: () => undefined }
    return {
      realm,
      deps,
      calls,
      set(s: ProposalSlice[], d: ProposalDetails[]) {
        slices = s
        details = mapOf(...d)
      },
    }
  }

  const RED: SafetyFinding[] = [
    { id: 'treasury-drain', severity: 'red', title: 'Drains 100% of treasury', explanation: 'Moves all MNDE to a new wallet.', instructionIndex: 0 },
    { id: 'meh', severity: 'yellow', title: 'yellow only', explanation: 'ignored' },
  ]

  it('baseline -> new proposal with red finding -> danger alert once', async () => {
    const t = setup(RED)
    expect(await pollRealm(t.realm, t.deps)).toEqual([])
    expect(t.realm.baselineDone).toBe(true)
    expect(t.calls.safety).toEqual([])

    t.set([slice(P1, 5), slice(P2, 2)], [det(P1, 5, 'Old one'), det(P2, 2, 'MIP-24: Treasury consolidation')])
    const alerts = await pollRealm(t.realm, t.deps)
    expect(alerts.map((a) => a.type)).toEqual(['new', 'danger'])
    expect(alerts[0].text).toContain('MIP-24: Treasury consolidation')
    expect(alerts[0].text).toContain(`https://gov.example/dao/MNDE/proposal/${P2}`)
    expect(alerts[1].text).toContain('🔴 Danger')
    expect(alerts[1].text).toContain('Drains 100% of treasury [ix 0]')
    expect(alerts[1].text).toContain('Moves all MNDE to a new wallet.')
    expect(alerts[1].text).not.toContain('yellow only')

    // Voting state: tx signature already computed for this state -> no new check, no repeat alert
    expect(await pollRealm(t.realm, t.deps)).toEqual([])
    expect(t.calls.safety).toEqual([P2])
    expect(t.calls.governances).toBe(1) // cached
  })

  it('Draft edits trigger a re-check; identical findings are not re-alerted for the same tx set', async () => {
    const t = setup(RED)
    await pollRealm(t.realm, t.deps)
    t.set([slice(P2, 0)], [det(P2, 0, 'Draft', '1/1')])
    expect((await pollRealm(t.realm, t.deps)).map((a) => a.type)).toEqual(['new', 'danger'])
    expect(await pollRealm(t.realm, t.deps)).toEqual([]) // same tx -> no check
    t.set([slice(P2, 0)], [det(P2, 0, 'Draft', '2/2')]) // tx inserted
    expect((await pollRealm(t.realm, t.deps)).map((a) => a.type)).toEqual(['danger'])
    expect(t.calls.safety).toEqual([P2, P2])
  })

  it('no alerts for safety when the engine is unavailable; failures are retried', async () => {
    const t = setup([])
    let fail = true
    t.deps.safety = {
      check: async () => {
        if (fail) throw new Error('rpc down')
        return { available: false, findings: [] }
      },
    }
    await pollRealm(t.realm, t.deps)
    t.set([slice(P2, 2)], [det(P2, 2)])
    expect((await pollRealm(t.realm, t.deps)).map((a) => a.type)).toEqual(['new'])
    expect(t.realm.proposals[P2].chk).toBeUndefined()
    fail = false
    expect(await pollRealm(t.realm, t.deps)).toEqual([])
    expect(t.realm.proposals[P2].chk).toBe(t.realm.proposals[P2].tx)
  })

  it('keeps previous state when an RPC read fails', async () => {
    const t = setup([])
    await pollRealm(t.realm, t.deps)
    const before = JSON.stringify(t.realm.proposals)
    t.deps.chain.fetchProposalSlices = async () => {
      throw new Error('429')
    }
    await expect(pollRealm(t.realm, t.deps)).rejects.toThrow('429')
    expect(JSON.stringify(t.realm.proposals)).toBe(before)
  })
})
