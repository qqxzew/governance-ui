import { PublicKey } from '@solana/web3.js'

export const ZERO = BigInt(0)
const TEN = BigInt(10)

export function b64ToBytes(b64: string): Buffer {
  return Buffer.from(b64, 'base64')
}

export function readU64(buf: Buffer, offset: number): bigint {
  if (buf.length < offset + 8) throw new Error('u64 out of range')
  // two u32 reads: the browser Buffer polyfill (buffer@5) has no readBigUInt64LE
  const lo = BigInt(buf.readUInt32LE(offset))
  const hi = BigInt(buf.readUInt32LE(offset + 4))
  return (hi << BigInt(32)) + lo
}

export function readPubkey(buf: Buffer, offset: number): string {
  if (buf.length < offset + 32) throw new Error('pubkey out of range')
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58()
}

export function pow10(decimals: number): bigint {
  let r = BigInt(1)
  for (let i = 0; i < decimals; i++) r *= TEN
  return r
}

function groupThousands(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Full-precision decimal string with thousands separators, trailing zeros trimmed. */
export function formatUnitsFull(raw: bigint, decimals: number): string {
  const neg = raw < ZERO
  const abs = neg ? -raw : raw
  const base = pow10(decimals)
  const int = abs / base
  let frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0') : ''
  frac = frac.replace(/0+$/, '')
  return (neg ? '-' : '') + groupThousands(int.toString()) + (frac ? '.' + frac : '')
}

/** Human amount: 2 decimals when >= 1, otherwise up to 6 significant decimals. */
export function formatUnits(raw: bigint, decimals: number): string {
  const base = pow10(decimals)
  const abs = raw < ZERO ? -raw : raw
  if (abs >= base || decimals === 0) {
    const scaled = (abs * BigInt(100) + base / BigInt(2)) / base // rounded to 2 dp
    const int = scaled / BigInt(100)
    const frac = (scaled % BigInt(100)).toString().padStart(2, '0').replace(/0+$/, '')
    return (raw < ZERO ? '-' : '') + groupThousands(int.toString()) + (frac ? '.' + frac : '')
  }
  const full = formatUnitsFull(raw, decimals)
  const m = full.match(/^(-?0\.0*)(\d{0,6})/)
  return m ? m[1] + m[2] : full
}

/** 153600023536334850 (9 dp) -> "153.6M" */
export function formatCompact(raw: bigint, decimals: number): string {
  const v = Number(raw) / Math.pow(10, decimals)
  const abs = Math.abs(v)
  if (abs >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  if (abs >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (abs >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return formatUnits(raw, decimals)
}

/** percentage (0..100+, 3 decimals) of part/whole; null if whole is 0 */
export function percent(part: bigint, whole: bigint): number | null {
  if (whole <= ZERO) return null
  return Number((part * BigInt(100000)) / whole) / 1000
}

export function fmtPct(p: number | null): string {
  if (p === null) return 'an unknown share'
  if (p >= 99.95 && p < 100.05) return '100%'
  if (p > 0 && p < 0.1) return '<0.1%'
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`
}

export function short(addr: string | null | undefined): string {
  if (!addr) return '(none)'
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

export function fmtDuration(secs: number): string {
  if (!secs) return '0 (executes immediately)'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (!parts.length) parts.push(`${secs}s`)
  return parts.join(' ')
}

/** Truncate untrusted text for quoting; strips control chars and collapses whitespace. */
export function quoteText(s: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}
