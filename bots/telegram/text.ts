/**
 * Message text helpers.
 *
 * All messages are sent WITHOUT parse_mode (plain text), so Markdown/HTML
 * metacharacters in attacker-controlled strings (proposal names, finding text)
 * cannot inject formatting or hidden links. Plain text still gets Telegram's
 * automatic entity detection (URLs, bare domains, @mentions), so untrusted text
 * is additionally "defanged": `https://evil.com` -> `hxxps://evil[.]com`,
 * `@support` -> `[@]support`. Bidi overrides / zero-width / control characters
 * (used to visually spoof names) are stripped.
 */

export const TELEGRAM_MAX_MESSAGE = 4096

// C0/C1 controls except \n and \t, bidi controls, zero-width chars, BOM, soft hyphen.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/g

export function stripUnsafeChars(s: string) {
  return s.replace(UNSAFE_CHARS, '')
}

/** Neutralise things Telegram would auto-link in plain text. */
export function defang(s: string) {
  return (
    s
      // scheme://  -> hxxp(s)://, other schemes -> scheme[:]//
      .replace(/\bhttp(s?):\/\//gi, (_m, sec) => `hxxp${sec}://`)
      .replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\//gi, (m, scheme) =>
        /^hxxps?$/i.test(scheme) ? m : `${scheme}[:]//`,
      )
      .replace(/\b(tg|mailto|tel):/gi, '$1[:]')
      // domain-like tokens: foo.com, a.b.io (TLD must be alphabetic, 2+ chars)
      .replace(
        /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.([a-z]{2,24})\b/gi,
        (_m, host, tld) => `${host.replace(/\./g, '[.]')}[.]${tld}`,
      )
      // @mentions
      .replace(/@(?=[A-Za-z0-9_]{3,})/g, '[@]')
  )
}

/** Sanitize an attacker-controlled string for embedding in a plain-text message. */
export function untrusted(s: unknown, maxLen = 300, singleLine = true) {
  let out = stripUnsafeChars(String(s ?? ''))
  if (singleLine) out = out.replace(/\s+/g, ' ')
  out = defang(out.trim())
  return truncate(out, maxLen)
}

export function truncate(s: string, maxLen: number) {
  const chars = Array.from(s) // don't split surrogate pairs
  if (chars.length <= maxLen) return s
  return chars.slice(0, Math.max(0, maxLen - 1)).join('') + '…'
}

/** Final guard for any outgoing message. */
export function finalizeMessage(s: string) {
  return truncate(stripUnsafeChars(s), TELEGRAM_MAX_MESSAGE)
}

export const PROPOSAL_STATE_NAMES = [
  'Draft',
  'SigningOff',
  'Voting',
  'Succeeded',
  'Executing',
  'Completed',
  'Cancelled',
  'Defeated',
  'ExecutingWithErrors',
  'Vetoed',
]

export function stateName(state: number) {
  return PROPOSAL_STATE_NAMES[state] ?? `Unknown(${state})`
}

export interface RealmRef {
  realmPk: string
  symbol?: string
  name?: string
}

export function proposalLink(appUrl: string, realm: RealmRef, proposalPk: string) {
  const slug = realm.symbol ? encodeURIComponent(realm.symbol) : realm.realmPk
  return `${appUrl}/dao/${slug}/proposal/${proposalPk}`
}

export function realmLabel(realm: RealmRef) {
  const name = realm.name ? untrusted(realm.name, 60) : undefined
  if (name && realm.symbol) return `${name} (${untrusted(realm.symbol, 45)})`
  return name || (realm.symbol ? untrusted(realm.symbol, 45) : realm.realmPk)
}

export function formatNewProposal(args: {
  appUrl: string
  realm: RealmRef
  proposalPk: string
  name: string
  state: number
}) {
  return finalizeMessage(
    [
      `🆕 New proposal — ${realmLabel(args.realm)}`,
      '',
      `Name: ${untrusted(args.name, 200)}`,
      `State: ${stateName(args.state)}`,
      `Proposal: ${args.proposalPk}`,
      '',
      proposalLink(args.appUrl, args.realm, args.proposalPk),
    ].join('\n'),
  )
}

export function formatVotingStarted(args: {
  appUrl: string
  realm: RealmRef
  proposalPk: string
  name: string
}) {
  return finalizeMessage(
    [
      `🗳 Voting started — ${realmLabel(args.realm)}`,
      '',
      `Name: ${untrusted(args.name, 200)}`,
      `Proposal: ${args.proposalPk}`,
      '',
      proposalLink(args.appUrl, args.realm, args.proposalPk),
    ].join('\n'),
  )
}

export interface FindingLike {
  id: string
  severity: string
  title: string
  explanation: string
  instructionIndex?: number
}

export function formatDanger(args: {
  appUrl: string
  realm: RealmRef
  proposalPk: string
  name: string
  state: number
  findings: FindingLike[]
}) {
  const header = [
    `🔴 Danger — ${realmLabel(args.realm)}`,
    '',
    `Name: ${untrusted(args.name, 200)}`,
    `State: ${stateName(args.state)}`,
    `Proposal: ${args.proposalPk}`,
    '',
    `${args.findings.length} red finding(s):`,
  ]
  const footer = [
    '',
    proposalLink(args.appUrl, args.realm, args.proposalPk),
    '',
    'Automated check by an unaudited, evaluation-grade tool. Review the instructions yourself before voting.',
  ]
  const budget =
    TELEGRAM_MAX_MESSAGE - header.join('\n').length - footer.join('\n').length - 50
  const perFinding = Math.max(
    120,
    Math.floor(budget / Math.max(1, args.findings.length)),
  )
  const body = args.findings.map((f) => {
    const ix =
      typeof f.instructionIndex === 'number' ? ` [ix ${f.instructionIndex}]` : ''
    return truncate(
      `• ${untrusted(f.title, 150)}${ix}\n  ${untrusted(f.explanation, 1500)}`,
      perFinding,
    )
  })
  return finalizeMessage([...header, ...body, ...footer].join('\n'))
}
