# CLAUDE.md — Open governance UI (revived fork of Mythic-Project/governance-ui)

Goal: voter-facing governance UI for SPL Governance, first-class support for Marinade DAO.
Status: **Phase 1 (build) in progress.** Unaudited, evaluation-grade.

## Safety rules (hard)
- Never custody funds; only build transactions the user signs. Simulate before signing.
- Demo signing = devnet only. Mainnet = read-only. Mark app "unaudited, evaluation-grade".
- Do not publish anything listing DAOs as exploitable. P5 mismatches in other DAOs -> report privately.
- Do not invent account fields / instruction layouts / program IDs. Check source or IDL.
- Telegram token only from .env; never log or commit it.
- Team uses Windows PowerShell: give PowerShell commands.

## Repo facts (verified 2026-10-05)
- Upstream: https://github.com/Mythic-Project/governance-ui, HEAD 531440354a44 "mango banner (#243)", 2026-01-30, 2801 commits.
- LICENSE file = Apache 2.0, but package.json says `"license": "MIT"` (mismatch — fix in fork).
- package.json engines: node 18.19.0, yarn 1.22.19 (.nvmrc = lts/iron). We run Node 22.23.2 / npm 10.9.8.
- Existing code map:
  - Instruction decoders: `components/instructions/programs/*.tsx` (bpfUpgradeableLoader, splToken, voteStakeRegistry, governance, ...); names in `programs/names.ts`; address labels in `components/instructions/tools.tsx`.
  - Warnings: `pages/dao/[symbol]/proposal/[pk]/ProposalWarnings.tsx`. Rules today: SetGovernanceConfig (data[0]==19, yellow), SetRealmConfig (data[0]==22 or writable realm-config acct, yellow), third-party program writing realm config (red), possible wrong governance (yellow), BPF loader any instruction -> "programUpgrade" (yellow, generic), buffer authority != treasury/governance (red), Mango forwarder (yellow). NO treasury-outflow rule, NO voter-weight-addin rule, NO description-vs-actions check.
  - Dry run: `actions/dryRunInstruction.ts` (simulateTransaction with sigVerify off).
  - VSR: `VoteStakeRegistry/`, `VoterWeightPlugins/`; Marinade VSR id already in `constants/plugins.ts` VSR_PLUGIN_PKS; Marinade realm already in `public/realms/mainnet-beta.json` (programId GovMaiH...).

## Verified on-chain facts (mainnet, 2026-10-05)
- Realm `899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo` "Marinade DAO", owner = `GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs` (own instance, executable, upgradeable).
- Community mint MNDE `MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey` (9 decimals); council mint `6MGwpuJ5YE1c8jJaF8FKurQdDJeYRf1adX76dovkXxRs`.
- Realm authority = governance account `FsrqQfLGdFVtySSSsyZJUzVBA9bvGZSKyhp7nsJCqgJe`.
- RealmConfig `CFsN3hcLSK4sQyeEm9kYg7uNBsygR8xm445r8Kk7CvFK`: community voterWeightAddin = `VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS` (VSR); no max-voter-weight addin.
- VSR program `VoteMBh...` executable; ProgramData `C6k3BuxsDjihWAP5mVxCLWxEVMAgvifUS95u78ym2xiT`; upgrade authority = governance `2w6ny74cU6yRxkD6ZACh5M1JznLQ1KB6AUsB7zo2NBHX` (ProgramGovernanceV2).
- Registrar `5zgEgPbWKsAAnLPjSM56ZsbLPfVM6nUzh3u45tCnm97D` (owner = VSR program, 880 bytes, layout matches marinade VSR source `state/registrar.rs`):
  one voting mint = MNDE; baseline_vote_weight_scaled_factor = 0; max_extra_lockup_vote_weight_scaled_factor = 1_000_000_000 (1.0);
  lockup_saturation_secs = 2_678_400 (31 days); digit_shift = 0; grant_authority = `8z6A4qSfL9FFvwX12zqt6HrbzaWthGUqBe4czCn9iXtq`; time_offset = 0.
  => **Unlocked/deposited-only MNDE = 0 voting power.** weight = amount * min(lockup_remaining/31d, 1) (cliff). See VSR source for linear-vesting kinds.
- Account type numbers (spl-governance JS): RealmConfig 11, VoteRecordV2 12, ProposalTransactionV2 13, ProposalV2 14, TokenOwnerRecordV2 17, GovernanceV2 18, ProgramGovernanceV2 19, SignatoryRecordV2 22, ProposalDeposit 23.
- Marinade has 8 GovernanceV2 + 9 ProgramGovernanceV2, 277 proposals, 18112 TokenOwnerRecords.

## Sept-25-2026 attack proposals (both state=Vetoed, created 2026-09-25 ~16:57 UTC by TOR HPUCNc...; owner wallet 71wywhb8...)
1. `7pYWFt7aigkEU86nbxKM182t6xgVBz9ZaJ1gFzaYN1Zj` "MIP-23: VSR program security and maintenance upgrade"; description: "Routine security hardening and maintenance upgrade of the voter-stake-registry program. No parameter changes."
   - 1 tx, holdUp=0: BPFLoaderUpgradeable `Upgrade` (data 03000000) on program VoteMBh... (the VSR voter-weight plugin). Buffer `FoNxMcVr5rhHcbC4hZUf88RpVR5QomKK7SWT17SQ4kAv` (685,733 bytes, buffer authority = the DAO governance itself, so the existing bufferAuthorityMismatch rule would NOT fire). Spill = `EwH7cKSPmkuAjAu5t772vjfv1EPN6iAU857JKqcxTPQA`. Upgrade authority signer = governance 2w6ny74....
