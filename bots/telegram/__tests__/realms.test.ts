import { PublicKey } from '@solana/web3.js'
import {
  buildRegistry,
  classifyRealmInput,
  loadRegistry,
  resolveFromRegistry,
  resolveRealm,
  UserInputError,
} from '../realms'

const MARINADE = '899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo'
const GOV_MAI = 'GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs'
const SHARED = 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw'
const SYSTEM = '11111111111111111111111111111111'

describe('classifyRealmInput', () => {
  it('accepts base58 public keys', () => {
    expect(classifyRealmInput(MARINADE)).toEqual({ kind: 'pubkey', pubkey: MARINADE })
    expect(classifyRealmInput(`  ${MARINADE} `)).toEqual({ kind: 'pubkey', pubkey: MARINADE })
    expect(classifyRealmInput(SYSTEM)).toEqual({ kind: 'pubkey', pubkey: SYSTEM })
  })

  it('accepts symbols, including registry punctuation', () => {
    expect(classifyRealmInput('MNDE')).toEqual({ kind: 'symbol', symbol: 'MNDE' })
    expect(classifyRealmInput("Dean's List Solarplex State")).toEqual({
      kind: 'symbol',
      symbol: "Dean's List Solarplex State",
    })
    expect(classifyRealmInput('$HOPE').kind).toBe('symbol')
  })

  it('rejects invalid input with user-facing errors', () => {
    expect(() => classifyRealmInput('')).toThrow(UserInputError)
    expect(() => classifyRealmInput(undefined)).toThrow(/Missing realm/)
    expect(() => classifyRealmInput('x'.repeat(65))).toThrow(/too long/)
    expect(() => classifyRealmInput('899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6M0')).toThrow(/not base58/)
    expect(() => classifyRealmInput('I'.repeat(44))).toThrow(/not base58/)
    // 45 base58 chars: too long for a pubkey
    expect(() => classifyRealmInput(MARINADE + 'z')).toThrow(/Invalid public key/)
    // valid alphabet but decodes to > 32 bytes
    expect(() => classifyRealmInput('z'.repeat(44))).toThrow(/32-byte/)
    expect(() => classifyRealmInput('MNDE; rm -rf /')).toThrow(/Invalid realm/)
    expect(() => classifyRealmInput('<b>hi</b>')).toThrow(/Invalid realm/)
    expect(() => classifyRealmInput('MNDE\nMNGO')).toThrow(/Invalid realm/)
  })
})

describe('registry', () => {
  const reg = loadRegistry()

  it('resolves MNDE from public/realms/mainnet-beta.json to the custom Marinade program', () => {
    const r = resolveFromRegistry({ kind: 'symbol', symbol: 'mnde' }, reg)
    expect(r.realmPk).toBe(MARINADE)
    expect(r.entry?.programId).toBe(GOV_MAI)
    const byPk = resolveFromRegistry({ kind: 'pubkey', pubkey: MARINADE }, reg)
    expect(byPk.entry?.symbol).toBe('MNDE')
  })

  it('normalizes whitespace/case in symbols and rejects unknown ones', () => {
    const r = buildRegistry([{ symbol: 'Grape Protocol', programId: SHARED, realmId: SYSTEM }])
    expect(resolveFromRegistry({ kind: 'symbol', symbol: 'grape   protocol' }, r).realmPk).toBe(SYSTEM)
    expect(() => resolveFromRegistry({ kind: 'symbol', symbol: 'NOPE' }, r)).toThrow(/Unknown realm symbol/)
  })

  it('unknown pubkeys pass through without a registry entry', () => {
    const r = resolveFromRegistry({ kind: 'pubkey', pubkey: SYSTEM }, buildRegistry([]))
    expect(r).toEqual({ realmPk: SYSTEM, entry: undefined })
  })
})

describe('resolveRealm (on-chain verification, fake connection)', () => {
  const reg = buildRegistry([
    { symbol: 'MNDE', displayName: 'Marinade', programId: GOV_MAI, realmId: MARINADE },
  ])
  const fake = (owner: string, data: number[] | null) => ({
    getAccountInfo: async (_pk: PublicKey) =>
      data === null
        ? null
        : { owner: new PublicKey(owner), data: Buffer.from(data), lamports: 1, executable: false },
  })

  it('takes the program id from the account owner for unregistered realms', async () => {
    const r = await resolveRealm(SYSTEM, reg, fake(SHARED, [16, 0, 0]))
    expect(r).toMatchObject({ realmPk: SYSTEM, programId: SHARED, symbol: undefined })
  })

  it('uses the registry symbol and name fallback for registered realms', async () => {
    const r = await resolveRealm('mnde', reg, fake(GOV_MAI, [16]))
    expect(r).toMatchObject({ realmPk: MARINADE, programId: GOV_MAI, symbol: 'MNDE', name: 'Marinade' })
  })

  it('rejects missing accounts, non-realm accounts and owner mismatches', async () => {
    await expect(resolveRealm(SYSTEM, reg, fake(SHARED, null))).rejects.toThrow(/does not exist/)
    await expect(resolveRealm(SYSTEM, reg, fake(SHARED, [17]))).rejects.toThrow(/not an SPL Governance realm/)
    await expect(resolveRealm('MNDE', reg, fake(SHARED, [16]))).rejects.toThrow(/Refusing/)
  })
})
