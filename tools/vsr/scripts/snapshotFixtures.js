/* eslint-disable */
// Snapshot Marinade VSR voters + program-computed ground truth into fixtures/marinade/vsr/.
//
// Ground truth = what the deployed VSR program itself computes. For each voter we simulate ONE
// transaction (sigVerify=false, replaceRecentBlockhash=true) containing:
//   1. ComputeBudget setComputeUnitLimit(1_400_000)
//   2. VSR log_voter_info(b, 8) for b=0,8,16,24 -> emits VoterInfo / DepositEntryInfo events ("Program data:")
//   3. VSR update_voter_weight_record()     -> writes VoterWeightRecord.voter_weight (+ expiry = Clock.slot)
// and ask simulateTransaction to return the post-simulation state of
//   [voter, registrar, voter_weight_record, SysvarClock] from the SAME bank,
// so the input data, the clock and the program's result are all consistent.
//
// Usage (PowerShell, from repo root):
//   $env:RPC="http://localhost:8898"; node tools/vsr/scripts/snapshotFixtures.js <voterPk> [...]
// Not product code; read-only (simulation only, nothing is signed or sent).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} = require('@solana/web3.js')

const RPC = process.env.RPC || 'http://localhost:8898'
const VSR = new PublicKey('VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS')
const REGISTRAR = new PublicKey('5zgEgPbWKsAAnLPjSM56ZsbLPfVM6nUzh3u45tCnm97D')
const CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const SYSTEM = new PublicKey('11111111111111111111111111111111')
// Any funded mainnet account works as fee payer for a sigVerify=false simulation
// (same one the UI uses: tools/constants.ts SIMULATION_WALLET).
const FEE_PAYER = new PublicKey('ENmcpFCpxN1CqyUjuog9yyUVfdXBKF3LVCwLr7grJZpk')
const OUT = path.join(__dirname, '..', '..', '..', 'fixtures', 'marinade', 'vsr')

const sighash = (n) =>
  crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8)
const evdisc = (n) =>
  crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8).toString('hex')

async function rpc(method, params) {
  for (let i = 0; i < 12; i++) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (r.status === 429) {
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)))
      continue
    }
    const j = await r.json()
    if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error))
    return j.result
  }
  throw new Error('too many 429s')
}

