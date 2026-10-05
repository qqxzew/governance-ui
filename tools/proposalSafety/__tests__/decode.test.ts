/**
 * Decoder unit tests: every layout is cross-checked against an independent encoder
 * (spl-token 0.1.8, web3.js, spl-governance 0.3.28, anchor + repo VSR IDL, repo loader helpers).
 */
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { Token, TOKEN_PROGRAM_ID, u64 } from '@solana/spl-token'
import {
  GovernanceConfig,
  GoverningTokenConfigAccountArgs,
  GoverningTokenType,
  MintMaxVoteWeightSource,
  SetRealmAuthorityAction,
  VoteThreshold,
  VoteThresholdType,
  VoteTipping,
  createSetGovernanceConfig,
  withSetRealmAuthority,
  withSetRealmConfig,
} from '@solana/spl-governance'
import { BN, BorshInstructionCoder } from '@coral-xyz/anchor'
import { IDL as VSR_IDL } from '../../../VoteStakeRegistry/sdk/voter_stake_registry'
import { createSetUpgradeAuthority } from '../../sdk/bpfUpgradeableLoader/createSetUpgradeAuthority'
import { createCloseBuffer } from '../../sdk/bpfUpgradeableLoader/createCloseBuffer'
import { decodeInstruction, Decoded } from '../decode'

const GOV = new PublicKey('GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs')
const VSR = new PublicKey('VoteMBhDCqGLRgYpp9o7DGyq81KNmwjXQRAHStjtJsS')
const ctx = {
  governanceProgramIds: new Set([GOV.toBase58()]),
  vsrProgramIds: new Set([VSR.toBase58()]),
}
const k = () => Keypair.generate().publicKey

function dec(ix: TransactionInstruction): Decoded {
  return decodeInstruction(
    ix.programId.toBase58(),
    ix.keys.map((a) => ({ pubkey: a.pubkey.toBase58(), isSigner: a.isSigner, isWritable: a.isWritable })),
    Buffer.from(ix.data),
    ctx,
  )
}

describe('SPL Token decoders', () => {
  const [src, dst, owner, mint, delegate, newAuth] = [k(), k(), k(), k(), k(), k()]

  it('Transfer (3)', () => {
    const d = dec(Token.createTransferInstruction(TOKEN_PROGRAM_ID, src, dst, owner, [], new u64('153600023536334850')))
    expect(d).toMatchObject({ type: 'token-transfer', checked: false, source: src.toBase58(), destination: dst.toBase58(), authority: owner.toBase58() })
    expect((d as any).amount.toString()).toBe('153600023536334850')
  })

  it('TransferChecked (12)', () => {
    const d = dec(Token.createTransferCheckedInstruction(TOKEN_PROGRAM_ID, src, mint, dst, owner, [], new u64(5000), 9))
    expect(d).toMatchObject({ type: 'token-transfer', checked: true, mint: mint.toBase58(), destination: dst.toBase58(), decimals: 9 })
    expect((d as any).amount.toString()).toBe('5000')
  })

  it('Approve (4)', () => {
    const d = dec(Token.createApproveInstruction(TOKEN_PROGRAM_ID, src, delegate, owner, [], new u64(42)))
    expect(d).toMatchObject({ type: 'token-approve', source: src.toBase58(), delegate: delegate.toBase58(), owner: owner.toBase58() })
    expect((d as any).amount.toString()).toBe('42')
  })

  it('SetAuthority (6) with and without new authority', () => {
    const d1 = dec(Token.createSetAuthorityInstruction(TOKEN_PROGRAM_ID, src, newAuth, 'AccountOwner', owner, []))
    expect(d1).toMatchObject({ type: 'token-set-authority', account: src.toBase58(), authorityType: 'AccountOwner', newAuthority: newAuth.toBase58(), currentAuthority: owner.toBase58() })
    const d2 = dec(Token.createSetAuthorityInstruction(TOKEN_PROGRAM_ID, mint, null, 'MintTokens', owner, []))
    expect(d2).toMatchObject({ type: 'token-set-authority', authorityType: 'MintTokens', newAuthority: null })
  })

  it('CloseAccount (9)', () => {
    const d = dec(Token.createCloseAccountInstruction(TOKEN_PROGRAM_ID, src, dst, owner, []))
    expect(d).toMatchObject({ type: 'token-close', account: src.toBase58(), destination: dst.toBase58(), owner: owner.toBase58() })
  })
})

describe('System decoder', () => {
  it('Transfer (2)', () => {
    const [from, to] = [k(), k()]
    const d = dec(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 123456789 }))
    expect(d).toMatchObject({ type: 'sol-transfer', from: from.toBase58(), to: to.toBase58() })
    expect((d as any).lamports.toString()).toBe('123456789')
  })
})

