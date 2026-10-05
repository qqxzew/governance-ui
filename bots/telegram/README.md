# Telegram proposal-notification bot

Standalone Node bot (no Telegram library, no extra npm deps) that watches SPL Governance (Realms)
DAOs and sends Telegram alerts:

- **🆕 New proposal**: name, state and a link `APP_URL/dao/<symbol-or-realm>/proposal/<pk>`
- **🗳 Voting started**: a watched proposal moved into Voting
- **🔴 Danger**: the proposal safety engine (`tools/proposalSafety`) reported at least one
  **red** finding. The alert lists each finding's title and explanation. Proposals in
  Draft / SigningOff / Voting are re-checked whenever their transactions change.

Unaudited, evaluation-grade. Read-only: the bot never signs or sends transactions.

## 1. Create the bot (BotFather)

1. In Telegram open **@BotFather** and send `/newbot`.
2. Pick a display name and a username ending in `bot` (e.g. `MarinadeGovAlertsBot`).
3. BotFather replies with a token like `123456789:AA...`. **Treat it as a password.**
4. Optional: `/setcommands` → choose your bot → paste:
   ```
   watch - Watch a realm: /watch MNDE or /watch <realm address>
   unwatch - Stop watching a realm
   list - Realms this chat watches
   help - Help
   ```
5. Optional, for groups: `/setprivacy` → *Enable* (the bot then only sees commands).

## 2. Configure

The token is read **only** from the environment variable `TELEGRAM_BOT_TOKEN`
(or from the repo-root `.env`, which is gitignored). Never commit it, never paste it in issues/logs.
The bot redacts it from every error message (the Bot API URL contains it).

Option A: `.env` in the repo root (copy the `TELEGRAM_*` lines from `.env.sample`):

```
TELEGRAM_BOT_TOKEN=123456789:AA...
```

Option B: PowerShell, current session only:

```powershell
$env:TELEGRAM_BOT_TOKEN = Read-Host "Telegram bot token"   # does not end up in history files
```

