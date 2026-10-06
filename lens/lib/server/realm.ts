import * as fs from 'fs'
import * as path from 'path'
import { PublicKey } from '@solana/web3.js'
import {
  GovernanceAccountParser,
  Realm,
  RealmConfigAccount,
  getRealmConfigAddress,
} from '@solana/spl-governance'
import { cached, REPO_ROOT } from './cache'
import { getConnection } from './rpc'
import {
  fetchGovernances,
  fetchProposalDetails,
  fetchProposalSlices,
} from '../../../bots/telegram/chain'
import {
  RealmRegistry,
  loadRegistry,
  resolveRealm,
} from '../../../bots/telegram/realms'
import { STATE_NAMES } from '../format'

const DEFAULT_SHARED_PROGRAM = 'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw'

let registry: RealmRegistry | undefined
let rawEntries: Map<string, any> | undefined
const REGISTRY_PATH = () => path.join(REPO_ROOT, 'public', 'realms', 'mainnet-beta.json')
function getRawEntry(realmPk: string) {
  if (!rawEntries) {
    rawEntries = new Map()
    try {
      for (const e of JSON.parse(fs.readFileSync(REGISTRY_PATH(), 'utf8'))) rawEntries.set(e.realmId, e)
    } catch {
      /* no registry */
    }
  }
  return rawEntries.get(realmPk)
}
const getRegistry = () =>
  (registry ??= loadRegistry(REGISTRY_PATH()))

function isDedicatedProgram(programId: string) {
  if (programId === DEFAULT_SHARED_PROGRAM) return false
  let n = 0
  for (const e of getRegistry().byRealmId.values()) if (e.programId === programId) n++
  return n <= 1
}

export interface RealmSummary {
  pk: string
  programId: string
  name: string
  symbol?: string
  communityMint: string
  councilMint: string | null
  communityVoterWeightAddin: string | null
  displayName?: string
  description?: string
  website?: string
  logo?: string
  banner?: string
}

export interface ProposalRow {
  pk: string
  name: string
  state: number
  stateName: string
  draftAt: number
  governance: string
}

/** Realm by symbol (registry) or pubkey; verified on chain. Cached 6 h. */
export async function getRealm(input: string): Promise<RealmSummary> {
  const norm = input.trim()
  return cached(`realm2|${norm.toUpperCase()}`, 6 * 3600_000, async () => {
    const conn = getConnection()
    const r = await resolveRealm(norm, getRegistry(), conn)
    const realmPk = new PublicKey(r.realmPk)
    const programId = new PublicKey(r.programId)
    const info = await conn.getAccountInfo(realmPk)
    const realm = GovernanceAccountParser(Realm)(realmPk, info!).account
    let addin: string | null = null
    try {
      const rcAddr = await getRealmConfigAddress(programId, realmPk)
      const rcInfo = await conn.getAccountInfo(rcAddr)
      if (rcInfo) {
        const rc = GovernanceAccountParser(RealmConfigAccount)(rcAddr, rcInfo).account
        addin = rc.communityTokenConfig.voterWeightAddin?.toBase58() ?? null
      }
    } catch {
      /* realms without a config account */
    }
    const entry = getRegistry().byRealmId.get(r.realmPk)
    const raw = getRawEntry(r.realmPk)
    const asset = (p?: string) =>
      !p ? undefined : p.startsWith('/') ? `/api/asset?path=${encodeURIComponent(p)}` : p.startsWith('https://') ? p : undefined
    return {
      pk: r.realmPk,
      programId: r.programId,
      name: realm.name || r.name || r.realmPk,
      symbol: entry?.symbol,
      communityMint: realm.communityMint.toBase58(),
      councilMint: realm.config.councilMint?.toBase58() ?? null,
      communityVoterWeightAddin: addin,
      displayName: raw?.displayName,
      description: raw?.shortDescription,
      website: raw?.website,
      logo: asset(raw?.ogImage),
      banner: asset(raw?.bannerImage),
    }
  })
}

/** All proposals of a realm, newest first. Cached 90 s (stale-while-revalidate). */
export async function listProposals(realm: RealmSummary): Promise<ProposalRow[]> {
  return cached(
    `proposals|${realm.pk}`,
    90_000,
    async () => {
      const conn = getConnection()
      const programId = new PublicKey(realm.programId)
      const govs = await fetchGovernances(conn, programId, new PublicKey(realm.pk))
      const slices = await fetchProposalSlices(conn, programId, govs, {
        programWide: isDedicatedProgram(realm.programId),
      })
      const details = await fetchProposalDetails(
        conn,
        slices.map((s) => s.pk),
        () => undefined,
      )
      const rows: ProposalRow[] = slices.map((s) => {
        const d = details.get(s.pk)
        return {
          pk: s.pk,
          name: d?.name ?? '(unreadable proposal)',
          state: s.state,
          stateName: STATE_NAMES[s.state] ?? `State ${s.state}`,
          draftAt: d?.draftAt ?? 0,
          governance: s.governance,
        }
      })
      return rows.sort((a, b) => b.draftAt - a.draftAt || (a.pk < b.pk ? -1 : 1))
    },
    { staleWhileRevalidate: true },
  )
}
