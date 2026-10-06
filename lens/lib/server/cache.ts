// Two-level cache (memory + JSON files) so the browser never waits on cold RPC twice.
// LENS_OFFLINE=1 serves only from lens/demo-data (a committed copy of .cache) and never calls RPC.
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

const LENS_DIR = fs.existsSync(path.join(process.cwd(), 'lens', 'next.config.js'))
  ? path.join(process.cwd(), 'lens')
  : process.cwd()
export const REPO_ROOT = path.join(LENS_DIR, '..')
const CACHE_DIR = path.join(LENS_DIR, '.cache')
const DEMO_DIR = path.join(LENS_DIR, 'demo-data')
export const OFFLINE = process.env.LENS_OFFLINE === '1'

const mem = new Map<string, { at: number; value: unknown }>()
const inflight = new Map<string, Promise<unknown>>()

const fileFor = (dir: string, key: string) =>
  path.join(dir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '.json')

function readDisk(key: string): { at: number; value: unknown } | undefined {
  for (const dir of OFFLINE ? [DEMO_DIR] : [CACHE_DIR, DEMO_DIR]) {
    try {
      const raw = JSON.parse(fs.readFileSync(fileFor(dir, key), 'utf8'))
      if (raw && raw.key === key) return { at: raw.at, value: raw.value }
    } catch {
      /* miss */
    }
  }
  return undefined
}

function writeDisk(key: string, at: number, value: unknown) {
  if (OFFLINE) return
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const f = fileFor(CACHE_DIR, key)
    fs.writeFileSync(f + '.tmp', JSON.stringify({ key, at, value }))
    fs.renameSync(f + '.tmp', f)
  } catch {
    /* read-only FS: memory cache still works */
  }
}

export class OfflineMissError extends Error {
  constructor(key: string) {
    super(`not in the offline snapshot (${key.split('|')[0]})`)
  }
}

/**
 * Get `key` if younger than `ttlMs` (Infinity = forever; may depend on the cached value), else compute it.
 * A stale value is returned immediately while a refresh runs in the background
 * when `staleWhileRevalidate` is set.
 */
export async function cached<T>(
  key: string,
  ttlMs: number | ((value: T) => number),
  compute: () => Promise<T>,
  opts: { staleWhileRevalidate?: boolean } = {},
): Promise<T> {
  const now = Date.now()
  let hit = mem.get(key)
  if (!hit) {
    hit = readDisk(key)
    if (hit) mem.set(key, hit)
  }
  if (OFFLINE) {
    if (hit) return hit.value as T
    throw new OfflineMissError(key)
  }
  const ttl = hit ? (typeof ttlMs === 'function' ? ttlMs(hit.value as T) : ttlMs) : 0
  const fresh = hit && now - hit.at < ttl
  if (fresh) return hit!.value as T

  const run = () => {
    let p = inflight.get(key) as Promise<T> | undefined
    if (!p) {
      p = compute()
        .then((value) => {
          const at = Date.now()
          mem.set(key, { at, value })
          writeDisk(key, at, value)
          return value
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    return p
  }
  if (hit && opts.staleWhileRevalidate) {
    run().catch(() => undefined)
    return hit.value as T
  }
  return run()
}

/** Copy the live cache into demo-data/ (committed) for the offline demo. */
export function snapshotCacheToDemo(): number {
  fs.mkdirSync(DEMO_DIR, { recursive: true })
  let n = 0
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.endsWith('.json')) continue
    fs.copyFileSync(path.join(CACHE_DIR, f), path.join(DEMO_DIR, f))
    n++
  }
  return n
}
