import { BadRequest, isRealmInput, route } from '../../lib/server/api'
import { getRealm, listProposals } from '../../lib/server/realm'

export default route(async (req) => {
  const q = req.query.realm
  if (!isRealmInput(q)) throw new BadRequest('realm must be a realm address or a known symbol')
  const realm = await getRealm(q)
  const proposals = await listProposals(realm)
  return { realm, proposals }
}, 60)