2. `EpKkNUv5DcKgBd26sXYKmcMU2hBoA4DmPzD8m7b1bGY9` "MIP-24: Treasury consolidation and operations"; description: "Consolidate DAO treasury token accounts and fund approved operational budgets."
   - 1 tx, holdUp=0, 3 SPL Token `Transfer` (tag 3), authority = native treasury B56RWQ... of governance 8z6A4q...:
     a) 153,600,023.536334850 MNDE from GR1LBT... (Marinade MNDE Treasury Vault) = 100% of its balance -> 3PviPn... (MNDE ATA owned by EwH7...)
     b) 36,116,209.356539962 MNDE from G5AxzZ... = 100% of its balance -> 3PviPn...
     c) 29.832233349 mSOL from iitf4P... = 100% of its balance -> Dwsugb... (mSOL ATA owned by EwH7...)
   - Destination owner EwH7... is the same address as the MIP-23 spill account. Destination ATA 3PviPn... first seen 2026-09-25 10:38 UTC; EwH7 wallet first activity seen >= 2026-09-25 (RPC limit 50 sigs, treat as lower bound).
- Votes on MIP-23: 6 YES wallets (raw weights ~3.1e11 .. 4.3e15, sum 14,500,313,842,147,860 raw), 1 legit DENY 30,654,345,000,000,000 raw, 3 council VETO (weight 1 each).
- Title collision: a LEGIT proposal "MIP-23: Full validator coverage of PSR downtime" (`Gd5CfxVQ1UYm4wToL5SVb9QhmCtcBTHo73QDnGMAmu6S`, 2026-09-10) exists. Fake reused the number.
- Follow-up fix: `CzXJQfKmd7hSstgEEYmAguN16UunRZfPkmj6yBDy8EZ5` "VSR config update" (Completed, council-approved, 2026-09-25 ~21:48): VSR `configure_voting_mint` (disc 71998decb809870f) idx 0 = the registrar values above. Pre-attack values NOT yet known.
- Benign test candidates: `CrbL16mpZRFJwKqkMsnVjHRP44n422opfQ1pGRL6zGoz` (USDC Vault allocator update, 2026-09-22), `Gd5CfxVQ...` (legit MIP-23 PSR), plus older Completed ones.

## RPC notes
- Public mainnet RPC works for getAccountInfo and per-governance getProgramAccounts with memcmp filters but returns 429s; needs a Helius key for comfortable work.
- spl-governance JS `getGovernanceAccounts(..., Governance, ...)` throws "account is not supported" on this realm; use raw getProgramAccounts + `GovernanceAccountParser(Class)`.
- Scratch scripts live in the Claude scratchpad (outside repo).

## Phase 0 UI finding (2026-10-05)
- Public RPC `api.mainnet-beta.solana.com` returns **403 "Access forbidden" to any request with a browser `Origin` header** (works from Node). So the UI cannot run on the public RPC from a browser. Use a Helius key (`NEXT_PUBLIC_MAINNET_RPC`) or the local proxy `scripts/rpc-proxy.js` (strips Origin, retries 429, can record/replay for the offline demo).
- Existing warnings vs. attack (from code in ProposalWarnings.tsx): MIP-23 BPF Upgrade -> only generic yellow "programUpgrade"; MIP-24 3 treasury transfers -> NO warning (treasury is in accounts so possibleWrongGovernance doesn't fire).

## Phase 1 architecture (decided 2026-10-05)
Owner/folder map (parallel agents; each touches only its folders + listed files):
- **Safety engine (P3)**: `tools/proposalSafety/` (pure TS, no React, no RPC in `analyze.ts`), RPC loader `tools/proposalSafety/load.ts`, snapshot script `scripts/snapshot/`, fixtures `fixtures/marinade/`, UI `components/ProposalSafety/`, hook-in at `pages/dao/[symbol]/proposal/[pk]/index.tsx` (or ProposalWarnings.tsx). Tests `tools/proposalSafety/__tests__/`.
  Public API (other modules import ONLY this, from `tools/proposalSafety/index.ts`):
  - `analyzeProposal(input: ProposalSafetyInput): ProposalSafetyReport` (pure, deterministic)
  - `loadProposalSafetyInput(connection: Connection, proposalPk: PublicKey, opts?: {programId?: PublicKey}): Promise<ProposalSafetyInput>`
  - `ProposalSafetyReport = { actions: DecodedAction[]; findings: SafetyFinding[]; maxSeverity: 'red'|'yellow'|'info'|'none' }`, `SafetyFinding = { id: string; severity: 'red'|'yellow'|'info'; title: string; explanation: string; instructionIndex?: number }`
- **VSR voting power (P2, P5)**: `tools/vsr/` (pure math + loader), fixtures `fixtures/marinade/vsr/`, UI in `VoteStakeRegistry/components/` and `components/VotingPowerCard*`. Tests `tools/vsr/__tests__/`.
- **Telegram bot (P4)**: `bots/telegram/` (standalone Node, run with ts-node; Node 22 global fetch; state in `bots/telegram/data/` (gitignored)). Token only from `.env` `TELEGRAM_BOT_TOKEN`.
- **Build/demo infra**: `scripts/rpc-proxy.js` (record/replay), `package.json` scripts, `.env.sample`, app shell banners (`components/` layout, TermsPopup), `README-DEMO.md`.
Rules for all: no new npm deps without asking the lead (yarn.lock churn, slow installs); `git add` only your own paths, commit with a clear message, retry if `index.lock` exists; never commit `.env`; Windows + PowerShell instructions in docs.
Dev: Node 22, `yarn install --frozen-lockfile --ignore-engines --ignore-scripts`; jest works: `npx jest <path>` (~30 s startup). `next dev` first compile ~4 min (Babel, .babelrc).
