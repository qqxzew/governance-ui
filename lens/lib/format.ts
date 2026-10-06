// Client-safe helpers (no Node / Solana imports).

export const STATE_NAMES: Record<number, string> = {
  0: 'Draft',
  1: 'Signing off',
  2: 'Voting',
  3: 'Succeeded',
  4: 'Executing',
  5: 'Completed',
  6: 'Cancelled',
  7: 'Defeated',
  8: 'Executed with errors',
  9: 'Vetoed',
}

export const FINAL_STATES = new Set([3, 5, 6, 7, 8, 9])

export const short = (a: string | null | undefined, n = 4) =>
  !a ? '—' : a.length <= 2 * n + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`

export function fmtDate(unix: number | null | undefined) {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/** Native integer string -> human amount with grouping. */
export function fmtAmount(native: string, decimals: number, maxFrac = 2) {
  if (!native) return '0'
  const neg = native.startsWith('-')
  const s = (neg ? native.slice(1) : native).padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals) || '0'
  let frac = decimals ? s.slice(s.length - decimals).slice(0, maxFrac) : ''
  frac = frac.replace(/0+$/, '')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + grouped + (frac ? '.' + frac : '')
}

/** Compact: 153.6M, 29.8K. */
export function fmtCompact(native: string, decimals: number) {
  const n = Number(native) / 10 ** decimals
  if (!isFinite(n)) return fmtAmount(native, decimals)
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

export function fmtDuration(secs: number) {
  if (secs <= 0) return 'expired'
  const d = Math.floor(secs / 86400)
  if (d >= 365) return `${(d / 365).toFixed(1)} years`
  if (d >= 1) return `${d} day${d === 1 ? '' : 's'}`
  const h = Math.floor(secs / 3600)
  return h >= 1 ? `${h} h` : `${Math.max(1, Math.floor(secs / 60))} min`
}

export type Severity = 'red' | 'yellow' | 'info' | 'none'

export const VERDICT_LABEL: Record<Severity, string> = {
  red: 'Danger',
  yellow: 'Review',
  info: 'Clear',
  none: 'Clear',
}
