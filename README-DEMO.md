# Demo guide: Open Realms (community fork)

> **Unaudited, evaluation-grade software.** This is a community fork of
> [Mythic-Project/governance-ui](https://github.com/Mythic-Project/governance-ui)
> (Apache-2.0). It is not operated by or affiliated with Realms Today Ltd.
> In demo builds **mainnet is read-only**: the app refuses to sign or send
> mainnet transactions. Signing demos run on **devnet only**.

The project name lives in one constant: `constants/branding.ts` (`APP_NAME`).

## What you need

- Node.js **22** (supported range `>=18.19.0 <23`; tested on 22.23.2). `.nvmrc` says `22`.
- Yarn 1 (`npm i -g yarn@1.22.19`, or `corepack enable`).
- Git. Commands below are for **Windows PowerShell**; Linux/macOS equivalents follow each block.
- About 8 GB of free RAM for `next build`. `next dev` needs about 4 GB.

Ports used by the demo:

| Port | What |
| ---- | ---- |
| 3000 | Next.js app |
| 8898 | `scripts/rpc-proxy.js`: HTTP JSON-RPC |
| 8899 | `scripts/rpc-proxy.js`: WebSocket. web3.js always uses the HTTP port + 1 for subscriptions. 8899 is also the default port of `solana-test-validator`, so don't run both, or pass `--port`/`--ws-port`. |

## 1. Install

```powershell
git clone <this repo> marinade-gov-ui
cd marinade-gov-ui
yarn install --frozen-lockfile --ignore-engines --ignore-scripts
copy .env.sample .env   # optional; never commit .env
```

```bash
# Linux/macOS
yarn install --frozen-lockfile --ignore-engines --ignore-scripts
cp .env.sample .env
```

Here is why the install uses these flags:

- `--ignore-engines`: some old transitive dependencies declare outdated `engines` fields.
- `--ignore-scripts`: install scripts don't run. Because of this, the native `bigint-buffer` binding isn't built, and you'll see `bigint: Failed to load bindings, pure JS will be used`. **This warning is harmless.** web3.js falls back to the pure-JS implementation, which is the same code the browser bundle always uses. You don't need to run `yarn bigint-fix`, which would also need a C++ toolchain on Windows.

## 2. Run against live mainnet (through the local proxy)

The public mainnet RPC returns **403 to browser requests** because it rejects the
`Origin` header. It also rate-limits with 429. The proxy strips `Origin`, retries 429s
with backoff and blocks `sendTransaction`.

Use one terminal for both the proxy and the app:

```powershell
yarn dev:mainnet:proxy
# open http://localhost:3000   -> redirects to /dao/MNDE
```

Or use two terminals:

```powershell
# terminal 1
yarn rpc:live
# terminal 2
yarn dev:mainnet
```

To use a provider key, which avoids most 429s, set the upstream for the proxy. The proxy
keeps the query string and redacts it in its logs:

```powershell
$env:UPSTREAM = "https://mainnet.helius-rpc.com/?api-key=<your-key>"
yarn rpc:live
```

```bash
# Linux/macOS
UPSTREAM="https://mainnet.helius-rpc.com/?api-key=<your-key>" yarn rpc:live
```

`dev:mainnet` sets `REALM=MNDE`, `NEXT_PUBLIC_MAINNET_RPC=http://localhost:8898` and
`NEXT_PUBLIC_READ_ONLY_MAINNET=true` through `scripts/run-with-env.js`, so it works the
same way in PowerShell, cmd and bash. Values that are already set in your environment
take precedence. The first `next dev` compile takes about 4 minutes because the app uses
Babel (`.babelrc`), not SWC.

## 3. Record an offline snapshot

The snapshot goes to `demo/snapshot/rpc.json`. Recording merges into an existing file,
so you can record across several sessions.

```powershell
yarn demo:record          # proxy in record mode + next dev, same env as dev:mainnet
```

Wait for the first compile. Then visit these pages and let each one finish loading.
On each proposal page, scroll to the bottom and open the instructions/transactions panel.

1. Realm home: <http://localhost:3000/dao/MNDE>
2. Malicious MIP-23 (VSR program upgrade): <http://localhost:3000/dao/MNDE/proposal/7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj>
3. Malicious MIP-24 (treasury drain): <http://localhost:3000/dao/MNDE/proposal/EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9>
4. Benign proposal (USDC vault allocator update): <http://localhost:3000/dao/MNDE/proposal/CrbL16mpZRFJwKqkMsnVjHRP44n422opfQ1pGRL6zGoz>
5. Optional: the legit MIP-23 (PSR) at `/dao/MNDE/proposal/Gd5CfxVQ1UYm4wToL5SVb9QhmCtcBTHo73QDnGMAmu6S`, plus the Treasury and Members tabs if you want to show them.

Check progress from another terminal:

```powershell
Invoke-RestMethod http://localhost:8898/        # mode, entry count, hit/miss stats
```

```bash
curl -s http://localhost:8898/
```

When you're done, press **Ctrl+C**. The snapshot is written within about 1 s of each new
response and once more on exit.

Then verify the snapshot offline. This replays every recorded request through the replay
proxy and reads the realm and the 3 demo proposals with web3.js:

```powershell
yarn demo:verify
```

You can also record without the app, for example from a script, with `yarn rpc:record`.

**What gets recorded:** only public on-chain data (method, params, result). The upstream
URL, and with it any API key, is **not** stored. Rate-limit errors are never recorded.

## 4. Replay offline (the demo)

```powershell
yarn demo                 # replay proxy + next dev
```

For a faster demo, build once and then serve the production build. `NEXT_PUBLIC_*`
values are inlined at build time, which is why there are separate demo scripts:

```powershell
yarn demo:build           # once; output goes to .next-demo
yarn demo:start           # replay proxy + next start on :3000
```

How replay works (`scripts/rpc-proxy.js --mode replay`):

- **Request matching:** requests match on `method` + canonical `params`, with object keys sorted and the JSON-RPC `id` ignored. If there's no exact match, the proxy tries again ignoring `commitment`/`minContextSlot`. Answers keep each request's own `id`, including in batches.
- **Fast-changing values:** for `getSlot`, `getLatestBlockhash`, `getEpochInfo`, `getBlockHeight` and similar, the proxy serves the last recorded value.
- **Requests that were never recorded:** the proxy returns a JSON-RPC error (`-32001`) and logs `REPLAY MISS`. To list the misses, run `Invoke-RestMethod http://localhost:8898/misses` (bash: `curl -s http://localhost:8898/misses`). To fill them, re-run `yarn demo:record` and visit the page again.
- **WebSocket subscriptions (port 8899):** they are accepted but never fire, because the data is frozen.
- **Data that isn't JSON-RPC** is not proxied, so it is missing offline: token prices, Jupiter, `api.realms.today`, NFT/DAS calls. The UI shows fallbacks for it.

## 5. Devnet signing demo

Mainnet stays read-only. Any attempt to sign or send a mainnet transaction fails with
**"Mainnet is read-only in this demo build; switch to devnet"**:

- the shared sign/send helpers check before the wallet popup (`utils/readOnlyMainnet.ts`);
- web3.js `Connection` send methods are patched as a backstop;
- the proxy itself also refuses `sendTransaction` unless you start it with `--allow-send`.

Steps:

1. Switch your wallet (Phantom/Solflare/Backpack) to **devnet** and fund it at <https://faucet.solana.com>.
2. In the app, use the wallet menu's cluster switch, or add `?cluster=devnet` to the URL. Devnet uses `NEXT_PUBLIC_DEVNET_RPC`, which defaults to a public devnet RPC. Browser requests work there without the proxy.
3. Create a test DAO at `http://localhost:3000/realms/new?cluster=devnet` (community-token or multisig wizard), create a proposal, then vote and execute.

Note that `REALM=MNDE` pins the home redirect to Marinade. You can still open any
`/dao/<pubkey>?cluster=devnet` URL directly.

The flag that controls this is `NEXT_PUBLIC_READ_ONLY_MAINNET=true` (set by `dev:mainnet`,
`demo*`, and `.env.sample`). It only makes devnet, testnet and `127.0.0.1:8899`
writable. Every other endpoint counts as mainnet, so the check fails closed.

## 6. Build and type-check (Node 22)

```powershell
yarn type-check            # tsc --noEmit --skipLibCheck
yarn build                 # next build with an 8 GB heap (run-with-env sets NODE_OPTIONS)
```

To build while a `next dev` is running from the same folder, use a separate output dir:

```powershell
$env:NEXT_DIST_DIR = ".next-build"; yarn build
```

```bash
NEXT_DIST_DIR=.next-build yarn build
```

Node 22 needs no OpenSSL legacy provider (`--openssl-legacy-provider` is **not** needed).
Next 12.3's bundled webpack uses its own md4 implementation.

Proxy unit tests: `yarn test:scripts` (or `npx jest scripts/__tests__`).

## Script reference

| Script | What it does |
| ------ | ------------ |
| `rpc:live` | Proxy: forward to `UPSTREAM` (default public mainnet), strip Origin, retry 429 |
| `rpc:record` | Proxy: forward + record into `demo/snapshot/rpc.json` |
| `rpc:replay` | Proxy: serve only from the snapshot (no network) |
| `dev:mainnet` | `next dev` with `REALM=MNDE`, mainnet RPC = proxy, read-only mainnet |
| `dev:mainnet:proxy` | `rpc:live` + `dev:mainnet` in one terminal |
| `demo:record` | record proxy + `next dev` |
| `demo` | replay proxy + `next dev` (offline) |
| `demo:build` / `demo:start` | production build (`.next-demo`) / replay proxy + `next start` |
| `demo:verify` | Offline check of the snapshot |

Proxy flags: `--mode live|record|replay`, `--snapshot <file>`, `--port 8898`,
`--ws-port <n>` / `--no-ws`, `--upstream <url>`, `--allow-send`, `--quiet`
(env: `RPC_PROXY_MODE`, `RPC_SNAPSHOT`, `PORT`, `WS_PORT`, `UPSTREAM`, `RPC_ALLOW_SEND`).

## Troubleshooting

- **"cannot listen on 8898"**: another proxy is already running. Find it with `Get-NetTCPConnection -LocalPort 8898` (bash: `lsof -i :8898`), or use `--port`.
- **Empty pages on live mainnet**: the public RPC rate-limits heavy `getProgramAccounts` calls. Use a provider key through `UPSTREAM`.
- **Offline page shows errors**: run `Invoke-RestMethod http://localhost:8898/misses` and re-record that page.
