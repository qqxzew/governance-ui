/**
 * Marinade DAO fixtures (snapshotted from mainnet by scripts/snapshot/marinade.ts). No network.
 */
import * as fs from 'fs'
import * as path from 'path'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import {
  GoverningTokenConfigAccountArgs,
  GoverningTokenType,
  MintMaxVoteWeightSource,
  withSetRealmConfig,
} from '@solana/spl-governance'
import { BN } from '@coral-xyz/anchor'
import { analyzeProposal } from '../analyze'
import { ProposalSafetyInput, ProposalSafetyReport } from '../types'

const DIR = path.join(__dirname, '..', '..', '..', 'fixtures', 'marinade')
const load = (pk: string): ProposalSafetyInput => JSON.parse(fs.readFileSync(path.join(DIR, `${pk}.json`), 'utf8'))
const ids = (r: ProposalSafetyReport, sev: string) => r.findings.filter((f) => f.severity === sev).map((f) => f.id)

const MIP23 = '7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj'
const MIP24 = 'EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9'
const BENIGN = [
  'CrbL16mpZRFJwKqkMsnVjHRP44n422opfQ1pGRL6zGoz', // USDC Vault allocator update (unknown program -> yellow)
  'Gd5CfxVQ1UYm4wToL5SVb9QhmCtcBTHo73QDnGMAmu6S', // legit MIP-23 PSR (no instructions)
  'CzXJQfKmd7hSstgEEYmAguN16UunRZfPkmj6yBDy8EZ5', // council VSR config fix (yellow)
  'E7HKLcSe86pFf4jC3nZVEwzLhKGYMLXwo8N5YTcVBk1B', // Distribution to partners (known payees)
  'J13YPM2NQkrqCCrkg6WgQ4978Ln7YYusALAYb3B4bmx9', // MIP-12, treasury -> council (internal)
  'Avfo4opueUWPxZUUVWuiuXaf8qL6vX6iP5Kqq2i1ThM2', // Council Ops Treasury Transfer (known payee)
]

describe('MIP-23 (fake VSR "routine upgrade")', () => {
  const r = analyzeProposal(load(MIP23))

  it('is red with plugin replacement, description mismatch and no hold-up', () => {
    expect(r.maxSeverity).toBe('red')
    expect(ids(r, 'red')).toEqual(expect.arrayContaining(['VOTER_WEIGHT_PLUGIN_REPLACEMENT', 'DESCRIPTION_MISMATCH', 'NO_HOLDUP']))
  })

  it('explains it in plain language', () => {
    const plugin = r.findings.find((f) => f.id === 'VOTER_WEIGHT_PLUGIN_REPLACEMENT')!
    expect(plugin.explanation).toContain('This replaces the code of the program that counts votes')
    expect(plugin.explanation).toContain('Whoever writes that code decides voting power')
    expect(plugin.instructionIndex).toBe(0)
    const mismatch = r.findings.find((f) => f.id === 'DESCRIPTION_MISMATCH')!
    expect(mismatch.explanation).toMatch(/^Description says: '.*No parameter changes'\. Actually: replaces the code of the voting program/)
    expect(r.actions[0].kind).toBe('bpf-upgrade')
    expect(r.actions[0].summary).toContain('VoteMBh'.slice(0, 4))
  })

  it('the old generic check would not fire: buffer authority is the DAO', () => {
    const input = load(MIP23)
    expect(input.buffers['FoNxMcVr5rhHcbC4hZUf88RpVR5QomKK7SWT17SQ4kAv']).toMatchObject({ exists: true, authority: '2w6ny74cU6yRxkD6ZACh5M1JznLQ1KB6AUsB7zo2NBHX' })
    expect(r.findings.find((f) => f.id === 'PROGRAM_UPGRADE')!.severity).toBe('yellow')
  })
})

describe('MIP-24 (fake "treasury consolidation")', () => {
  const r = analyzeProposal(load(MIP24))

  it('is red: treasury outflow + no hold-up + description mismatch', () => {
    expect(r.maxSeverity).toBe('red')
    expect(ids(r, 'red')).toEqual(expect.arrayContaining(['TREASURY_OUTFLOW', 'NO_HOLDUP', 'DESCRIPTION_MISMATCH']))
  })

  it('names the 153.6M MNDE, 100%, and the never-paid destination', () => {
    const first = r.findings.find((f) => f.id === 'TREASURY_OUTFLOW' && f.instructionIndex === 0)!
    expect(first.severity).toBe('red')
    expect(first.explanation).toContain('153,600,023.54 MNDE')
    expect(first.explanation).toContain('~153.6M')
    expect(first.explanation).toContain('100% of that treasury account')
    expect(first.explanation).toContain('3Pvi')
    expect(first.explanation).toContain('This DAO has never paid this address before.')
    const outflows = r.findings.filter((f) => f.id === 'TREASURY_OUTFLOW' && f.severity === 'red')
    expect(outflows.length).toBeGreaterThanOrEqual(3)
    expect(r.findings.some((f) => f.id === 'DESCRIPTION_MISMATCH' && /Consolidat/.test(f.explanation) && /not owned by the DAO/.test(f.explanation))).toBe(true)
  })
})