async function snapshot(voterPk) {
  const voterInfo = await rpc('getAccountInfo', [voterPk.toBase58(), { encoding: 'base64' }])
  const vdata = Buffer.from(voterInfo.value.data[0], 'base64')
  const authority = new PublicKey(vdata.subarray(8, 40))
  const [vwr] = PublicKey.findProgramAddressSync(
    [REGISTRAR.toBuffer(), Buffer.from('voter-weight-record'), authority.toBuffer()],
    VSR,
  )
  const [voterPda] = PublicKey.findProgramAddressSync(
    [REGISTRAR.toBuffer(), Buffer.from('voter'), authority.toBuffer()],
    VSR,
  )
  if (!voterPda.equals(voterPk)) throw new Error('voter PDA mismatch for ' + voterPk.toBase58())

  const tx = new Transaction({ feePayer: FEE_PAYER, recentBlockhash: SYSTEM.toBase58() })
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
  // log_voter_info in 4 instructions of 8 entries each: logging all 32 in one ix runs out of the 32KiB heap.
  for (let begin = 0; begin < 32; begin += 8)
    tx.add(
      new TransactionInstruction({
        programId: VSR,
        keys: [
          { pubkey: REGISTRAR, isSigner: false, isWritable: false },
          { pubkey: voterPk, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([sighash('log_voter_info'), Buffer.from([begin, 8])]),
      }),
    )
  tx.add(
    new TransactionInstruction({
      programId: VSR,
      keys: [
        { pubkey: REGISTRAR, isSigner: false, isWritable: false },
        { pubkey: voterPk, isSigner: false, isWritable: false },
        { pubkey: vwr, isSigner: false, isWritable: true },
        { pubkey: SYSTEM, isSigner: false, isWritable: false },
      ],
      data: sighash('update_voter_weight_record'),
    }),
  )
  const wire = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64')
  const addrs = [voterPk, REGISTRAR, vwr, CLOCK].map((p) => p.toBase58())
  const sim = await rpc('simulateTransaction', [
    wire,
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: addrs },
    },
  ])
  const v = sim.value
  if (v.err)
    throw new Error('simulation failed: ' + JSON.stringify(v.err) + '\n' + (v.logs || []).join('\n'))
  const [simVoter, simRegistrar, simVwr, simClock] = v.accounts.map((a) =>
    Buffer.from(a.data[0], 'base64'),
  )
  // solana_program::clock::Clock { slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64 }
  const clock = {
    slot: simClock.readBigUInt64LE(0).toString(),
    epochStartTimestamp: simClock.readBigInt64LE(8).toString(),
    epoch: simClock.readBigUInt64LE(16).toString(),
    leaderScheduleEpoch: simClock.readBigUInt64LE(24).toString(),
    unixTimestamp: simClock.readBigInt64LE(32).toString(),
  }
  // spl_governance_addin_api::voter_weight::VoterWeightRecord:
  //   disc[8] realm[32] mint[32] owner[32] voter_weight u64 @104, voter_weight_expiry Option<u64> @112
  const vwrWeight = simVwr.readBigUInt64LE(104).toString()
  const vwrExpiry = simVwr[112] === 1 ? simVwr.readBigUInt64LE(113).toString() : null
  // anchor events: "Program data: <base64(disc8 + borsh)>"
  const VOTER_INFO = evdisc('VoterInfo')
  const DEPOSIT_INFO = evdisc('DepositEntryInfo')
  let eventVoterInfo = null
  const eventDeposits = []
  for (const l of v.logs || []) {
    if (!l.startsWith('Program data: ')) continue
    const b = Buffer.from(l.slice('Program data: '.length), 'base64')
    const d = b.subarray(0, 8).toString('hex')
    if (d === VOTER_INFO && !eventVoterInfo)
      eventVoterInfo = {
        votingPower: b.readBigUInt64LE(8).toString(),
        votingPowerBaseline: b.readBigUInt64LE(16).toString(),
      }
    if (d === DEPOSIT_INFO)
      eventDeposits.push({
        depositEntryIndex: b[8],
        votingMintConfigIndex: b[9],
        unlocked: b.readBigUInt64LE(10).toString(),
        votingPower: b.readBigUInt64LE(18).toString(),
        votingPowerBaseline: b.readBigUInt64LE(26).toString(),
      })
  }
  const fixture = {
    _comment:
      'Generated by tools/vsr/scripts/snapshotFixtures.js. Account data, clock and expected values all come from ONE simulateTransaction (same bank/slot). expected.* = values computed by the deployed VSR program.',
    cluster: 'mainnet-beta',
    vsrProgramId: VSR.toBase58(),
    simulatedAt: new Date().toISOString(),
    contextSlot: sim.context.slot,
    voter: voterPk.toBase58(),
    voterAuthority: authority.toBase58(),
    registrar: REGISTRAR.toBase58(),
    voterWeightRecord: vwr.toBase58(),
    clock,
    accounts: {
      voterDataBase64: simVoter.toString('base64'),
      registrarDataBase64: simRegistrar.toString('base64'),
    },
    expected: {
      voterWeightRecordWeight: vwrWeight,
      voterWeightRecordExpirySlot: vwrExpiry,
      logVoterInfo: eventVoterInfo,
      logDepositEntryInfo: eventDeposits,
    },
    unitsConsumed: v.unitsConsumed,
  }
  if (eventVoterInfo && eventVoterInfo.votingPower !== vwrWeight)
    throw new Error('log_voter_info vs VoterWeightRecord mismatch')
  if (vwrExpiry !== clock.slot)
    throw new Error('VWR expiry slot != Clock.slot in returned sysvar: ' + vwrExpiry + ' vs ' + clock.slot)
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `voter-${voterPk.toBase58()}.json`)
  fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n')
  console.log(
    voterPk.toBase58(),
    'weight',
    vwrWeight,
    'ts',
    clock.unixTimestamp,
    'slot',
    clock.slot,
    'deposits',
    eventDeposits.length,
    'CU',
    v.unitsConsumed,
  )
}

;(async () => {
  const pks = process.argv.slice(2)
  if (!pks.length) throw new Error('usage: node snapshotFixtures.js <voterPk>...')
  for (const p of pks) await snapshot(new PublicKey(p))
})().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
