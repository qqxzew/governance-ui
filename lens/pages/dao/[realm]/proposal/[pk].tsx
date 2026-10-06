import Head from 'next/head'
import Link from 'next/link'
import { useState } from 'react'
import {
  Footer,
  IAlert,
  IBack,
  IChevron,
  IInfo,
  IOctagon,
  RealmSummary,
  RISK_TEXT,
  RiskBadge,
  Skel,
  StatusPill,
  TopBar,
  useApi,
  useQueryParam,
} from '../../../../components/ui'
import { fmtAmount, fmtDate, Severity, short } from '../../../../lib/format'

interface Finding {
  id: string
  severity: 'red' | 'yellow' | 'info'
  title: string
  explanation: string
  instructionIndex?: number
}
interface Action {
  index: number
  programId: string
  programName: string
  known: boolean
  summary: string
  holdUpTime: number
  details: { label: string; value: string }[]
  severity: Severity
}
interface Change {
  label: string
  old: string
  new: string
  changed: boolean
}
interface Analysis {
  meta: {
    pk: string
    name: string
    state: number
    stateName: string
    description: string
    descriptionUnresolved: boolean
    governance: string
    proposer?: string
    draftAt: number | null
    votingAt: number | null
    votes: { yes: string; no: string; veto: string; decimals: number; council: boolean }
  }
  report: {
    actions: Action[]
    findings: Finding[]
    maxSeverity: Severity
    changes: Change[]
    description: { actually: string[]; mismatch: boolean }
    notes: string[]
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const holdUp = (secs: number) =>
  !secs ? 'None — executes immediately' : secs >= 86400 ? `${+(secs / 86400).toFixed(2)} days` : `${Math.round(secs / 3600)} h`

function group(findings: Finding[], sev: Finding['severity']) {
  const out: (Finding & { more: string[] })[] = []
  for (const f of findings) {
    if (f.severity !== sev) continue
    const same = out.find((o) => o.title === f.title)
    if (same) same.more.push(f.explanation)
    else out.push({ ...f, more: [] })
  }
  return out
}

function Results({ v }: { v: Analysis['meta']['votes'] }) {
  const yes = BigInt(v.yes || '0')
  const no = BigInt(v.no || '0')
  const total = yes + no
  const pct = (x: bigint) => (total === BigInt(0) ? 0 : Number((x * BigInt(10000)) / total) / 100)
  const line = (label: string, amount: string, p: number, color: string) => (
    <div className="vote-line">
      <div className="top">
        <span>{label}</span>
        <span>
          <b>{fmtAmount(amount, v.decimals, 0)}</b> <span className="dim">{p}%</span>
        </span>
      </div>
      <div className="bar">
        <i style={{ width: `${p}%`, background: color }} />
      </div>
    </div>
  )
  return (
    <div className="card">
      <div className="card-h">
        <h3>Results</h3>
        <span className="dim" style={{ fontSize: 12 }}>
          {v.council ? 'Council vote' : 'Community vote'}
        </span>
      </div>
      <div className="card-pad">
        {line('Yes', v.yes, pct(yes), 'var(--green)')}
        {line('No', v.no, pct(no), 'var(--red)')}
        {v.veto !== '0' ? (
          <div className="row" style={{ marginTop: 14, fontSize: 13, color: 'var(--red)' }}>
            <IOctagon /> Vetoed by the council
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default function ProposalPage() {
  const realmParam = useQueryParam('realm')
  const pk = useQueryParam('pk')
  const { data, error } = useApi<Analysis>(pk ? `/api/proposal?pk=${pk}` : null)
  const realmRes = useApi<{ realm: RealmSummary }>(realmParam ? `/api/realm?realm=${encodeURIComponent(realmParam)}` : null)
  const [showInfo, setShowInfo] = useState(false)
  const realm = realmRes.data?.realm
  const r = data?.report
  const m = data?.meta
  const red = r ? group(r.findings, 'red') : []
  const yellow = r ? group(r.findings, 'yellow') : []
  const info = r ? r.findings.filter((f) => f.severity === 'info') : []
  const actually = r ? (r.description.actually.length ? r.description.actually : r.actions.map((a) => a.summary)) : []
  const sev = r?.maxSeverity ?? 'none'
  const SevIcon = sev === 'red' ? IOctagon : sev === 'yellow' ? IAlert : IInfo

  return (
    <>
      <Head>
        <title>{m ? `${m.name} · Open Realms` : 'Proposal · Open Realms'}</title>
      </Head>
      <TopBar active={realm?.symbol === 'MNDE' ? 'mnde' : undefined} />
      <main className="wrap">
        <Link href={`/dao/${encodeURIComponent(realmParam ?? '')}`}>
          <a className="back">
            <IBack />
            {realm?.displayName ?? realm?.name ?? 'Back'}
          </a>
        </Link>

        {error ? (
          <div className="alert red">
            <IAlert />
            <div>
              <b>Could not analyze this proposal.</b>
              <p>{error}</p>
            </div>
          </div>
        ) : !data ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <Skel w={160} h={22} r={99} />
            <Skel w="70%" h={30} />
            <div className="p-grid">
              <div className="stack">
                <div className="card card-pad" style={{ display: 'grid', gap: 10 }}>
                  <Skel w="40%" h={18} />
                  <Skel />
                  <Skel w="80%" />
                </div>
                <div className="card card-pad" style={{ display: 'grid', gap: 10 }}>
                  <Skel w="30%" />
                  <Skel w="90%" />
                  <Skel w="70%" />
                </div>
              </div>
              <div className="card card-pad" style={{ display: 'grid', gap: 10 }}>
                <Skel w="40%" />
                <Skel h={6} />
                <Skel h={6} />
              </div>
            </div>
          </div>
        ) : (
          <div className="fade">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <StatusPill state={m!.state} name={m!.stateName} />
              <RiskBadge severity={sev} />
              <span className="dim" style={{ fontSize: 13 }}>
                {fmtDate(m!.draftAt)} · {r!.actions.length} instruction{r!.actions.length === 1 ? '' : 's'}
              </span>
            </div>
            <h1 className="h1" style={{ marginTop: 14 }}>
              {m!.name}
            </h1>

            <div className="p-grid">
              <div className="stack">
                <div className={`summary ${sev}`}>
                  <div className="head">
                    <SevIcon />
                    {sev === 'red'
                      ? `${RISK_TEXT.red} — ${red.length} issue${red.length === 1 ? '' : 's'} found`
                      : sev === 'yellow'
                      ? `Review before voting — ${yellow.length} item${yellow.length === 1 ? '' : 's'}`
                      : 'No risk rules triggered'}
                  </div>
                  {sev === 'red' || sev === 'yellow' ? (
                    <ul>
                      {(sev === 'red' ? red : yellow).slice(0, 4).map((f, i) => (
                        <li key={i}>{f.title}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="card">
                  <div className="card-h">
                    <h3>Description vs. what it does</h3>
                    {r!.description.mismatch ? <span className="pill bad">Doesn't match</span> : <span className="pill ok">Consistent</span>}
                  </div>
                  <div className="vs">
                    <div>
                      <div className="label">The description says</div>
                      <blockquote>{(m!.description || 'No description.').slice(0, 700)}</blockquote>
                      {m!.descriptionUnresolved ? (
                        <p className="dim" style={{ fontSize: 12.5 }}>
                          The description is an external link we could not load.
                        </p>
                      ) : null}
                    </div>
                    <div className={`sep ${r!.description.mismatch ? 'neq' : ''}`}>
                      <span>{r!.description.mismatch ? '≠' : '='}</span>
                    </div>
                    <div>
                      <div className="label">The instructions actually</div>
                      {actually.length ? (
                        <ul>
                          {actually.slice(0, 6).map((a, i) => (
                            <li key={i}>{cap(a)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted" style={{ marginTop: 8 }}>
                          Do nothing on-chain (signaling vote).
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {red.length || yellow.length ? (
                  <div className="card">
                    <div className="card-h">
                      <h3>Findings</h3>
                      <span className="dim" style={{ fontSize: 12 }}>
                        Rule-based · the description never decides a flag
                      </span>
                    </div>
                    {[...red, ...yellow].map((f, i) => {
                      const Icon = f.severity === 'red' ? IOctagon : IAlert
                      return (
                        <div key={i} className={`finding ${f.severity}`}>
                          <Icon />
                          <div className="grow">
                            <h4>
                              {f.title}
                              {f.instructionIndex !== undefined ? <span className="tag">#{f.instructionIndex + 1}</span> : null}
                            </h4>
                            <p>{f.explanation}</p>
                            {f.more.map((x, j) => (
                              <p key={j}>{x}</p>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                    {info.length ? (
                      <>
                        {showInfo
                          ? info.map((f, i) => (
                              <div key={i} className="finding info">
                                <IInfo />
                                <div className="grow">
                                  <h4>{f.title}</h4>
                                  <p>{f.explanation}</p>
                                </div>
                              </div>
                            ))
                          : null}
                        <div className="more">
                          <button className="btn secondary sm" onClick={() => setShowInfo(!showInfo)}>
                            {showInfo ? 'Hide' : 'Show'} {info.length} note{info.length === 1 ? '' : 's'}
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}

                <div className="card">
                  <div className="card-h">
                    <h3>Instructions</h3>
                    <span className="dim" style={{ fontSize: 12 }}>
                      {r!.actions.length} total
                    </span>
                  </div>
                  {r!.actions.length ? (
                    r!.actions.map((a) => (
                      <details key={a.index} className={`ix sev-${a.severity}`}>
                        <summary>
                          <span className="n">{a.index + 1}</span>
                          <span className="s">
                            {a.summary}
                            <span className="tag">{a.programName || short(a.programId)}</span>
                          </span>
                          <IChevron className="chev" />
                        </summary>
                        <dl className="kv">
                          <dt>Program</dt>
                          <dd>{a.programId}</dd>
                          <dt>Hold-up time</dt>
                          <dd>{holdUp(a.holdUpTime)}</dd>
                          {a.details.map((d, i) => (
                            <KV key={i} k={d.label} v={d.value} />
                          ))}
                        </dl>
                      </details>
                    ))
                  ) : (
                    <div className="card-pad muted">No instructions — signaling vote.</div>
                  )}
                </div>

                {r!.changes.length ? (
                  <div className="card">
                    <div className="card-h">
                      <h3>What changes</h3>
                    </div>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Setting</th>
                          <th>Current</th>
                          <th>After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r!.changes.map((c, i) => (
                          <tr key={i} className={c.changed ? 'changed' : ''}>
                            <td>{c.label}</td>
                            <td className="m old">{c.old}</td>
                            <td className="m new">{c.new}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>

              <aside className="p-side">
                <Results v={m!.votes} />
                <div className="card">
                  <div className="card-h">
                    <h3>Details</h3>
                  </div>
                  <dl className="dl card-pad">
                    <div>
                      <dt>Status</dt>
                      <dd>{m!.stateName}</dd>
                    </div>
                    <div>
                      <dt>Created</dt>
                      <dd>{fmtDate(m!.draftAt)}</dd>
                    </div>
                    <div>
                      <dt>Voting started</dt>
                      <dd>{fmtDate(m!.votingAt)}</dd>
                    </div>
                    <div>
                      <dt>Shortest hold-up</dt>
                      <dd>
                        {r!.actions.length
                          ? holdUp(Math.min(...r!.actions.map((a) => a.holdUpTime))).replace(' — executes immediately', '')
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Governance</dt>
                      <dd className="mono">{short(m!.governance)}</dd>
                    </div>
                    <div>
                      <dt>Proposal</dt>
                      <dd className="mono">{short(m!.pk)}</dd>
                    </div>
                  </dl>
                </div>
                {r!.notes.length ? (
                  <div className="alert neutral" style={{ fontSize: 12.5 }}>
                    <IInfo />
                    <div>
                      {r!.notes.map((n, i) => (
                        <div key={i}>{n}</div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </aside>
            </div>
          </div>
        )}
      </main>
      <Footer />
    </>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  )
}
