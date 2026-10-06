import Link from 'next/link'
import { useRouter } from 'next/router'
import { FormEvent, ReactNode, useEffect, useState } from 'react'
import { Severity, short } from '../lib/format'

// ── data ────────────────────────────────────────────────────────────────
export function useApi<T>(url: string | null) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: !!url })
  useEffect(() => {
    if (!url) return
    let alive = true
    setState((s) => ({ loading: true, data: s.data }))
    fetch(url)
      .then(async (r) => {
        const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
        if (!alive) return
        if (!r.ok || j.error) setState({ loading: false, error: j.error || `HTTP ${r.status}` })
        else setState({ loading: false, data: j })
      })
      .catch((e) => alive && setState({ loading: false, error: String(e?.message ?? e) }))
    return () => {
      alive = false
    }
  }, [url])
  return state
}

export function useQueryParam(name: string): string | undefined {
  const { query, isReady } = useRouter()
  if (!isReady) return undefined
  const v = query[name]
  return Array.isArray(v) ? v[0] : v
}

// ── icons (lucide-style strokes) ────────────────────────────────────────
const P = (d: ReactNode) =>
  function Icon({ className = 'ico' }: { className?: string }) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {d}
      </svg>
    )
  }
export const IShield = P(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>)
export const IAlert = P(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>)
export const IOctagon = P(<><path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z" /><path d="M12 8v4" /><path d="M12 16h.01" /></>)
export const ICheck = P(<><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>)
export const IInfo = P(<><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>)
export const ISearch = P(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>)
export const IChevron = P(<path d="m9 18 6-6-6-6" />)
export const IBack = P(<><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>)
export const IExt = P(<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>)
export const IBell = P(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>)
export const IFile = P(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /></>)
export const ILock = P(<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>)

// ── layout ──────────────────────────────────────────────────────────────
export function TopBar({ active }: { active?: 'home' | 'mnde' | 'power' }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const go = (e: FormEvent) => {
    e.preventDefault()
    if (q.trim()) router.push(`/dao/${encodeURIComponent(q.trim())}`)
  }
  return (
    <header className="topbar">
      <div className="wrap topbar-in">
        <Link href="/">
          <a className="logo">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="rgba(45,212,167,.14)" stroke="#2dd4a7" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="m8.8 12.2 2.2 2.2 4.3-4.6" stroke="#2dd4a7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Open Realms
          </a>
        </Link>
        <form className="search" onSubmit={go} role="search">
          <ISearch />
          <input placeholder="Search a realm (symbol or address)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search a realm" />
        </form>
        <nav className="navlinks">
          <Link href="/dao/MNDE">
            <a className={active === 'mnde' ? 'on' : ''}>Marinade</a>
          </Link>
          <Link href="/dao/MNDE/power">
            <a className={active === 'power' ? 'on' : ''}>Voting power</a>
          </Link>
        </nav>
        <span className="pill" title="This site never asks you to sign anything">
          <span className="dot" style={{ color: 'var(--accent)' }} />
          Read-only
        </span>
      </div>
    </header>
  )
}

export function Footer() {
  return (
    <footer className="wrap">
      <div className="foot">
        <span>Open Realms · community fork of Mythic-Project/governance-ui (Apache-2.0) · unaudited</span>
        <span className="row" style={{ gap: 18 }}>
          <a href={process.env.NEXT_PUBLIC_SOURCE_URL} target="_blank" rel="noreferrer">
            Source
          </a>
          {process.env.NEXT_PUBLIC_FULL_UI_URL ? (
            <a href={process.env.NEXT_PUBLIC_FULL_UI_URL} target="_blank" rel="noreferrer">
              Full app
            </a>
          ) : null}
        </span>
      </div>
    </footer>
  )
}

// ── bits ────────────────────────────────────────────────────────────────
export const RISK_TEXT: Record<Severity, string> = {
  red: 'High risk',
  yellow: 'Review',
  info: 'No issues',
  none: 'No issues',
}

export function RiskBadge({ severity, count }: { severity: Severity; count?: number }) {
  const Icon = severity === 'red' ? IOctagon : severity === 'yellow' ? IAlert : ICheck
  return (
    <span className={`risk ${severity}`}>
      <Icon />
      {RISK_TEXT[severity]}
      {count ? <span style={{ opacity: 0.8, fontWeight: 500 }}>· {count}</span> : null}
    </span>
  )
}

export function StatusPill({ state, name }: { state: number; name: string }) {
  const cls = state === 2 ? 'live' : state === 3 || state === 5 ? 'ok' : state === 9 || state === 7 || state === 8 ? 'bad' : ''
  return (
    <span className={`pill ${cls}`}>
      {state === 2 ? <span className="dot" /> : null}
      {name}
    </span>
  )
}

export function Skel({ w = '100%', h = 14, r }: { w?: string | number; h?: number; r?: number }) {
  return <div className="skel" style={{ width: w, height: h, borderRadius: r }} />
}

export function Avatar({ src, name, size }: { src?: string; name: string; size?: 'lg' }) {
  const [broken, setBroken] = useState(false)
  return (
    <div className={`avatar ${size ?? ''}`}>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : name.slice(0, 1).toUpperCase()}
    </div>
  )
}

export interface RealmSummary {
  pk: string
  programId: string
  name: string
  symbol?: string
  communityMint: string
  communityVoterWeightAddin: string | null
  displayName?: string
  description?: string
  website?: string
  logo?: string
  banner?: string
}

export function RealmHeader({
  realm,
  tab,
  count,
}: {
  realm?: RealmSummary
  tab: 'proposals' | 'power'
  count?: number
}) {
  const slug = realm ? realm.symbol ?? realm.pk : ''
  return (
    <section className="realm-hero">
      <div className="realm-banner" style={realm?.banner ? { backgroundImage: `url(${realm.banner})` } : undefined} />
      <div className="realm-info">
        {realm ? <Avatar src={realm.logo} name={realm.displayName ?? realm.name} size="lg" /> : <div className="avatar lg" />}
        <div className="grow">
          {realm ? (
            <>
              <h1 className="h1">{realm.displayName ?? realm.name}</h1>
              <div className="row dim" style={{ marginTop: 6, fontSize: 13, flexWrap: 'wrap', gap: '4px 14px' }}>
                {realm.description ? <span className="muted">{realm.description}</span> : null}
                <span className="mono">{short(realm.pk, 4)}</span>
                {realm.website ? (
                  <a href={realm.website} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>
                    {realm.website.replace(/^https?:\/\//, '').replace(/\/$/, '')} <IExt className="ico" />
                  </a>
                ) : null}
              </div>
            </>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              <Skel w={220} h={28} />
              <Skel w={340} h={12} />
            </div>
          )}
        </div>
      </div>
      <nav className="tabs">
        <Link href={`/dao/${encodeURIComponent(slug)}`}>
          <a className={tab === 'proposals' ? 'on' : ''}>Proposals{count !== undefined ? ` ${count}` : ''}</a>
        </Link>
        <Link href={`/dao/${encodeURIComponent(slug)}/power`}>
          <a className={tab === 'power' ? 'on' : ''}>Voting power</a>
        </Link>
      </nav>
    </section>
  )
}
