import * as fs from 'fs'
import * as path from 'path'

/** Per-proposal memory (kept small: state.json holds every proposal of every watched realm). */
export interface SeenProposal {
  /** ProposalState number */
  s: number
  /** Proposal name (truncated) for later alerts */
  n?: string
  /** Signature of the proposal's transactions (counts + content hash) last observed */
  tx?: string
  /** State in which `tx` was computed (tx content can only change in Draft) */
  txAt?: number
  /** `tx` signature for which the safety check completed */
  chk?: string
  /** Key of the last danger alert sent (tx signature + red finding ids) */
  red?: string
}

export interface WatchedRealm {
  realmPk: string
  programId: string
  symbol?: string
  name?: string
  subscribers: number[]
  /** false until the first (baseline) poll completed */
  baselineDone: boolean
  proposals: Record<string, SeenProposal>
  governances?: { pk: string; t: number }[]
  governancesFetchedAt?: number
  lastPollAt?: number
  lastError?: string
}

export interface BotState {
  version: 1
  telegramOffset: number
  realms: Record<string, WatchedRealm>
}

export function emptyState(): BotState {
  return { version: 1, telegramOffset: 0, realms: {} }
}

export function loadState(file: string): BotState {
  if (!fs.existsSync(file)) return emptyState()
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || parsed.version !== 1 || typeof parsed.realms !== 'object') {
    throw new Error(`Unrecognised state file format: ${file}`)
  }
  return parsed as BotState
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Atomic write: write a temp file in the same directory, fsync, then rename over. */
export function saveState(file: string, state: BotState) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 1))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // On Windows rename can transiently fail with EPERM/EBUSY (AV scanners, open handles).
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (e: any) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
        throw e
      }
      sleepSync(50 * (attempt + 1))
    }
  }
}
