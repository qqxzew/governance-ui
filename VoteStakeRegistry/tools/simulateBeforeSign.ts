import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { notify } from '@utils/notifications'
import { fmtMintAmount } from '@tools/sdk/units'
import { tryGetMint } from '@utils/tokens'
import { getRegistrarPDA, getVoterPDA } from 'VoteStakeRegistry/sdk/accounts'
import { simulateVsrTransaction } from '@tools/vsr/simulate'

/**
 * Simulate a VSR deposit/lock transaction BEFORE asking the wallet to sign it.
 * - failure: throws (nothing is signed), with the program error + a short log summary
 * - success: shows the voting power the VSR program reports right after the transaction
 */
export async function simulateVsrBeforeSign({
  connection,
  walletPk,
  instructions,
  vsrProgramId,
  realmPk,
  communityMintPk,
}: {
  connection: Connection
  walletPk: PublicKey
  instructions: TransactionInstruction[]
  vsrProgramId: PublicKey
  realmPk: PublicKey
  communityMintPk: PublicKey
}) {
  const { registrar } = getRegistrarPDA(realmPk, communityMintPk, vsrProgramId)
  const { voter } = getVoterPDA(registrar, walletPk, vsrProgramId)
  let result: Awaited<ReturnType<typeof simulateVsrTransaction>>
  try {
    result = await simulateVsrTransaction({
      connection,
      payer: walletPk,
      instructions,
      vsrProgramId,
      registrar,
      voter,
    })
  } catch (e) {
    // RPC problem (not a program failure): do not block the user, but say so.
    notify({
      type: 'warn',
      message: 'Could not simulate this transaction before signing',
      description: `${e}`,
    })
    return
  }
  if (!result.ok) {
    const description = [result.error, ...result.logSummary].join('\n')
    notify({
      type: 'error',
      message: 'Simulation failed — nothing was signed',
      description,
    })
    throw new Error(`Simulation failed before signing: ${description}`)
  }
  const mint = await tryGetMint(connection, communityMintPk)
  notify({
    type: 'info',
    message: 'Simulation OK — please review and sign in your wallet',
    description:
      result.votingPowerAfter && mint
        ? `Expected voting power after this transaction: ${fmtMintAmount(
            mint.account,
            result.votingPowerAfter,
          )}`
        : undefined,
  })
}
