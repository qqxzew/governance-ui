# Open Realms — know what you vote for

**Unaudited, evaluation-grade.** Open-source (Apache-2.0), read-only governance front end for SPL Governance (Realms) DAOs, launching with **Marinade DAO**. A revived fork of [Mythic-Project/governance-ui](https://github.com/Mythic-Project/governance-ui): the original voting UI was replaced by a fast server-analysed reader, the safety engine and VSR math were kept.

On 2026-09-25 Marinade DAO was attacked with two proposals: a fake "MIP-23" (described as a *routine upgrade, no parameter changes*) that actually replaced the vote-counting VSR program, and "MIP-24" that moved 100% of several treasury accounts to a fresh wallet. The original Realms UI showed a generic yellow note on the first and **nothing** on the second.

## What it does

- **Risk badge on every proposal** (High risk / Review / No issues) with a one-line reason.
- **Proposal page — "what it really does":** every instruction decoded into a sentence, a "what changes" table, description vs. instructions side by side (≠ on contradiction), and rule-based findings: treasury outflow (amount, % of account and treasury, "never paid before"), voter-weight plugin replacement, authority changes, program upgrades, zero hold-up time, unknown programs. Proposal text never decides a flag; it is untrusted input and only compared. (`tools/proposalSafety`)
- **Real voting power (Marinade VSR):** paste any wallet, nothing is signed. Exact vote weight, locked tokens, every lockup and its decay, and the *deposited but not locked = 0 votes* warning. The math is a TypeScript port of the on-chain program, bit-exact for 7 mainnet voters. (`tools/vsr`)
- **Telegram alerts:** `/watch <realm>` — new proposals, voting started, and a 🔴 Danger alert on red findings. (`bots/telegram`)
- **Any realm, any governance program id** (Marinade runs its own instance `GovMaiH…`).

Safety: never custodies funds, no signing, RPC key stays on the server.

## Run (PowerShell, Node 18.19–22)

```powershell
npm install
Copy-Item .env.sample .env      # set RPC_UPSTREAM (e.g. a Helius URL); optional for the offline demo
npm run build
npm run offline                 # recorded Marinade data, no network: http://localhost:3100
# or live: npm start            # pre-warms MIP-23, MIP-24 and a benign proposal
```

Open `/dao/MNDE`, then `/dao/MNDE/proposal/7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj` (MIP-23) and `/dao/MNDE/proposal/EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9` (MIP-24).

| Command | What |
|---|---|
| `npm run dev` | dev server on :3100 |
| `npm run build` / `npm start` | production build / server with warm-up (`PORT` to change) |
| `npm run offline` | serve only `lens/demo-data` (no RPC) |
| `npm run snapshot` | copy the live cache `lens/.cache` into `lens/demo-data` (see note below) |
| `npm run bot -- --dry-run --realm MNDE` | print the Telegram alerts without sending ([bot README](bots/telegram/README.md)) |
| `npm test` | jest (engine, VSR, bot) |
| `npm run type-check` | `tsc` for `lens/` |

**Refreshing the offline demo.** Cache keys are versioned in code (`analysis2|…` in `lens/lib/server/safety.ts`). After bumping a version or changing engine rules, run the site live, open the Marinade pages (or hit `/api/warm`, `/api/verdicts`), then `npm run snapshot`. Review `lens/demo-data` before committing: it must contain **Marinade only** (never publish findings about other DAOs).

## Known limits

Read-only, rule-based and unaudited: it can miss things and flag legitimate proposals (every payment to a new address is High risk, unknown programs are Review). "Never paid before" relies on a bounded history scan. Exact voting power only for VSR realms. Free-tier RPC rate-limits under load.

---

*Original Realms UI: see upstream. Upstream swap-API note:* `NEXT_PUBLIC_JUPTER_SWAP_API_ENDPOINT=https://quote-api.jup.ag/v6`