describe('BPF upgradeable loader decoders', () => {
  it('Upgrade (3) — MIP-23 layout', () => {
    const keys = ['C6k3BuxsDjihWAP5mVxCLWxEVMAgvifUS95u78ym2xiT', VSR.toBase58(), 'FoNxMcVr5rhHcbC4hZUf88RpVR5QomKK7SWT17SQ4kAv', 'EwH7cKSPmkuAjAu5t772vjfv1EPN6iAU857JKqcxTPQA', 'SysvarRent111111111111111111111111111111111', 'SysvarC1ock11111111111111111111111111111111', '2w6ny74cU6yRxkD6ZACh5M1JznLQ1KB6AUsB7zo2NBHX']
    const d = decodeInstruction('BPFLoaderUpgradeab1e11111111111111111111111', keys.map((pubkey, i) => ({ pubkey, isSigner: i === 6, isWritable: i < 4 })), Buffer.from('03000000', 'hex'), ctx)
    expect(d).toEqual({ type: 'bpf-upgrade', programData: keys[0], program: keys[1], buffer: keys[2], spill: keys[3], authority: keys[6] })
  })

  it('SetAuthority (4) via repo helper', async () => {
    const [prog, cur, next] = [k(), k(), k()]
    const d = dec(await createSetUpgradeAuthority(prog, cur, next))
    const pd = PublicKey.findProgramAddressSync([prog.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0]
    expect(d).toEqual({ type: 'bpf-set-authority', checked: false, target: pd.toBase58(), currentAuthority: cur.toBase58(), newAuthority: next.toBase58() })
  })

  it('SetAuthorityChecked (7) and Close (5)', async () => {
    const [t, cur, next] = [k(), k(), k()]
    const d = decodeInstruction('BPFLoaderUpgradeab1e11111111111111111111111', [t, cur, next].map((p) => ({ pubkey: p.toBase58(), isSigner: true, isWritable: true })), Buffer.from('07000000', 'hex'), ctx)
    expect(d).toMatchObject({ type: 'bpf-set-authority', checked: true, newAuthority: next.toBase58() })
    const [buf, rcv, auth] = [k(), k(), k()]
    expect(dec(await createCloseBuffer(buf, rcv, auth))).toMatchObject({ type: 'bpf-close', target: buf.toBase58(), recipient: rcv.toBase58(), authority: auth.toBase58() })
  })
})

describe('spl-governance decoders (cross-checked with SDK serializers)', () => {
  const governance = k()
  const realm = k()
  const authority = k()

  it('SetGovernanceConfig (19), V3 layout', () => {
    const cfg = new GovernanceConfig({
      communityVoteThreshold: new VoteThreshold({ type: VoteThresholdType.YesVotePercentage, value: 60 }),
      minCommunityTokensToCreateProposal: new BN('1000000000000'),
      minInstructionHoldUpTime: 86400,
      baseVotingTime: 3 * 86400,
      communityVoteTipping: VoteTipping.Disabled,
      councilVoteThreshold: new VoteThreshold({ type: VoteThresholdType.YesVotePercentage, value: 50 }),
      councilVetoVoteThreshold: new VoteThreshold({ type: VoteThresholdType.Disabled, value: undefined }),
      minCouncilTokensToCreateProposal: new BN(1),
      councilVoteTipping: VoteTipping.Early,
      communityVetoVoteThreshold: new VoteThreshold({ type: VoteThresholdType.Disabled, value: undefined }),
      votingCoolOffTime: 43200,
      depositExemptProposalCount: 10,
    })
    const ix = createSetGovernanceConfig(GOV, 3, governance, cfg)
    expect(ix.data[0]).toBe(19)
    const d = dec(ix)
    expect(d.type).toBe('gov-set-governance-config')
    if (d.type !== 'gov-set-governance-config') return
    expect(d.governance).toBe(governance.toBase58())
    expect(d.config).toEqual({
      communityVoteThreshold: { type: 'YesVotePercentage', value: 60 },
      minCommunityTokensToCreateProposal: '1000000000000',
      minInstructionHoldUpTime: 86400,
      baseVotingTime: 259200,
      communityVoteTipping: 'Disabled',
      councilVoteThreshold: { type: 'YesVotePercentage', value: 50 },
      councilVetoVoteThreshold: { type: 'Disabled' },
      minCouncilTokensToCreateProposal: '1',
      councilVoteTipping: 'Early',
      communityVetoVoteThreshold: { type: 'Disabled' },
      votingCoolOffTime: 43200,
      depositExemptProposalCount: 10,
    })
  })

  it('SetRealmConfig (22), V3 layout with community + council plugins', async () => {
    const council = k()
    const [cAddin, cMax, kAddin] = [k(), k(), k()]
    const ixs: TransactionInstruction[] = []
    await withSetRealmConfig(
      ixs, GOV, 3, realm, authority, council,
      new MintMaxVoteWeightSource({ type: 0, value: new BN('10000000000') }),
      new BN(123),
      new GoverningTokenConfigAccountArgs({ voterWeightAddin: cAddin, maxVoterWeightAddin: cMax, tokenType: GoverningTokenType.Liquid }),
      new GoverningTokenConfigAccountArgs({ voterWeightAddin: kAddin, maxVoterWeightAddin: undefined, tokenType: GoverningTokenType.Membership }),
      authority,
    )
    expect(ixs[0].data[0]).toBe(22)
    const d = dec(ixs[0])
    expect(d).toMatchObject({
      type: 'gov-set-realm-config',
      realm: realm.toBase58(),
      realmAuthority: authority.toBase58(),
      useCouncilMint: true,
      councilMint: council.toBase58(),
      layoutVersion: 3,
      maxVoteWeightSource: { type: 'SupplyFraction' },
      community: { useVoterWeightAddin: true, useMaxVoterWeightAddin: true, tokenType: 'Liquid', voterWeightAddin: cAddin.toBase58(), maxVoterWeightAddin: cMax.toBase58() },
      council: { useVoterWeightAddin: true, useMaxVoterWeightAddin: false, tokenType: 'Membership', voterWeightAddin: kAddin.toBase58(), maxVoterWeightAddin: null },
    })
    expect((d as any).minCommunityTokensToCreateGovernance.toString()).toBe('123')
  })

  it('SetRealmConfig (22) removing the plugin and the council', async () => {
    const ixs: TransactionInstruction[] = []
    await withSetRealmConfig(ixs, GOV, 3, realm, authority, undefined,
      new MintMaxVoteWeightSource({ type: 0, value: new BN('10000000000') }), new BN(1),
      new GoverningTokenConfigAccountArgs({ voterWeightAddin: undefined, maxVoterWeightAddin: undefined, tokenType: GoverningTokenType.Liquid }),
      undefined, undefined)
    expect(dec(ixs[0])).toMatchObject({ useCouncilMint: false, councilMint: null, community: { useVoterWeightAddin: false, voterWeightAddin: null } })
  })

  it('SetRealmAuthority (21), V2+ layout', () => {
    const ixs: TransactionInstruction[] = []
    const next = k()
    withSetRealmAuthority(ixs, GOV, 3, realm, authority, next, SetRealmAuthorityAction.SetChecked)
    expect(dec(ixs[0])).toEqual({ type: 'gov-set-realm-authority', realm: realm.toBase58(), realmAuthority: authority.toBase58(), action: 'SetChecked', newAuthority: next.toBase58() })
    const ixs2: TransactionInstruction[] = []
    withSetRealmAuthority(ixs2, GOV, 3, realm, authority, undefined as any, SetRealmAuthorityAction.Remove)
    // the SDK pushes an undefined 3rd key for Remove; on chain Remove carries only [realm, authority]
    ixs2[0].keys = ixs2[0].keys.filter((x) => x.pubkey)
    expect(dec(ixs2[0])).toMatchObject({ action: 'Remove', newAuthority: null })
  })
})

describe('VSR configure_voting_mint', () => {
  it('decodes the on-chain CzXJQf… instruction', () => {
    const data = Buffer.from('71998decb809870f000000000000000000000000ca9a3b0000000080de2800000000000176a1beaf55241d8aece18d3f6988fe69281fe07e00f0bf71c5f6bc30bbd86c3e', 'hex')
    const accts = ['5zgEgPbWKsAAnLPjSM56ZsbLPfVM6nUzh3u45tCnm97D', 'FsrqQfLGdFVtySSSsyZJUzVBA9bvGZSKyhp7nsJCqgJe', 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey']
    const d = decodeInstruction(VSR.toBase58(), accts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data, ctx)
    expect(d).toMatchObject({ type: 'vsr-configure-voting-mint', registrar: accts[0], realmAuthority: accts[1], mint: accts[2], idx: 0, digitShift: 0, grantAuthority: '8z6A4qSfL9FFvwX12zqt6HrbzaWthGUqBe4czCn9iXtq' })
    if (d.type !== 'vsr-configure-voting-mint') return
    expect(d.baselineVoteWeightScaledFactor.toString()).toBe('0')
    expect(d.maxExtraLockupVoteWeightScaledFactor.toString()).toBe('1000000000')
    expect(d.lockupSaturationSecs.toString()).toBe('2678400')
  })

  it('matches the anchor encoder for the repo IDL', () => {
    const grant = k()
    const data = new BorshInstructionCoder(VSR_IDL as any).encode('configureVotingMint', {
      idx: 2, digitShift: -3, baselineVoteWeightScaledFactor: new BN(7), maxExtraLockupVoteWeightScaledFactor: new BN(8),
      lockupSaturationSecs: new BN(9), grantAuthority: grant,
    })
    const d = decodeInstruction(VSR.toBase58(), [k(), k(), k()].map((p) => ({ pubkey: p.toBase58(), isSigner: false, isWritable: false })), data, ctx)
    expect(d).toMatchObject({ type: 'vsr-configure-voting-mint', idx: 2, digitShift: -3, grantAuthority: grant.toBase58() })
    if (d.type !== 'vsr-configure-voting-mint') return
    expect([d.baselineVoteWeightScaledFactor, d.maxExtraLockupVoteWeightScaledFactor, d.lockupSaturationSecs].map(String)).toEqual(['7', '8', '9'])
  })
})

describe('unknown programs are never silent', () => {
  it('returns unknown', () => {
    const d = decodeInstruction(k().toBase58(), [], Buffer.from([1, 2, 3]), ctx)
    expect(d.type).toBe('unknown')
  })
})
