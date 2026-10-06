import { BadRequest, isPubkey, route } from '../../lib/server/api'
import { getProposalAnalysis } from '../../lib/server/safety'

export default route(async (req) => {
  const pk = req.query.pk
  if (!isPubkey(pk)) throw new BadRequest('pk must be a proposal address')
  return getProposalAnalysis(pk)
}, 60)
