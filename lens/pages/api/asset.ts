// Serves realm logos/banners from the repo's public/realms folder (66 MB, not copied into lens).
import type { NextApiRequest, NextApiResponse } from 'next'
import * as fs from 'fs'
import * as path from 'path'
import { REPO_ROOT } from '../../lib/server/cache'

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const p = String(req.query.path ?? '')
  const base = path.join(REPO_ROOT, 'public', 'realms')
  const file = path.normalize(path.join(REPO_ROOT, 'public', p))
  const type = TYPES[path.extname(file).toLowerCase()]
  if (!p.startsWith('/realms/') || !file.startsWith(base + path.sep) || !type || !fs.existsSync(file)) {
    return res.status(404).end()
  }
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
  if (type === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  fs.createReadStream(file).pipe(res)
}
