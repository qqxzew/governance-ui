import {
  defang,
  finalizeMessage,
  formatDanger,
  formatNewProposal,
  proposalLink,
  stripUnsafeChars,
  TELEGRAM_MAX_MESSAGE,
  truncate,
  untrusted,
} from '../text'

const realm = { realmPk: '899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo', symbol: 'MNDE', name: 'Marinade DAO' }
const PK = '7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj'

describe('Telegram text escaping (plain text, no parse_mode)', () => {
  it('strips bidi overrides, zero-width and control characters', () => {
    const rlo = String.fromCharCode(0x202e)
    const zw = String.fromCharCode(0x200b)
    const nul = String.fromCharCode(0)
    expect(stripUnsafeChars(`MIP${rlo}-23${zw}${nul}`)).toBe('MIP-23')
    expect(stripUnsafeChars('line1\nline2\ttab')).toBe('line1\nline2\ttab')
  })

  it('defangs links, bare domains and mentions so Telegram does not auto-link them', () => {
    expect(defang('Claim at https://evil.com/x now')).toBe('Claim at hxxps://evil[.]com/x now')
    expect(defang('http://a.b.io')).toBe('hxxp://a[.]b[.]io')
    expect(defang('visit marinade-airdrop.finance')).toBe('visit marinade-airdrop[.]finance')
    expect(defang('tg://resolve?domain=x')).toBe('tg[:]//resolve?domain=x')
    expect(defang('DM @MarinadeSupport')).toBe('DM [@]MarinadeSupport')
    // not over-eager on version numbers / amounts
    expect(defang('MIP-23: v1.2 upgrade, 153,600,023.53 MNDE')).toBe('MIP-23: v1.2 upgrade, 153,600,023.53 MNDE')
  })

  it('leaves Markdown/HTML metacharacters inert (no parse_mode is used)', () => {
    const name = '<a href="x">*bold*</a> _[link](http://x.yz)_ `code`'
    const out = untrusted(name)
    expect(out).toContain('<a href=')
    expect(out).toContain('*bold*')
    expect(out).toContain('hxxp://x[.]yz')
  })

  it('collapses newlines in single-line fields and truncates without breaking surrogate pairs', () => {
    expect(untrusted('a\n\n\nb')).toBe('a b')
    expect(truncate('😀😀😀', 3)).toBe('😀…')
    expect(truncate('😀😀😀', 4)).toBe('😀…')
    expect(untrusted('x'.repeat(1000), 50)).toHaveLength(50)
  })

  it('caps every outgoing message at the Telegram limit', () => {
    expect(finalizeMessage('y'.repeat(10000))).toHaveLength(TELEGRAM_MAX_MESSAGE)
  })
})

describe('formatting', () => {
  it('builds links from APP_URL with symbol or realm pubkey', () => {
    expect(proposalLink('http://localhost:3000', realm, PK)).toBe(`http://localhost:3000/dao/MNDE/proposal/${PK}`)
    expect(proposalLink('https://x.org', { realmPk: realm.realmPk }, PK)).toBe(
      `https://x.org/dao/${realm.realmPk}/proposal/${PK}`,
    )
    expect(proposalLink('https://x.org', { realmPk: 'r', symbol: "Dean's List" }, PK)).toContain("/dao/Dean's%20List/")
  })

  it('new-proposal message', () => {
    const t = formatNewProposal({ appUrl: 'http://localhost:3000', realm, proposalPk: PK, name: 'MIP-23: see evil.com', state: 2 })
    expect(t).toContain('New proposal — Marinade DAO (MNDE)')
    expect(t).toContain('Name: MIP-23: see evil[.]com')
    expect(t).toContain('State: Voting')
    expect(t).toContain(`http://localhost:3000/dao/MNDE/proposal/${PK}`)
  })

  it('danger message lists all red findings and stays under the limit', () => {
    const findings = Array.from({ length: 40 }, (_, i) => ({
      id: `f${i}`,
      severity: 'red',
      title: `Finding ${i}`,
      explanation: 'z'.repeat(2000),
      instructionIndex: i,
    }))
    const t = formatDanger({ appUrl: 'http://localhost:3000', realm, proposalPk: PK, name: 'x', state: 9, findings })
    expect(t.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE)
    expect(t).toContain('🔴 Danger')
    expect(t).toContain('State: Vetoed')
    expect(t).toContain('40 red finding(s)')
    expect(t).toContain('Finding 0 [ix 0]')
    expect(t).toMatch(/…and [0-9]+ more/)
    expect(t).toContain(`/proposal/${PK}`)
  })
})
