/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node", "node-addons"]}
 */
/**
 * Render test for the VSR voting power card using a real Marinade voter snapshot
 * (fixtures/marinade/vsr, voter with locked Cliff/Constant/Monthly deposits AND unlocked MNDE).
 */
import React from 'react'
import fs from 'fs'
import path from 'path'
import BN from 'bn.js'
import { render, screen } from '@testing-library/react'
import { PublicKey } from '@solana/web3.js'
import {
  decodeRegistrar,
  decodeVoter,
  summarizeVoter,
} from '@tools/vsr/votingPower'

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      '../../../fixtures/marinade/vsr/voter-5YPXqHUZujEV7UYUJ1edE2eURAuXu1VTj76S2sipcjzC.json',
    ),
    'utf8',
  ),
)
const registrar = decodeRegistrar(
  Buffer.from(fixture.accounts.registrarDataBase64, 'base64'),
)
const voter = decodeVoter(
  Buffer.from(fixture.accounts.voterDataBase64, 'base64'),
)
const ts = new BN(fixture.clock.unixTimestamp)
const summary = summarizeVoter(voter, registrar, ts)
const authority = new PublicKey(fixture.voterAuthority)

jest.mock('@hooks/queries/realm', () => ({
  useRealmQuery: () => ({
    data: {
      result: {
        pubkey: registrar.realm,
        account: { communityMint: registrar.realmGoverningTokenMint },
      },
    },
  }),
}))
jest.mock('@hooks/queries/mintInfo', () => ({
  useRealmCommunityMintInfoQuery: () => ({ data: { result: { decimals: 9 } } }),
}))
jest.mock('@hooks/useRealm', () => () => ({ realmInfo: { symbol: 'MNDE' } }))
jest.mock('@hooks/useUserOrDelegator', () => () => authority)
jest.mock('@hooks/useWalletOnePointOh', () => () => ({ publicKey: authority }))
jest.mock('@components/instructions/programs/splToken', () => ({
  getMintMetadata: () => undefined,
}))
jest.mock(
  'VoteStakeRegistry/components/Account/LockTokensModal',
  () => () => null,
)
jest.mock('../useVsrVoterState', () => ({
  useVsrProgramId: () => new PublicKey(fixture.vsrProgramId),
  useVsrVoterState: () => ({
    isLoading: false,
    error: null,
    data: {
      registrar,
      voter,
      clockUnixTimestamp: ts,
      slot: Number(fixture.clock.slot),
      summary,
    },
  }),
}))

// eslint-disable-next-line import/first
import VotingPowerCard, { fmtNative } from '../index'

describe('VotingPowerCard', () => {
  it('shows program-exact voting power, lockups, decay rule and the unlocked warning', () => {
    render(<VotingPowerCard walletTokenAmount={new BN('5000000000')} />)
    // voting power equals the program-computed VoterWeightRecord weight
    expect(
      screen.getByText(
        fmtNative(new BN(fixture.expected.voterWeightRecordWeight), 9),
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        "Your voting power = locked MNDE × min(remaining lockup / 31 days, 1); it shrinks as your lockup runs out unless it's a constant lockup.",
      ),
    ).toBeTruthy()
    const unlocked = summary.unlockedNative
    expect(unlocked.gtn(0)).toBe(true)
    expect(
      screen.getByText(
        `${fmtNative(
          unlocked,
          9,
        )} MNDE deposited but NOT locked — this gives 0 voting power. Lock it to vote.`,
      ),
    ).toBeTruthy()
    expect(screen.getAllByText(/Constant/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Cliff/).length).toBeGreaterThan(0)
    expect(screen.getByText('Lock tokens')).toBeTruthy()
    expect(screen.getByText(/You also hold 5 MNDE in your/)).toBeTruthy()
  })
})
