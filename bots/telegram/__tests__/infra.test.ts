import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PublicKey } from '@solana/web3.js'
import { encodeBase58, transactionsSignature, typeAndKeyFilter } from '../chain'
import { parseDotEnv } from '../env'
import { backoffDelay } from '../rpc'
import { dangerKey, loadEngine, makeSafetyChecker, onlyRed } from '../safety'
import { emptyState, loadState, saveState } from '../state'

const MARINADE = '899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo'

describe('chain helpers', () => {
  it('encodeBase58 matches PublicKey.toBase58 and handles leading zeros', () => {
    const pk = new PublicKey(MARINADE)
    expect(encodeBase58(pk.toBytes())).toBe(MARINADE)
    expect(encodeBase58(new Uint8Array(32))).toBe('1'.repeat(32))
    expect(encodeBase58(Uint8Array.of(0, 0, 1))).toBe('112')
  })

  it('typeAndKeyFilter encodes type byte + 32-byte key at offset 0', () => {
    const f = typeAndKeyFilter(18, new PublicKey(MARINADE))
    expect(f.memcmp.offset).toBe(0)
    // decode back via PublicKey on the tail: re-encode expected bytes
    const expected = encodeBase58(Buffer.concat([Buffer.from([18]), new PublicKey(MARINADE).toBuffer()]))
    expect(f.memcmp.bytes).toBe(expected)
  })

  it('transactionsSignature is order independent and content sensitive', () => {
    const a = { pubkey: 'A', data: Uint8Array.of(1, 2) }
    const b = { pubkey: 'B', data: Uint8Array.of(3) }
    expect(transactionsSignature('1/1', [a, b])).toBe(transactionsSignature('1/1', [b, a]))
    expect(transactionsSignature('1/1', [a, b])).not.toBe(
      transactionsSignature('1/1', [a, { pubkey: 'B', data: Uint8Array.of(4) }]),
    )
  })
})

describe('state.json persistence', () => {
  it('round-trips atomically and leaves no temp files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgbot-'))
    const file = path.join(dir, 'nested', 'state.json')
    expect(loadState(file)).toEqual(emptyState())
    const s = emptyState()
    s.telegramOffset = 77
    s.realms[MARINADE] = { realmPk: MARINADE, programId: 'p', subscribers: [1], baselineDone: true, proposals: { x: { s: 2 } } }
    saveState(file, s)
    saveState(file, s) // overwrite existing
    expect(loadState(file)).toEqual(s)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['state.json'])
    fs.writeFileSync(file, '{"version":2}')
    expect(() => loadState(file)).toThrow(/Unrecognised/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('env parsing', () => {
  it('parses .env lines', () => {
    const env = parseDotEnv(
      ['# c', 'A=1', 'export B="two words"', "C='x#y'", 'D=val # comment', 'bad line', 'E='].join('\r\n'),
    )
    expect(env).toEqual({ A: '1', B: 'two words', C: 'x#y', D: 'val', E: '' })
  })
})

describe('rpc backoff', () => {
  it('honours Retry-After and grows exponentially with a cap', () => {
    expect(backoffDelay(0, '2')).toBe(2000)
    for (let i = 0; i < 20; i++) {
      const d = backoffDelay(3, null, 1000, 30000)
      expect(d).toBeGreaterThanOrEqual(4000)
      expect(d).toBeLessThanOrEqual(8000)
    }
    expect(backoffDelay(10, null, 1000, 30000)).toBeLessThanOrEqual(30000)
  })
})

describe('safety adapter', () => {
  it('works without the engine (no findings)', async () => {
    const missing = loadEngine(path.join(os.tmpdir(), 'definitely-missing-engine'), () => undefined)
    expect(missing).toBeNull()
    const checker = makeSafetyChecker({} as any, null)
    await expect(checker.check(MARINADE, MARINADE)).resolves.toEqual({ available: false, findings: [] })
  })

  it('loads an engine exposing the documented API and passes programId', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'))
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `exports.loadProposalSafetyInput = async (c, pk, o) => ({ pk: pk.toBase58(), prog: o.programId.toBase58() });
       exports.analyzeProposal = (i) => ({ actions: [], maxSeverity: 'red', findings: [
         { id: 'x', severity: 'red', title: i.prog, explanation: i.pk },
         { id: 'y', severity: 'yellow', title: 't', explanation: 'e' } ] });`,
    )
    const engine = loadEngine(dir, () => undefined)
    expect(engine).not.toBeNull()
    const res = await makeSafetyChecker({} as any, engine).check(MARINADE, 'GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs')
    expect(res.available).toBe(true)
    expect(onlyRed(res.findings)).toEqual([
      { id: 'x', severity: 'red', title: 'GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs', explanation: MARINADE },
    ])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rejects modules without the expected exports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'))
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.somethingElse = 1')
    const logs: string[] = []
    expect(loadEngine(dir, (m) => logs.push(m))).toBeNull()
    expect(logs[0]).toMatch(/expected API/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('dangerKey is order independent', () => {
    const a = { id: 'a', severity: 'red' as const, title: '', explanation: '', instructionIndex: 0 }
    const b = { id: 'b', severity: 'red' as const, title: '', explanation: '' }
    expect(dangerKey('t', [a, b])).toBe(dangerKey('t', [b, a]))
    expect(dangerKey('t', [a])).not.toBe(dangerKey('u', [a]))
  })
})
