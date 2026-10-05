/**
 * Snapshot ProposalSafetyInput fixtures for Marinade DAO (mainnet, read-only).
 *
 * PowerShell / bash:
 *   npx ts-node -T -O '{"module":"commonjs"}' scripts/snapshot/marinade.ts
 *   npx ts-node -T -O '{"module":"commonjs"}' scripts/snapshot/marinade.ts <proposalPk> [...]
 * Env: RPC (default https://api.mainnet-beta.solana.com; e.g. http://localhost:8898 for the proxy)
 *
 * Writes fixtures/marinade/realm.json and fixtures/marinade/<proposalPk>.json.
 */
import { Connection, PublicKey } from '@solana/web3.js'
import * as fs from 'fs'
import * as path from 'path'
import {
  loadProposalSafetyInput,
  loadRealmSafetyContext,
  RealmSafetyContext,
} from '../../tools/proposalSafety/load'
import { analyzeProposal } from '../../tools/proposalSafety/analyze'

const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com'
const PROGRAM = new PublicKey('GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs')
const REALM = new PublicKey('899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo')
const OUT = path.join(__dirname, '..', '..', 'fixtures', 'marinade')

export const MARINADE_FIXTURES: Record<string, string> = {
  '7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj': 'MIP-23 (attack: VSR program upgrade)',
  EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9: 'MIP-24 (attack: treasury drain)',
  CrbL16mpZRFJwKqkMsnVjHRP44n422opfQ1pGRL6zGoz: 'USDC Vault allocator update (benign)',
  Gd5CfxVQ1UYm4wToL5SVb9QhmCtcBTHo73QDnGMAmu6S: 'legit MIP-23 PSR (benign)',
  CzXJQfKmd7hSstgEEYmAguN16UunRZfPkmj6yBDy8EZ5: 'VSR config update (council fix)',
  // older Completed proposals paying addresses that earlier proposals had already paid
  GmfQWScCHqV8sEyAQFvzQf8caPwRqmSiX4hU366nEN5n: 'Operational expenses (2026-02, council)',
  E7HKLcSe86pFf4jC3nZVEwzLhKGYMLXwo8N5YTcVBk1B: 'Distribution to partners (2025-04, council)',
  J13YPM2NQkrqCCrkg6WgQ4978Ln7YYusALAYb3B4bmx9: 'MIP-12 Migrate Campaign 25M MNDE (2025-07, treasury)',
  Avfo4opueUWPxZUUVWuiuXaf8qL6vX6iP5Kqq2i1ThM2: 'Council Ops Treasury Transfer (2026-01, council)',
}

async function main() {
  const connection = new Connection(RPC, { commitment: 'confirmed', disableRetryOnRateLimit: true })
  fs.mkdirSync(OUT, { recursive: true })
  const args = process.argv.slice(2)
  const ids = args.length ? args : Object.keys(MARINADE_FIXTURES)

  const realmFile = path.join(OUT, 'realm.json')
  let ctx: RealmSafetyContext
  if (fs.existsSync(realmFile) && process.env.REUSE_REALM === '1') {
    ctx = JSON.parse(fs.readFileSync(realmFile, 'utf8'))
    console.log('reusing', realmFile)
  } else {
    console.log('loading realm context from', RPC)
    ctx = await loadRealmSafetyContext(connection, PROGRAM, REALM, { log: (m) => console.log(' ', m) })
    fs.writeFileSync(realmFile, JSON.stringify(ctx, null, 1) + '\n')
    console.log(`wrote realm.json: ${ctx.governances.length} governances, ${ctx.tokenAccounts.length} token accounts, ${ctx.knownPayees.length} payee records`)
  }

  for (const id of ids) {
    console.log('\n===', id, MARINADE_FIXTURES[id] ?? '')
    const input = await loadProposalSafetyInput(connection, new PublicKey(id), { realmContext: ctx })
    fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(input, null, 1) + '\n')
    const report = analyzeProposal(input)
    console.log(`${input.proposal.name} [${input.proposal.state}] -> ${report.maxSeverity}`)
    for (const a of report.actions) console.log(`  #${a.index + 1} ${a.summary}`)
    for (const f of report.findings) console.log(`  [${f.severity}] ${f.id}: ${f.title}\n      ${f.explanation}`)
  }
}

main().catch((e) => {
  console.error('ERR', e?.message ?? e)
  process.exit(1)
})
