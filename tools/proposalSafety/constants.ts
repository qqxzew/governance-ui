// Program ids and labels used by the safety engine.
// Every id here is either a Solana built-in or checked against this repo
// (components/instructions/programs/names.ts, constants/plugins.ts) or the
// Marinade facts in CLAUDE.md. Do not add ids you have not verified.

export const SYSTEM_PROGRAM = '11111111111111111111111111111111'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'

/** spl-governance deployments known to this repo (components/instructions/programs/names.ts) */
export const GOVERNANCE_PROGRAMS: Record<string, string> = {
  GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw: 'SPL Governance',
  GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs: 'Marinade Governance (spl-governance)',
  GovHgfDPyQ1GwazJTDY2avSVY8GGcpmCapmmCsymRaGe: 'PSY DO Governance (spl-governance)',
  hgovkRU6Ghe1Qoyb54HdSLdqN7VtxaifBzRmh9jtd3S: 'Helium Governance (spl-governance)',
}

/** Voter-stake-registry deployments whose configure_voting_mint layout we decode (constants/plugins.ts VSR_PLUGIN_PKS) */
export const VSR_PROGRAMS: Record<string, string> = {
  VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS: 'Marinade Voter Stake Registry (VSR)',
  vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGbsTPXqQ: 'Voter Stake Registry (VSR)',
  VotEn9AWwTFtJPJSMV5F9jsMY6QwWM5qn3XP9PATGW7: 'Voter Stake Registry (VSR)',
}

/** sha256("global:configure_voting_mint")[0..8] — verified against CzXJQf… on chain */
export const VSR_CONFIGURE_VOTING_MINT_DISC = '71998decb809870f'

export const PROGRAM_NAMES: Record<string, string> = {
  [SYSTEM_PROGRAM]: 'System Program',
  [TOKEN_PROGRAM]: 'SPL Token Program',
  [TOKEN_2022_PROGRAM]: 'SPL Token-2022 Program',
  [ATA_PROGRAM]: 'Associated Token Account Program',
  [BPF_UPGRADEABLE_LOADER]: 'BPF Upgradeable Loader (program deployments)',
  [MEMO_PROGRAM]: 'Memo Program',
  [MEMO_PROGRAM_V1]: 'Memo Program (v1)',
  [COMPUTE_BUDGET_PROGRAM]: 'Compute Budget Program',
  ...GOVERNANCE_PROGRAMS,
  ...VSR_PROGRAMS,
}

/** Mint labels (symbol only; decimals always come from chain) */
export const KNOWN_MINT_SYMBOLS: Record<string, string> = {
  MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey: 'MNDE',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'wSOL',
}

export const ENGINE_VERSION = 'proposalSafety/0.1.0 (unaudited, evaluation-grade)'
