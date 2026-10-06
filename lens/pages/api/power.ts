import { BadRequest, isPubkey, isRealmInput, route } from '../../lib/server/api'
import { getRealm } from '../../lib/server/realm'
import { getVotingPower } from '../../lib/server/power'

export default route(async (req) => {
  const { realm: r, wallet } = req.query
  if (!isRealmInput(r)) throw new BadRequest('realm must be a realm address or a known symbol')
  if (!isPubkey(wallet)) throw new BadRequest('wallet must be a Solana address')
  const realm = await getRealm(r)
  return { realm, power: await getVotingPower(realm, wallet) }
}, 20)
