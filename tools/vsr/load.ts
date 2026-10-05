/**
 * RPC loader for the VSR voting power card: fetches Registrar, Voter and the Clock sysvar in ONE
 * getMultipleAccountsInfo call (same slot), decodes them and runs the verified math from votingPower.ts.
 */
import BN from 'bn.js'
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import {
  decodeRegistrar,
  decodeVoter,
  summarizeVoter,
  VsrRegistrar,
  VsrVoter,
  VoterSummary,
} from './votingPower'

export function vsrRegistrarAddress(
  realm: PublicKey,
  communityMint: PublicKey,
  vsrProgramId: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [realm.toBuffer(), Buffer.from('registrar'), communityMint.toBuffer()],
    vsrProgramId,
  )[0]
}

export function vsrVoterAddress(
  registrar: PublicKey,
  wallet: PublicKey,
  vsrProgramId: PublicKey,
) {
  return PublicKey.findProgramAddressSync(
    [registrar.toBuffer(), Buffer.from('voter'), wallet.toBuffer()],
    vsrProgramId,
  )[0]
}

export interface VsrVoterState {
  registrarPk: PublicKey
  voterPk: PublicKey
  registrar: VsrRegistrar
  /** null when the wallet has never deposited (no Voter account) */
  voter: VsrVoter | null
  clockUnixTimestamp: BN
  slot: number
  /** null when voter is null */
  summary: VoterSummary | null
}

export async function loadVsrVoterState(
  connection: Connection,
  {
    realm,
    communityMint,
    vsrProgramId,
    wallet,
  }: {
    realm: PublicKey
    communityMint: PublicKey
    vsrProgramId: PublicKey
    wallet: PublicKey
  },
): Promise<VsrVoterState> {
  const registrarPk = vsrRegistrarAddress(realm, communityMint, vsrProgramId)
  const voterPk = vsrVoterAddress(registrarPk, wallet, vsrProgramId)
  const res = await connection.getMultipleAccountsInfoAndContext([
    registrarPk,
    voterPk,
    SYSVAR_CLOCK_PUBKEY,
  ])
  const [regInfo, voterInfo, clockInfo] = res.value
  if (!regInfo || !regInfo.owner.equals(vsrProgramId))
    throw new Error('VSR registrar not found')
  if (!clockInfo) throw new Error('Clock sysvar not returned')
  const registrar = decodeRegistrar(Buffer.from(regInfo.data))
  // Clock { slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64 }
  const clockUnixTimestamp = new BN(
    Buffer.from(clockInfo.data).subarray(32, 40),
    'le',
  ).fromTwos(64)
  const voter =
    voterInfo && voterInfo.owner.equals(vsrProgramId)
      ? decodeVoter(Buffer.from(voterInfo.data))
      : null
  return {
    registrarPk,
    voterPk,
    registrar,
    voter,
    clockUnixTimestamp,
    slot: res.context.slot,
    summary: voter
      ? summarizeVoter(voter, registrar, clockUnixTimestamp)
      : null,
  }
}