Other settings (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `BOT_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC. Public RPC rate-limits (HTTP 429, retried with backoff); a Helius URL or `http://localhost:8898` (`scripts/rpc-proxy.js`) is smoother. Only scheme+host are ever logged. |
| `BOT_POLL_SECONDS` | `60` | Poll interval (min 10). Only realms with ≥1 subscriber are polled. |
| `APP_URL` | `http://localhost:3000` | Base URL used in alert links. |
| `TELEGRAM_ALLOWED_CHATS` | *(empty = anyone)* | Comma-separated chat ids allowed to use commands. Recommended for a private deployment; ignored chats are logged with their id so you can add them. |
| `BOT_MAX_REALMS` | `50` | Global cap on watched realms (protects the RPC). |
| `BOT_MAX_WATCHES_PER_CHAT` | `10` | Per-chat cap. |
| `BOT_DATA_DIR` | `bots/telegram/data` | Where `state.json` lives (gitignored). |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Only for a self-hosted Bot API server or a local mock (`http://localhost:<port>` allowed). |

## 3. Run (PowerShell)

From the repo root (`yarn install --frozen-lockfile --ignore-engines --ignore-scripts` done once):

```powershell
# Test without Telegram and without a token: poll Marinade once and print the alerts
# the bot WOULD send (the 5 newest proposals are treated as unseen; state.json untouched).
yarn bot --dry-run --realm MNDE
yarn bot --dry-run --realm 899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo --last 3
yarn bot --dry-run --realm MNDE --last 0 --forget 7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj

# Faster/without 429s: through the local RPC proxy (second terminal: yarn rpc:live)
$env:BOT_RPC_URL = "http://localhost:8898"; yarn bot --dry-run --realm MNDE

# Run the bot (Ctrl+C to stop; state is saved)
$env:TELEGRAM_BOT_TOKEN = Read-Host "Telegram bot token"
yarn bot

# One polling round for all watched realms (sends alerts), then exit — e.g. for Task Scheduler
yarn bot --once
```

With npm instead of yarn: `npm run bot -- --dry-run --realm MNDE`.

Then in Telegram, message your bot:

```
/watch MNDE
/list
/unwatch MNDE
```

`<realm>` is a realm address (base58, validated strictly) or a symbol from
`public/realms/mainnet-beta.json` (case-insensitive, e.g. `MNDE`). The governance program id is
taken from that registry or from the realm account's on-chain owner, so custom program instances
work (Marinade: `GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs`). The first poll of a newly watched
realm is a **baseline**: existing proposals are recorded without alerts (active ones still get a
safety check, so a running dangerous vote is reported).

## How it works

- **Telegram**: `getUpdates` long polling (50 s) over `fetch`; `sendMessage` as plain text
  (no `parse_mode`), link previews off, 429 `retry_after` honoured; chats that block the bot are
  unsubscribed. Proposal names/descriptions/finding text are attacker-controlled: they are sent as
  plain text (no Markdown/HTML injection possible), bidi/zero-width/control characters are stripped,
  and URLs / bare domains / @mentions are defanged (`hxxps://evil[.]com`, `[@]name`) so Telegram does
  not turn them into clickable links. Messages are capped at 4096 UTF-16 units.
- **Chain reads** (raw `getProgramAccounts`, not `getGovernanceAccounts`, which throws
  "account is not supported" on Marinade):
  1. governances of the realm: memcmp `[accountType, realm]` at offset 0 for GovernanceV2 18,
     ProgramGovernanceV2 19, MintGovernanceV2 20, TokenGovernanceV2 21 (+ V1 3/4/9/10),
     `dataSlice` length 0; cached for 10 minutes;
  2. proposals: `dataSlice` of the first 66 bytes (type, governance, mint, state). Programs that host a
     single registered realm (e.g. Marinade's own instance) use one program-wide call filtered by
     ProposalV2 (14); shared programs use one call per governance (memcmp `[14, governance]`);
  3. full proposal accounts (`getMultipleAccounts`, parsed with `GovernanceAccountParser(Proposal)`)
     only for new proposals and those in Draft/SigningOff/Voting;
  4. transaction signature for active proposals = option counters + sha256 over the proposal's
     ProposalTransaction accounts (catches remove + re-insert at the same index). Computed every poll
     while Draft (the only state in which transactions can change), once after each state change.
- **Safety engine**: `bots/telegram/safety.ts` dynamically requires `tools/proposalSafety/index.ts`
  (`loadProposalSafetyInput` + `analyzeProposal`). If it is missing or fails to load the bot logs it
  once and runs without danger alerts. A danger alert is not repeated for the same transaction set
  and finding ids.
- **State**: `bots/telegram/data/state.json` (subscriptions, Telegram offset, last-seen proposals per
  realm), written atomically (temp file + fsync + rename). Delete it to reset the bot.
- **RPC**: custom fetch for web3.js `Connection` with exponential backoff + jitter on 429/5xx/network
  errors, honouring `Retry-After`.

## Tests

```powershell
npx jest bots/telegram
npx tsc --noEmit -p bots/telegram/tsconfig.json
```

No network: command parsing, realm resolution (registry + fake RPC), new/seen proposal diffing,
safety re-check and danger dedupe, Telegram text sanitising, token redaction (incl. mocked fetch
failures), atomic state, safety adapter with a stub engine.

## Files

| File | Purpose |
|---|---|
| `index.ts` | CLI entry, bot loop (updates + poller), dry run |
| `telegram.ts` | Bot API client (fetch) |
| `commands.ts` | `/start /help /watch /unwatch /list` |
| `realms.ts` | input validation, registry + on-chain realm resolution |
| `chain.ts` | getProgramAccounts filters, proposal parsing, tx signatures |
| `poller.ts` | diffing and alert generation |
| `safety.ts` | adapter to `tools/proposalSafety` |
| `text.ts` | message formatting and sanitising |
| `redact.ts`, `env.ts`, `rpc.ts`, `state.ts` | secrets redaction, config/.env, retrying RPC, persistence |
