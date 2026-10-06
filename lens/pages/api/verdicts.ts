import { BadRequest, isPubkey, route } from '../../lib/server/api'
import { getVerdict, Verdict } from '../../lib/server/safety'

const MAX = 12

// Verdict stamps for a page of the proposal ledger. Errors per proposal are reported, not thrown.
export default route(async (req) => {
  const raw = String(req.query.pks ?? '')
  const pks = raw.split(',').filter(Boolean)
  if (!pks.length || pks.length > MAX || !pks.every(isPubkey)) {
    throw new BadRequest(`pks must be 1..${MAX} comma-separated proposal addresses`)
  }
  const out: Record<string, Verdict | { error: string }> = {}
  // small concurrency: the realm context is shared and cached after the first one
  let i = 0
  const worker = async () => {
    while (i < pks.length) {
      const pk = pks[i++]
      try {
        out[pk] = await getVerdict(pk)
      } catch (e) {
        out[pk] = { error: 'unavailable' }
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return out
}, 60)
