import Head from 'next/head'
import { useRouter } from 'next/router'
import { FormEvent, useEffect, useState } from 'react'
import {
  Footer,
  IAlert,
  IInfo,
  RealmHeader,
  RealmSummary,
  Skel,
  TopBar,
  useApi,
  useQueryParam,
} from '../../../components/ui'
import { fmtAmount, fmtDate, fmtDuration, short } from '../../../lib/format'

interface Power {
  wallet: string
  supported: boolean
  reason?: string
  token: string
  decimals: number
  hasVoter: boolean
  votingPower: string
  locked: string
  unlocked: string
  unlockedWithoutPower: string
  deposits: { kind: string; locked: string; unlocked: string; secondsLeft: number; endTs: number | null; votingPower: string }[]
  formula: string
  baselineZero: boolean
  asOf: number
}

// Public mainnet voter from the test fixtures (several lockups + an unlocked deposit).
const EXAMPLE = 'F5QrKJ6xDe9z4YGAwYap6E8jgrtbC5whYqJK3urAKMWm'

export default function PowerPage() {
  const router = useRouter()
  const realmParam = useQueryParam('realm')
  const wallet = useQueryParam('wallet')
  const [input, setInput] = useState('')
  const [phantomErr, setPhantomErr] = useState<string>()
  useEffect(() => setInput(wallet ?? ''), [wallet])

  const realmRes = useApi<{ realm: RealmSummary; proposals: unknown[] }>(
    realmParam ? `/api/realm?realm=${encodeURIComponent(realmParam)}` : null,
  )
  const { data, error, loading } = useApi<{ power: Power }>(
    realmParam && wallet ? `/api/power?realm=${encodeURIComponent(realmParam)}&wallet=${encodeURIComponent(wallet)}` : null,
  )
  const realm = realmRes.data?.realm

  const go = (w: string) =>
    router.push({ pathname: '/dao/[realm]/power', query: { realm: realmParam, wallet: w.trim() } }, undefined, { scroll: false })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (input.trim()) go(input)
  }
  const phantom = async () => {
    setPhantomErr(undefined)
    const provider = (window as any).phantom?.solana ?? (window as any).solana
    if (!provider?.connect) return setPhantomErr('Phantom not found in this browser.')
    try {
      const res = await provider.connect()
      const pk = (res?.publicKey ?? provider.publicKey)?.toString()
      if (pk) go(pk)
    } catch {
      setPhantomErr('Connection cancelled.')
    }
  }

  const p = data?.power
  const tok = p?.token ?? 'tokens'
  const amt = (x: string) => (p ? fmtAmount(x, p.decimals, 2) : '')

  return (
    <>
      <Head>
        <title>Voting power · Open Realms</title>
      </Head>
      <TopBar active="power" />
      <main className="wrap">
        <RealmHeader realm={realm} tab="power" count={realmRes.data?.proposals.length} />

        <div className="card card-pad" style={{ marginTop: 20 }}>
          <div className="h2">Check voting power</div>
          <p className="muted" style={{ margin: '4px 0 14px', fontSize: 13.5 }}>
            Exactly what the on-chain voting program will count for a wallet — read-only, nothing to sign.
          </p>
          <form onSubmit={submit} className="row" style={{ flexWrap: 'wrap' }}>
            <input
              className="input mono grow"
              style={{ minWidth: 260 }}
              placeholder="Wallet address"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Wallet address"
              spellCheck={false}
            />
            <button className="btn" type="submit">
              Check
            </button>
            <button className="btn secondary" type="button" onClick={phantom}>
              Use Phantom
            </button>
          </form>
          <div className="row" style={{ marginTop: 10, fontSize: 13 }}>
            <a href="#" className="dim" onClick={(e) => (e.preventDefault(), go(EXAMPLE))}>
              Try an example wallet →
            </a>
            {phantomErr ? <span style={{ color: 'var(--red)' }}>{phantomErr}</span> : null}
          </div>
        </div>

        {!wallet ? null : error ? (
          <div className="alert red" style={{ marginTop: 14 }}>
            <IAlert />
            <div>
              <b>Could not read this wallet.</b>
              <p>{error}</p>
            </div>
          </div>
        ) : loading || !p ? (
          <div className="grid-stats" style={{ marginTop: 14 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card stat-card" style={{ display: 'grid', gap: 10 }}>
                <Skel w="40%" h={10} />
                <Skel w="60%" h={24} />
              </div>
            ))}
          </div>
        ) : !p.supported ? (
          <div className="alert neutral" style={{ marginTop: 14 }}>
            <IInfo />
            <div>{p.reason}</div>
          </div>
        ) : (
          <div className="fade" style={{ display: 'grid', gap: 14, marginTop: 14 }}>
            <div className="grid-stats">
              <div className="card stat-card">
                <div className="label">Voting power · {short(p.wallet, 4)}</div>
                <div className="big" style={{ marginTop: 8 }}>
                  {amt(p.votingPower)}
                  <small>votes</small>
                </div>
              </div>
              <div className="card stat-card">
                <div className="label">Locked {tok}</div>
                <div className="v">{amt(p.locked)}</div>
              </div>
              <div className={`card stat-card ${p.baselineZero && p.unlocked !== '0' ? 'bad' : ''}`}>
                <div className="label">Deposited, not locked</div>
                <div className="v">{amt(p.unlocked)}</div>
              </div>
            </div>

            {!p.hasVoter ? (
              <div className="alert neutral">
                <IInfo />
                <div>
                  <b>No deposit in this realm.</b>
                  <p>Only locked {tok} gives voting power here{p.baselineZero ? '; a plain deposit counts as 0' : ''}.</p>
                </div>
              </div>
            ) : p.baselineZero && p.unlockedWithoutPower !== '0' ? (
              <div className="alert red">
                <IAlert />
                <div>
                  <b>
                    {amt(p.unlockedWithoutPower)} {tok} deposited but not locked — 0 voting power.
                  </b>
                  <p>Lock it to vote. In this realm only locked tokens count.</p>
                </div>
              </div>
            ) : null}

            {p.formula ? (
              <div className="alert neutral">
                <IInfo />
                <div>{p.formula}</div>
              </div>
            ) : null}

            {p.deposits.length ? (
              <div className="card">
                <div className="card-h">
                  <h3>Deposits</h3>
                  <span className="dim" style={{ fontSize: 12 }}>
                    as of {fmtDate(p.asOf)}
                  </span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Lockup</th>
                        <th>Locked</th>
                        <th>Not locked</th>
                        <th>Time left</th>
                        <th style={{ textAlign: 'right' }}>Voting power</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.deposits.map((d, i) => (
                        <tr key={i}>
                          <td>{d.kind === 'None' ? 'Not locked' : d.kind}</td>
                          <td>{amt(d.locked)}</td>
                          <td style={{ color: d.unlocked !== '0' && p.baselineZero ? 'var(--red)' : undefined }}>{amt(d.unlocked)}</td>
                          <td className="muted">
                            {d.kind === 'Constant'
                              ? `${fmtDuration(d.secondsLeft)} (doesn't decay)`
                              : d.endTs
                              ? `${fmtDuration(d.secondsLeft)} · until ${fmtDate(d.endTs)}`
                              : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{amt(d.votingPower)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </main>
      <Footer />
    </>
  )
}
