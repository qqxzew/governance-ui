# HANDOFF — read this first, then CLAUDE.md

Open Realms: open-source, read-only governance front end for SPL Governance (Realms), launching with Marinade DAO. Hackathon: Build Station Prague, Marinade sidetrack (Demo Day 2026-10-07 14:00 Prague; Colosseum until 2026-10-12). Pitch brief and demo flow: see the team chat; summary in README.md.

## State (2026-10-06, evening)
| Part | Status |
|---|---|
| `lens/` site (list with risk badges, proposal page, voting power page, offline mode) | done, builds, offline verified |
| Safety engine `tools/proposalSafety` | done; MIP-23 / MIP-24 red, benign CrbL yellow only |
| VSR math `tools/vsr` (bit-exact for 7 mainnet voters) | done |
| Telegram bot `bots/telegram` | done; dry-run verified; **never run with a real token in this checkout** |
| Tests | `npx jest`: 10 suites / 132 tests pass; both `tsc` projects clean |
| Public deployment | **not deployed** (runs locally / offline); target host mentioned in chat: mrrobot.hackclub.app |

## What changed on 2026-10-06 (evening)
- Pinned `rpc-websockets` to 7.11.0 via `overrides` in package.json (7.11.2 broke `require('@solana/web3.js')` in Node/jest, so 8 of 10 suites could not start).
- Regenerated `lens/demo-data` for cache version `analysis2` (it still held old `analysis|` keys, so offline mode returned 404 for proposals). Marinade only.
- Bot: removed the `tsconfig-paths/register` requirement (package no longer installed, no aliases used), default `APP_URL` is now `http://localhost:3100`.
- Tabs on realm pages no longer link to `/dao//power` while the realm is still loading.
- README, `.env.sample`, bot README, CLAUDE.md updated to the real layout (npm scripts, no `yarn demo:*`, no rpc-proxy).

## Remaining work, in order
1. Deploy `lens/` somewhere always-on (`NEXT_STANDALONE=1 npm run build`, `RPC_UPSTREAM` server-side only) and run the bot there with `TELEGRAM_BOT_TOKEN`; then `/watch MNDE`.
2. Run `npm start` live once with a real RPC key to confirm cold-load times, then `/api/warm`.
3. Optional: LLM phrasing of findings (rules decide; LLM only rephrases; the description is untrusted).
4. Optional: verify install, `npx jest` and `npm run build` on Linux.

## Environment notes
- Windows + PowerShell for the team; Node 22; `npm install` (use `--ignore-scripts` if native builds fail; bigint-buffer falls back to pure JS).
- RPC key lives only in `.env` / `.env.local` (gitignored) as `RPC_UPSTREAM` or `BACKEND_MAINNET_RPC`. Never print, log or commit it, and never write it into fixtures or demo-data.
- Public mainnet RPC works from Node but rate-limits (429); use a provider URL for anything beyond a quick check.
- Hard rules: never custody funds; read-only on mainnet; never publish lists of exploitable DAOs (keep other DAOs' findings out of committed files); never invent instruction layouts or program IDs.
