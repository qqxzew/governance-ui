/**
 * Simulate-before-sign for VSR deposit / lock transactions.
 *
 * We simulate the exact instructions the user is about to sign (sigVerify=false, replaceRecentBlockhash=true),
 * plus one extra read-only VSR `log_voter_info(0, 0)` instruction appended to the SIMULATED copy only, so the
 * program itself tells us the voter's voting power right after the transaction (VoterInfo event).
 * The extra instruction is never part of what gets signed or sent.
 */
import BN from 'bn.js'
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

/** sha256("global:log_voter_info")[0..8] — instructions/log_voter_info.rs, args (deposit_entry_begin u8, deposit_entry_count u8) */
const LOG_VOTER_INFO_IX = Buffer.from([171, 72, 233, 90, 143, 151, 113, 51])
/** sha256("event:VoterInfo")[0..8] — events/mod.rs `VoterInfo { voting_power: u64, voting_power_baseline: u64 }` */
const VOTER_INFO_EVENT = Buffer.from([95, 159, 197, 100, 178, 17, 75, 128])

export function logVoterInfoInstruction(
  vsrProgramId: PublicKey,
  registrar: PublicKey,
  voter: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: vsrProgramId,
    keys: [
      { pubkey: registrar, isSigner: false, isWritable: false },
      { pubkey: voter, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([LOG_VOTER_INFO_IX, Buffer.from([0, 0])]),
  })
}

/** Extract the first VoterInfo event from transaction logs ("Program data: <base64>"). */
export function parseVoterInfoFromLogs(
  logs: string[],
): { votingPower: BN; votingPowerBaseline: BN } | null {
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue
    const b = Buffer.from(l.slice('Program data: '.length), 'base64')
    if (b.length >= 24 && b.subarray(0, 8).equals(VOTER_INFO_EVENT)) {
      return {
        votingPower: new BN(b.subarray(8, 16), 'le'),
        votingPowerBaseline: new BN(b.subarray(16, 24), 'le'),
      }
    }
  }
  return null
}

export interface VsrSimulationResult {
  ok: boolean
  /** program error / simulation error, human readable */
  error: string | null
  /** voter weight the VSR program reports right after the simulated transaction (null if unavailable) */
  votingPowerAfter: BN | null
  unitsConsumed: number | null
  /** last few relevant log lines, for display */
  logSummary: string[]
}

export function summarizeLogs(logs: string[], max = 6): string[] {
  const interesting = logs.filter(
    (l) =>
      /failed|error|insufficient|custom program error/i.test(l) ||
      l.startsWith('Program log: Instruction:') ||
      l.startsWith('Program log: AnchorError'),
  )
  return interesting.slice(-max)
}

export async function simulateVsrTransaction({
  connection,
  payer,
  instructions,
  vsrProgramId,
  registrar,
  voter,
}: {
  connection: Connection
  payer: PublicKey
  instructions: TransactionInstruction[]
  vsrProgramId: PublicKey
  registrar: PublicKey
  voter: PublicKey
}): Promise<VsrSimulationResult> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...instructions, logVoterInfoInstruction(vsrProgramId, registrar, voter)],
  }).compileToV0Message()
  const sim = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  })
  const logs = sim.value.logs ?? []
  const info = parseVoterInfoFromLogs(logs)
  const err = sim.value.err
  return {
    ok: !err,
    error: err ? (typeof err === 'string' ? err : JSON.stringify(err)) : null,
    votingPowerAfter: info ? info.votingPower : null,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logSummary: summarizeLogs(logs),
  }
}
