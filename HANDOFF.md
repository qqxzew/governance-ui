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

## State (2026-10-05 evening) — about 75% done
| Part | Status | Where |
|---|---|---|
| P1 fork on Node 22, custom program IDs, branding, "unaudited" banner, mainnet read-only guard | done; Linux not verified | `scripts/run-with-env.js`, `package.json` scripts, app shell |
| RPC proxy live/record/replay (public RPC returns 403 to browsers) | done | `scripts/rpc-proxy.js`, `README-DEMO.md` |
| P2 VSR math (bit-exact vs program for 7 mainnet voters), VotingPowerCard, Lock-first UX, simulate before signing | done; UI not yet clicked through in a running app | `tools/vsr/`, `components/VotingPowerCard/`, `VoteStakeRegistry/` |
| P3 safety engine + panel | engine + tests done (34 tests); panel committed but not visually verified; last commit de603f75 was WIP when the agent hit a limit | `tools/proposalSafety/`, `components/ProposalSafety/`, `fixtures/marinade/` |
| P4 Telegram bot | done (52 tests, dry-run verified on Marinade); never run with a real token | `bots/telegram/` |
| P5 VSR sanity check | done (function + test only; results are private, never publish) | `tools/vsr/sanityCheck.ts` |
| Offline demo snapshot | NOT recorded yet | `demo/snapshot/rpc.json` (to create) |
| Devnet Lock demo | NOT done | — |

## Remaining work, in order
1. `npx jest` (whole repo) and `yarn type-check`; fix anything broken by the parallel agents' merges.
2. Run the app (`README-DEMO.md` §2) and visually check the ProposalSafetyPanel on MIP-23 `7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj`, MIP-24 `EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9` and benign `CrbL16mpZRFJwKqkMsnVjHRP44n422opfQ1pGRL6zGoz`. Required on screen: MIP-23 red "Description says: routine upgrade, no parameter changes. Actually: replaces the voting program"; MIP-24 red "Moves X MNDE (100% of the account) to an address this DAO never paid". Benign: no red. Make the panel show instruction-based findings immediately and the payment-history-based ones later (the history scan used to hang for minutes).
3. Bot: confirm `bots/telegram/safety.ts` picks up `tools/proposalSafety/index.ts` (`yarn bot --dry-run --realm MNDE --last 5` must print red alerts for MIP-23/24).
4. Record the offline snapshot (`README-DEMO.md` §3: `yarn rpc:record` + open the realm page, MIP-23, MIP-24, CrbL, own voting power), then verify `yarn demo` works with the network off. Check that the snapshot file does not contain the API key.
5. Devnet Lock demo: devnet realm with VSR (or the docs path in `README-DEMO.md` §5); Lock flow signs only on devnet.
6. Final report: what was built, what not and why, exact PowerShell commands for the demo. Keep CLAUDE.md updated; commit after each step.

## Environment notes
- Windows + PowerShell for the team; Node 22; install: `yarn install --frozen-lockfile --ignore-engines --ignore-scripts`.
- Helius key lives only in `.env.local` / `.env` (gitignored). Never print, log or commit it, and never write it into fixtures or snapshots.
- Public mainnet RPC returns 403 to any browser request (Origin header). Always run the UI through `scripts/rpc-proxy.js` or with the Helius URL.
- `next dev` first compile takes ~4 min (Babel); each proposal page compile adds 1-2 min.
- Hard rules: never custody funds; simulate before signing; mainnet read-only in the demo; never publish lists of exploitable DAOs; never invent instruction layouts or program IDs.
