/**
 * Verifies tools/vsr/votingPower.ts against the DEPLOYED Marinade VSR program.
 *
 * Each fixture in fixtures/marinade/vsr/voter-*.json was produced by tools/vsr/scripts/snapshotFixtures.js:
 * one mainnet simulateTransaction running log_voter_info + update_voter_weight_record, returning the
 * Voter, Registrar, VoterWeightRecord and Clock sysvar accounts from the same bank. So
 *   expected.voterWeightRecordWeight = what the program wrote into VoterWeightRecord.voter_weight
 *   clock.unixTimestamp               = the Clock the program saw.
 * We recompute from the snapshotted account bytes at that timestamp and require exact equality.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import BN from 'bn.js'
import {
  decodeRegistrar,
  decodeVoter,
  voterWeight,
  voterWeightBaseline,
  depositVotingPower,
  amountUnlocked,
  registrarTimestamp,
  summarizeVoter,
  unlockedDepositsHaveNoVotingPower,
  previewCliffVotingPower,
  LockupKind,
  REGISTRAR_DISCRIMINATOR,
  VOTER_DISCRIMINATOR,
  VOTER_WEIGHT_RECORD_DISCRIMINATOR,
  SECS_PER_DAY,
} from '../votingPower'

const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'marinade', 'vsr')
const fixtures = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.startsWith('voter-') && f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')))

const disc = (s: string) => crypto.createHash('sha256').update(s).digest().subarray(0, 8)

describe('VSR account discriminators', () => {
  it('match anchor sha256 prefixes', () => {
    expect(REGISTRAR_DISCRIMINATOR.equals(disc('account:Registrar'))).toBe(true)
    expect(VOTER_DISCRIMINATOR.equals(disc('account:Voter'))).toBe(true)
    expect(VOTER_WEIGHT_RECORD_DISCRIMINATOR.equals(disc('account:VoterWeightRecord'))).toBe(true)
  })
})

describe('Marinade registrar decode', () => {
  it('matches the verified on-chain config (CLAUDE.md)', () => {
    const r = decodeRegistrar(Buffer.from(fixtures[0].accounts.registrarDataBase64, 'base64'))
    expect(r.realm.toBase58()).toBe('899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo')
    expect(r.governanceProgramId.toBase58()).toBe('GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs')
    expect(r.realmGoverningTokenMint.toBase58()).toBe('MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey')
    const m = r.votingMints[0]
    expect(m.mint.toBase58()).toBe('MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey')
    expect(m.baselineVoteWeightScaledFactor.toString()).toBe('0')
    expect(m.maxExtraLockupVoteWeightScaledFactor.toString()).toBe('1000000000')
    expect(m.lockupSaturationSecs.toString()).toBe('2678400')
    expect(m.digitShift).toBe(0)
    expect(r.timeOffset.toString()).toBe('0')
    expect(unlockedDepositsHaveNoVotingPower(r, m.mint)).toBe(true)
  })
})

describe('voter weight == deployed program (simulated update_voter_weight_record)', () => {
  it('has at least 3 fixtures with locked deposits', () => {
    const withPower = fixtures.filter((f) => f.expected.voterWeightRecordWeight !== '0')
    expect(withPower.length).toBeGreaterThanOrEqual(3)
  })

  for (const f of fixtures) {
    describe(`voter ${f.voter}`, () => {
      const registrar = decodeRegistrar(Buffer.from(f.accounts.registrarDataBase64, 'base64'))
      const voter = decodeVoter(Buffer.from(f.accounts.voterDataBase64, 'base64'))
      const ts = new BN(f.clock.unixTimestamp)

      it('decodes consistently', () => {
        expect(voter.voterAuthority.toBase58()).toBe(f.voterAuthority)
        expect(voter.registrar.toBase58()).toBe(f.registrar)
      })

      it(`Voter::weight at ts ${f.clock.unixTimestamp} == VoterWeightRecord.voter_weight ${f.expected.voterWeightRecordWeight}`, () => {
        expect(voterWeight(voter, registrar, ts).toString()).toBe(f.expected.voterWeightRecordWeight)
        expect(f.expected.voterWeightRecordExpirySlot).toBe(f.clock.slot)
      })

      it('matches log_voter_info VoterInfo + every DepositEntryInfo (voting_power, unlocked, baseline)', () => {
        expect(voterWeight(voter, registrar, ts).toString()).toBe(f.expected.logVoterInfo.votingPower)
        expect(voterWeightBaseline(voter, registrar).toString()).toBe(f.expected.logVoterInfo.votingPowerBaseline)
        const currTs = registrarTimestamp(registrar, ts)
        const used = voter.deposits.map((d, i) => ({ d, i })).filter((x) => x.d.isUsed)
        expect(used.length).toBe(f.expected.logDepositEntryInfo.length)
        for (const ev of f.expected.logDepositEntryInfo) {
          const d = voter.deposits[ev.depositEntryIndex]
          const cfg = registrar.votingMints[d.votingMintConfigIdx]
          expect(depositVotingPower(d, cfg, currTs).toString()).toBe(ev.votingPower)
          expect(amountUnlocked(d, currTs).toString()).toBe(ev.unlocked)
        }
      })

      it('is time-sensitive for decaying lockups (guards against a trivially-passing comparison)', () => {
        const currTs = registrarTimestamp(registrar, ts)
        const decaying = voter.deposits.some(
          (d) =>
            d.isUsed &&
            d.lockup.kind !== LockupKind.Constant &&
            d.lockup.kind !== LockupKind.None &&
            d.lockup.endTs.gt(currTs),
        )
        // far future: every non-Constant lockup has expired by then
        const later = voterWeight(voter, registrar, ts.add(new BN(200 * 365 * 86_400))).toString()
        if (decaying) expect(later).not.toBe(f.expected.voterWeightRecordWeight)
        else expect(later).toBe(f.expected.voterWeightRecordWeight)
      })

      it('summary is consistent with the weight', () => {
        const s = summarizeVoter(voter, registrar, ts)
        expect(s.votingPower.toString()).toBe(f.expected.voterWeightRecordWeight)
        const sumDeposits = s.deposits.reduce((a, d) => a.add(d.votingPower), new BN(0))
        expect(sumDeposits.toString()).toBe(s.votingPower.toString())
        // baseline factor 0 => every unlocked token earns nothing
        expect(s.unlockedWithoutVotingPowerNative.toString()).toBe(s.unlockedNative.toString())
      })
    })
  }
})

describe('decay explanation used in the UI (Marinade config: baseline 0, factor 1.0, saturation 31d)', () => {
  const registrar = decodeRegistrar(Buffer.from(fixtures[0].accounts.registrarDataBase64, 'base64'))
  const cfg = registrar.votingMints[0]
  const amount = new BN('100000000000') // 100 MNDE
  it('power = locked × min(remaining / 31 days, 1) for cliff', () => {
    expect(previewCliffVotingPower(cfg, amount, SECS_PER_DAY.muln(31)).toString()).toBe('100000000000')
    expect(previewCliffVotingPower(cfg, amount, SECS_PER_DAY.muln(365)).toString()).toBe('100000000000')
    expect(previewCliffVotingPower(cfg, amount, SECS_PER_DAY.muln(31).divn(2)).toString()).toBe('50000000000')
    expect(previewCliffVotingPower(cfg, amount, SECS_PER_DAY).toString()).toBe(amount.divn(31).toString())
  })
  it('unlocked deposit (LockupKind::None) = 0', () => {
    expect(previewCliffVotingPower(cfg, amount, new BN(0), LockupKind.None).toString()).toBe('0')
  })
})
