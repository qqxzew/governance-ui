import fs from 'fs'
import path from 'path'
import BN from 'bn.js'
import {
  decodeRegistrar,
  decodeVoter,
  voterWeight,
  LockupKind,
  SECS_PER_DAY,
} from '../votingPower'
import { checkVoteWeight, decodeVoteRecordV2 } from '../sanityCheck'

const DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'marinade',
  'vsr',
)
const load = (f: string) =>
  JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))

describe('checkVoteWeight', () => {
  it('"match" when the recorded weight equals the program weight at the vote time', () => {
    // simulation fixture: VoterWeightRecord weight computed by the program at clock.unixTimestamp
    const f = load('voter-A7VyquvRygnugmhN3XAwWrRoYy8bpfj2Swsb5wjVwqS.json')
    const res = checkVoteWeight({
      recordedWeight: new BN(f.expected.voterWeightRecordWeight),
      voter: decodeVoter(Buffer.from(f.accounts.voterDataBase64, 'base64')),
      registrar: decodeRegistrar(
        Buffer.from(f.accounts.registrarDataBase64, 'base64'),
      ),
      voteUnixTimestamp: Number(f.clock.unixTimestamp),
      accountsAreFromVoteSlot: true,
    })
    expect(res.status).toBe('match')
    expect(res.reasons).toEqual([])
  })

  it('"needs review" (never "attack") when the recorded weight is outside the recomputed range', () => {
    const f = load('voter-24533yAaXiD68inmrr2uBafRZ3hw4jCb7qd9nLDKSWFm.json')
    const res = checkVoteWeight({
      recordedWeight: new BN(f.expected.voterWeightRecordWeight).muln(2),
      voter: decodeVoter(Buffer.from(f.accounts.voterDataBase64, 'base64')),
      registrar: decodeRegistrar(
        Buffer.from(f.accounts.registrarDataBase64, 'base64'),
      ),
      voteUnixTimestamp: Number(f.clock.unixTimestamp),
    })
    expect(res.status).toBe('needs review')
    expect(JSON.stringify(res).toLowerCase()).not.toContain('attack')
    expect(res.reasons[0]).toMatch(/above the recomputed maximum/)
    // caveat about state read after the vote is always included unless accountsAreFromVoteSlot
    expect(res.reasons.join(' ')).toMatch(/read after the vote/)
  })

  it('no Voter account: recorded 0 matches, recorded > 0 needs review', () => {
    const f = load('voter-19VAbqsZEMZ6Pk4bKH6oBkzd7jdcEvTAJcjcdhWSjSt.json')
    const registrar = decodeRegistrar(
      Buffer.from(f.accounts.registrarDataBase64, 'base64'),
    )
    expect(
      checkVoteWeight({
        recordedWeight: new BN(0),
        voter: null,
        registrar,
        voteUnixTimestamp: 0,
      }).status,
    ).toBe('match')
    expect(
      checkVoteWeight({
        recordedWeight: new BN(5),
        voter: null,
        registrar,
        voteUnixTimestamp: 0,
      }).status,
    ).toBe('needs review')
  })

  it('real Marinade vote (legit DENY on Gd5CfxVQ): flagged "needs review" against the post-2026-09-25 registrar', () => {
    const f = load(
      'vote-CMbdJVZxt1GydyQ6nLXeKqVh2wnGkDwkiLGpEpc2FkP7-Gd5CfxVQ.json',
    )
    const vr = decodeVoteRecordV2(Buffer.from(f.voteRecordDataBase64, 'base64'))
    expect(vr.proposal.toBase58()).toBe(f.proposal)
    expect(vr.governingTokenOwner.toBase58()).toBe(f.voterAuthority)
    expect(vr.voterWeight.toString()).toBe('30654345000000000')
    const voter = decodeVoter(Buffer.from(f.voterDataBase64, 'base64'))
    const registrar = decodeRegistrar(
      Buffer.from(f.registrarDataBase64, 'base64'),
    )
    const res = checkVoteWeight({
      recordedWeight: vr.voterWeight,
      voter,
      registrar,
      voteUnixTimestamp: f.voteBlockTime,
    })
    expect(res.status).toBe('needs review')
    // The voter holds one 30-day Constant lockup. With today's 31-day saturation the weight is
    // amount × 30/31; the recorded weight equals the full amount, i.e. what a saturation <= 30 days gives.
    // This is consistent with the registrar config having been changed after the vote (CzXJQfKm), which is
    // exactly the kind of benign explanation "needs review" is meant to surface.
    const used = voter.deposits.filter(
      (d) => d.isUsed && !d.amountDepositedNative.isZero(),
    )
    expect(used.length).toBe(1)
    expect(used[0].lockup.kind).toBe(LockupKind.Constant)
    expect(used[0].lockup.endTs.sub(used[0].lockup.startTs).toString()).toBe(
      SECS_PER_DAY.muln(30).toString(),
    )
    const with30dSaturation = {
      ...registrar,
      votingMints: registrar.votingMints.map((m, i) =>
        i === 0 ? { ...m, lockupSaturationSecs: SECS_PER_DAY.muln(30) } : m,
      ),
    }
    expect(
      voterWeight(voter, with30dSaturation, f.voteBlockTime).toString(),
    ).toBe(vr.voterWeight.toString())
  })
})
