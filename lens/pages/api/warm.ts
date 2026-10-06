import { route } from '../../lib/server/api'
import { getRealm, listProposals } from '../../lib/server/realm'
import { getRealmContext, getVerdict } from '../../lib/server/safety'

// Pre-loads the featured realm so the first visitor does not wait on cold RPC.
export default route(async (req) => {
  const symbol = String(req.query.realm || process.env.LENS_FEATURED_REALM || 'MNDE')
  const t0 = Date.now()
  const realm = await getRealm(symbol)
  const proposals = await listProposals(realm)
  await getRealmContext(realm.pk, realm.programId)
  const extra = String(req.query.pks || '').split(',').filter(Boolean)
  const pks = Array.from(new Set([...extra, ...proposals.slice(0, 12).map((p) => p.pk)]))
  for (const pk of pks) await getVerdict(pk).catch(() => undefined)
  return { realm: realm.pk, proposals: proposals.length, warmed: pks.length, ms: Date.now() - t0 }
}, 0)
