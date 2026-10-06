# HANDOFF — read this first, then CLAUDE.md

You are taking over an almost-finished hackathon project. Read `CLAUDE.md` (verified facts, safety rules, folder ownership) before changing anything.

## What the project is
Open-source governance UI for SPL Governance (Realms), a revived fork of Mythic-Project/governance-ui (Apache-2.0), launching with Marinade DAO.
Hackathon: Build Station Prague, Marinade sidetrack. Demo Day 2026-10-07 14:00 Prague (Colosseum until 2026-10-12).
Three things for voters:
1. MNDE holders see their real voting power and lock without the "Deposit gives 0 votes" trap.
2. Every proposal gets a plain-language "What this proposal really does" panel with red/yellow warnings (treasury drain, voting-plugin replacement, authority change, no hold-up time, description vs. actions mismatch).
3. Telegram alerts for any Realm (`/watch <realm>`), including red warnings.
Motivation: the 2026-09-25 Marinade attack. Fake "MIP-23" (said "routine upgrade, no parameter changes") actually upgraded the VSR vote-counting program; "MIP-24" drained 100% of treasury token accounts. The original UI showed only a generic yellow on MIP-23 and **nothing** on MIP-24 (verified in Chrome 2026-10-05).

## State (2026-10-06) — about 90% done
| Part | Status |
|---|---|
| P1 fork on Node 22 (jest 151 tests, tsc clean, next build OK on Windows), custom program IDs, fork branding + own design | done; Linux not verified |
| RPC proxy live/record/replay; offline snapshot `demo/snapshot/rpc.json.gz` (replay 688/688) | done |
| P2 VSR math (bit-exact, 7 voters), VotingPowerCard, Lock-first UX, simulate before signing | done; card needs a wallet, not clicked through live |
| P3 safety engine + panel | done and verified live: MIP-23/24 red with plain-language text, benign proposal no red |
| P4 Telegram bot | done; red alerts verified in dry-run; never run with a real token |
| P5 VSR sanity check | done (function + test only; results private) |
| Devnet Lock demo | NOT done (README-DEMO.md §5 describes the manual path) |

## Remaining work, in order
1. Confirm `yarn demo:start` works with the network off (offline replay in the browser). If a page hangs, check `curl http://localhost:8898/misses` and re-record that page with `yarn demo:record`.
2. Devnet Lock demo: create a devnet realm with the VSR plugin (or use an existing one) and walk through Lock → voting power card → vote.
3. Run the bot with a real token (`TELEGRAM_BOT_TOKEN` in .env), `/watch MNDE`.
4. Verify on Linux: install, `npx jest`, `yarn build`.
5. Optional: LLM phrasing of findings (rules decide; LLM only rephrases; description is untrusted).

## Environment notes
- Windows + PowerShell for the team; Node 22; install: `yarn install --frozen-lockfile --ignore-engines --ignore-scripts`.
- Helius key lives only in `.env.local` / `.env` (gitignored). Never print, log or commit it, and never write it into fixtures or snapshots.
- Public mainnet RPC returns 403 to any browser request (Origin header). Always run the UI through `scripts/rpc-proxy.js` or with the Helius URL.
- `next dev` first compile takes ~4 min (Babel); each proposal page compile adds 1-2 min.
- Hard rules: never custody funds; simulate before signing; mainnet read-only in the demo; never publish lists of exploitable DAOs; never invent instruction layouts or program IDs.
