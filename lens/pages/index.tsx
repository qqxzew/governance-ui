import Link from 'next/link'
import { useRouter } from 'next/router'
import { FormEvent, useState } from 'react'
import {
  Avatar,
  Footer,
  IBell,
  IFile,
  ILock,
  IShield,
  RealmSummary,
  RiskBadge,
  Skel,
  StatusPill,
  TopBar,
  useApi,
} from '../components/ui'
import { fmtDate, Severity } from '../lib/format'

interface Row {
  pk: string
  name: string
  state: number
  stateName: string
  draftAt: number
}
type Verdict = { maxSeverity: Severity; red: number; yellow: number; headline?: string }

export default function Home() {
  const router = useRouter()
  const [q, setQ] = useState('')
  const realm = useApi<{ realm: RealmSummary; proposals: Row[] }>('/api/realm?realm=MNDE')
  const latest = realm.data?.proposals.slice(0, 5) ?? []
  const verdicts = useApi<Record<string, Verdict>>(latest.length ? `/api/verdicts?pks=${latest.map((p) => p.pk).join(',')}` : null)
  const meta = useApi<{ bot: string | null }>('/api/meta')

  const open = (e: FormEvent) => {
    e.preventDefault()
    if (q.trim()) router.push(`/dao/${encodeURIComponent(q.trim())}`)
  }
  const r = realm.data?.realm
  const flagged = Object.values(verdicts.data ?? {}).filter((v) => v?.maxSeverity === 'red').length

  return (
    <>
      <TopBar active="home" />
      <main className="wrap">
        <section className="hero fade">
          <span className="pill">
            <IShield className="ico" /> Risk checks for every SPL Governance proposal
          </span>
          <h1>
            Know what you <span>vote for.</span>
          </h1>
          <p>
            Every instruction decoded into plain language. Red flags when a proposal moves the treasury,
            replaces the voting program, or does something its description doesn't mention.
          </p>
          <form onSubmit={open}>
            <input className="input" placeholder="Realm symbol or address, e.g. MNDE" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Realm" spellCheck={false} />
            <button className="btn" type="submit">
              Open realm
            </button>
          </form>
        </section>

        <section className="sec">
          <div className="sec-h">
            <h2 className="h2">Featured realm</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 360px) minmax(0, 1fr)', gap: 14 }} className="feat-grid">
            <Link href="/dao/MNDE">
              <a className="card dao-card">
                <div className="dao-banner" style={r?.banner ? { backgroundImage: `url(${r.banner})` } : undefined} />
                <div className="dao-body">
                  {r ? <Avatar src={r.logo} name={r.displayName ?? r.name} /> : <div className="avatar" />}
                  <div style={{ marginTop: 10, fontWeight: 600, fontSize: 16 }}>{r ? r.displayName ?? r.name : <Skel w={120} h={16} />}</div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 2, minHeight: 20 }}>
                    {r?.description}
                  </div>
                  <div className="stats" style={{ marginTop: 14 }}>
                    <div className="stat">
                      <div className="v">{realm.data ? realm.data.proposals.length : '—'}</div>
                      <div className="l">Proposals</div>
                    </div>
                    <div className="stat">
                      <div className="v" style={{ color: flagged ? 'var(--red)' : undefined }}>{verdicts.data ? flagged : '—'}</div>
                      <div className="l">High risk (latest 5)</div>
                    </div>
                    <div className="stat">
                      <div className="v">VSR</div>
                      <div className="l">Lockup voting</div>
                    </div>
                  </div>
                </div>
              </a>
            </Link>

            <div className="card plist">
              <div className="card-h">
                <h3>Latest proposals</h3>
                <Link href="/dao/MNDE">
                  <a className="dim" style={{ fontSize: 13 }}>
                    View all →
                  </a>
                </Link>
              </div>
              {!realm.data
                ? Array.from({ length: 5 }).map((_, i) => (
                    <div className="prow" key={i}>
                      <div className="grow" style={{ display: 'grid', gap: 8 }}>
                        <Skel w="60%" />
                        <Skel w="30%" h={10} />
                      </div>
                    </div>
                  ))
                : latest.map((p) => {
                    const v = verdicts.data?.[p.pk]
                    return (
                      <Link key={p.pk} href={`/dao/MNDE/proposal/${p.pk}`}>
                        <a className="prow">
                          <div className="grow">
                            <div className="t">{p.name}</div>
                            <div className="sub">
                              <StatusPill state={p.state} name={p.stateName} />
                              <span>{fmtDate(p.draftAt)}</span>
                              {v?.maxSeverity === 'red' && v.headline ? <span className="why">{v.headline}</span> : null}
                            </div>
                          </div>
                          {v?.maxSeverity ? <RiskBadge severity={v.maxSeverity} /> : <Skel w={84} h={24} r={99} />}
                        </a>
                      </Link>
                    )
                  })}
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="grid-3">
            <div className="card feature">
              <IFile />
              <h4>Plain-language instructions</h4>
              <p>Transfers, upgrades and config changes explained, with a before/after diff. Unknown programs are called out, never hidden.</p>
            </div>
            <div className="card feature">
              <ILock />
              <h4>Your real voting power</h4>
              <p>Locked vs. merely deposited tokens, lockup decay, and the exact number the on-chain VSR program will count.</p>
              <Link href="/dao/MNDE/power">
                <a className="dim" style={{ display: 'inline-block', marginTop: 10, fontSize: 13 }}>
                  Check a wallet →
                </a>
              </Link>
            </div>
            <div className="card feature">
              <IBell />
              <h4>Alerts for any realm</h4>
              <p>
                Telegram:{' '}
                {meta.data?.bot ? (
                  <a href={`https://t.me/${meta.data.bot}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                    @{meta.data.bot}
                  </a>
                ) : (
                  'the Open Realms bot'
                )}{' '}
                → <span className="mono">/watch MNDE</span>. New proposals and high-risk ones, as they appear.
              </p>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <style jsx>{`
        @media (max-width: 900px) {
          :global(.feat-grid) {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </>
  )
}
