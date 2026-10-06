# Open Realms — know what you vote for

**Unaudited, evaluation-grade.** A revived, open-source fork of [Mythic-Project/governance-ui](https://github.com/Mythic-Project/governance-ui) (Apache-2.0) for SPL Governance (Realms), launching with **Marinade DAO**.

On 2026-09-25 Marinade DAO was attacked with two proposals: a fake "MIP-23" (described as a *routine upgrade, no parameter changes*) that actually replaced the vote-counting VSR program, and "MIP-24" that moved 100% of several treasury accounts to a fresh wallet. The original UI showed a generic yellow note on the first and **nothing** on the second.

This fork adds, for every voter:

- **Safety check — "What this proposal really does":** plain-language summary of every instruction, a "What changes" diff, and rule-based red/yellow findings: treasury outflow (amount, % of treasury, never-paid destination), voter-weight plugin replacement, authority changes, program upgrades, zero hold-up time, and *description vs. actions* mismatch. Unknown programs are flagged, never shown as silent raw bytes. (`tools/proposalSafety`, `components/ProposalSafety`)
- **Real MNDE voting power:** a TypeScript port of Marinade's VSR math, bit-exact with the on-chain program for 7 mainnet voters; a voting-power card with lockups and decay explained in one sentence; **Lock** is the default path and *deposit without lock = 0 votes* is shown loudly; lock/deposit transactions are simulated before signing. (`tools/vsr`, `components/VotingPowerCard`)
- **Telegram alerts for any Realm:** `/watch <realm>` — new proposals and red findings. (`bots/telegram`)
- **Any Realm, any governance program ID** (Marinade runs its own instance `GovMaiH…`).

Safety: never custodies funds; mainnet is read-only in demo builds; signing demos happen on devnet.

**Run the demo (offline, from a recorded snapshot) — PowerShell:**

```powershell
yarn install --frozen-lockfile --ignore-engines --ignore-scripts
yarn demo:build     # once, ~15 min
yarn demo:start     # replay RPC proxy + app on http://localhost:3000
```

Then open `/dao/MNDE/proposal/7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj` (MIP-23) and `/dao/MNDE/proposal/EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9` (MIP-24). Live mode, recording, devnet and the bot: see [README-DEMO.md](README-DEMO.md) and [bots/telegram/README.md](bots/telegram/README.md). Tests: `npx jest`.

---

*Upstream README follows.*

### Using custom Swap API endpoints

You can set custom URLs via the configuration for any self-hosted Jupiter APIs, like the [V6 Swap API](https://station.jup.ag/docs/apis/self-hosted) or [Paid Hosted APIs](https://station.jup.ag/docs/apis/self-hosted#paid-hosted-apis) Here is an example:

```
NEXT_PUBLIC_JUPTER_SWAP_API_ENDPOINT=https://quote-api.jup.ag/v6
```
