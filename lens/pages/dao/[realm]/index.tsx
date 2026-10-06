import Head from 'next/head'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  Footer,
  ISearch,
  RealmHeader,
  RealmSummary,
  RiskBadge,
  Skel,
  StatusPill,
  TopBar,
  useApi,
  useQueryParam,
} from '../../../components/ui'
import { fmtDate, Severity } from '../../../lib/format'

interface Row {
  pk: string
  name: string
  state: number
  stateName: string
  draftAt: number
}
type Verdict = { maxSeverity: Severity; red: number; yellow: number; headline?: string } | { error: string }

const PAGE = 20
const BATCH = 12
const ACTIVE = new Set([0, 1, 2, 4])

export default function RealmPage() {
  const realmParam = useQueryParam('realm')
  const { data, error } = useApi<{ realm: RealmSummary; proposals: Row[] }>(
    realmParam ? `/api/realm?realm=${encodeURIComponent(realmParam)}` : null,
  )
  const [shown, setShown] = useState(PAGE)
  const [q, setQ] = useState('')
  const [view, setView] = useState<'all' | 'active' | 'risk'>('all')
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({})

  const rows = useMemo(() => {
    const f = q.trim().toLowerCase()
    return (data?.proposals ?? []).filter((r) => {
      if (f && !r.name.toLowerCase().includes(f) && !r.pk.startsWith(q.trim())) return false
      if (view === 'active') return ACTIVE.has(r.state)
      if (view === 'risk') {
        const v = verdicts[r.pk]
        return !!v && 'maxSeverity' in v && v.maxSeverity === 'red'
      }
      return true
    })
  }, [data, q, view, verdicts])
  const visible = rows.slice(0, shown)
  const key = visible.map((r) => r.pk).join(',')

  useEffect(() => {
    const missing = visible.map((r) => r.pk).filter((pk) => !(pk in verdicts)).slice(0, BATCH)
    if (!missing.length) return
    let alive = true
    fetch(`/api/verdicts?pks=${missing.join(',')}`)
      .then((r) => r.json())
      .catch(() => ({}))
      .then((j) => {
        if (!alive) return
        const next: Record<string, Verdict> = {}
        for (const pk of missing) next[pk] = j?.[pk] ?? { error: 'unavailable' }
        setVerdicts((v) => ({ ...v, ...next }))
      })
    return () => {
      alive = false
    }
  }, [key, Object.keys(verdicts).length])

  const realm = data?.realm
  const slug = realm?.symbol ?? realm?.pk ?? realmParam ?? ''
  const nRisk = Object.values(verdicts).filter((v) => 'maxSeverity' in v && v.maxSeverity === 'red').length

  return (
    <>
      <Head>
        <title>{realm ? `${realm.displayName ?? realm.name} · Open Realms` : 'Open Realms'}</title>
      </Head>
      <TopBar active={realm?.symbol === 'MNDE' ? 'mnde' : undefined} />
      <main className="wrap">
        {error ? (
          <div className="alert red" style={{ marginTop: 24 }}>
            <div>
              <b>Could not open this realm.</b>
              <p>{error}</p>
            </div>
          </div>
        ) : (
          <>
            <RealmHeader realm={realm} tab="proposals" count={data?.proposals.length} />

            <div className="toolbar">
              <div className="seg" role="tablist">
                {(
                  [
                    ['all', 'All'],
                    ['active', 'Active'],
                    ['risk', `High risk${nRisk ? ` · ${nRisk}` : ''}`],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} className={view === k ? 'on' : ''} onClick={() => (setView(k), setShown(PAGE))}>
                    {l}
                  </button>
                ))}
              </div>
              <label className="search" style={{ width: 280 }}>
                <ISearch />
                <input placeholder="Filter proposals" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter proposals" />
              </label>
            </div>

            <div className="card plist">
              {!data
                ? Array.from({ length: 8 }).map((_, i) => (
                    <div className="prow" key={i}>
                      <div className="grow" style={{ display: 'grid', gap: 8 }}>
                        <Skel w={`${70 - i * 4}%`} />
                        <Skel w="28%" h={10} />
                      </div>
                      <Skel w={84} h={24} r={99} />
                    </div>
                  ))
                : visible.map((p) => {
                    const v = verdicts[p.pk]
                    const sev = v && 'maxSeverity' in v ? v.maxSeverity : undefined
                    return (
                      <Link key={p.pk} href={`/dao/${encodeURIComponent(slug)}/proposal/${p.pk}`}>
                        <a className="prow">
                          <div className="grow">
                            <div className="t">{p.name}</div>
                            <div className="sub">
                              <StatusPill state={p.state} name={p.stateName} />
                              <span>{fmtDate(p.draftAt)}</span>
                              {sev && sev !== 'none' && 'headline' in v! && v.headline ? (
                                <span className={`why ${sev === 'yellow' ? 'y' : ''}`}>{v.headline}</span>
                              ) : null}
                            </div>
                          </div>
                          {sev ? <RiskBadge severity={sev} /> : v ? <span className="dim" style={{ fontSize: 12 }}>—</span> : <Skel w={84} h={24} r={99} />}
                        </a>
                      </Link>
                    )
                  })}
              {data && !rows.length ? (
                <div className="prow dim" style={{ justifyContent: 'center' }}>
                  {view === 'risk' ? 'No high-risk proposals among the ones checked so far.' : 'No proposals match.'}
                </div>
              ) : null}
              {rows.length > shown ? (
                <div className="more">
                  <button className="btn secondary sm" onClick={() => setShown((s) => s + PAGE)}>
                    Show more ({rows.length - shown})
                  </button>
                </div>
              ) : null}
            </div>
          </>
        )}
      </main>
      <Footer />
    </>
  )
}