describe('benign Marinade proposals', () => {
  it.each(BENIGN)('%s has zero red findings', (pk) => {
    const r = analyzeProposal(load(pk))
    expect(ids(r, 'red')).toEqual([])
  })

  it('USDC vault allocator update: unknown program is an explicit yellow, never silent', () => {
    const r = analyzeProposal(load('CrbL16mpZRFJwKqkMsnVjHRP44n422opfQ1pGRL6zGoz'))
    const f = r.findings.find((x) => x.id === 'UNKNOWN_PROGRAM')!
    expect(f.severity).toBe('yellow')
    expect(f.title).toMatch(/cannot explain what this does/)
  })

  it('council VSR config fix is yellow with a "what changes" diff', () => {
    const r = analyzeProposal(load('CzXJQfKmd7hSstgEEYmAguN16UunRZfPkmj6yBDy8EZ5'))
    expect(r.maxSeverity).toBe('yellow')
    expect(r.changes.find((c) => c.label.startsWith('Lockup needed'))!.new).toBe('31 days')
  })

  it('a large outflow to a known payee is still red by size (Operational expenses, 4,403 mSOL)', () => {
    const r = analyzeProposal(load('GmfQWScCHqV8sEyAQFvzQf8caPwRqmSiX4hU366nEN5n'))
    const f = r.findings.find((x) => x.id === 'TREASURY_OUTFLOW')!
    expect(f.severity).toBe('red')
    expect(f.explanation).toContain('This DAO has paid this address before.')
  })
})

describe('synthetic: SetRealmConfig swapping the voter-weight plugin', () => {
  it('flags VOTER_WEIGHT_PLUGIN_REPLACEMENT with an old -> new diff', async () => {
    const input = load(MIP23)
    const evil = new PublicKey('EwH7cKSPmkuAjAu5t772vjfv1EPN6iAU857JKqcxTPQA')
    const ixs: TransactionInstruction[] = []
    await withSetRealmConfig(
      ixs,
      new PublicKey(input.realm.programId),
      3,
      new PublicKey(input.realm.pubkey),
      new PublicKey(input.realm.authority!),
      new PublicKey(input.realm.councilMint!),
      new MintMaxVoteWeightSource({ type: 0, value: new BN('10000000000') }),
      new BN(input.realm.minCommunityTokensToCreateGovernance!),
      new GoverningTokenConfigAccountArgs({ voterWeightAddin: evil, maxVoterWeightAddin: undefined, tokenType: GoverningTokenType.Liquid }),
      new GoverningTokenConfigAccountArgs({ voterWeightAddin: undefined, maxVoterWeightAddin: undefined, tokenType: GoverningTokenType.Liquid }),
      undefined,
    )
    input.instructions = [{
      index: 0, txIndex: 0, ixIndexInTx: 0, optionIndex: 0, holdUpTime: 0, executedAt: null,
      programId: ixs[0].programId.toBase58(),
      accounts: ixs[0].keys.map((a) => ({ pubkey: a.pubkey.toBase58(), isSigner: a.isSigner, isWritable: a.isWritable })),
      dataBase64: Buffer.from(ixs[0].data).toString('base64'),
    }]
    const r = analyzeProposal(input)
    expect(ids(r, 'red')).toEqual(expect.arrayContaining(['VOTER_WEIGHT_PLUGIN_REPLACEMENT', 'DESCRIPTION_MISMATCH', 'NO_HOLDUP']))
    const diff = r.changes.find((c) => c.key === 'realm.communityVoterWeightAddin')!
    expect(diff).toMatchObject({ old: 'VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS', new: evil.toBase58(), changed: true })
  })
})

describe('analyzeProposal is pure', () => {
  it('is deterministic and does not mutate input', () => {
    const input = load(MIP24)
    const before = JSON.stringify(input)
    const a = analyzeProposal(input)
    const b = analyzeProposal(input)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(input)).toBe(before)
  })
})
