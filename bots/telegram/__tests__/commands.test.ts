import { handleCommand, parseCommand, HELP_TEXT, CommandContext } from '../commands'
import { UserInputError } from '../realms'
import { emptyState } from '../state'

const MARINADE = '899YG3yk4F66ZgbNWLHriZHTXSKk9e1kvsKEquW7L6Mo'
const GOV_MAI = 'GovMaiHfpVPw8BAM1mbdzgmSZYDw2tdP32J2fapoQoYs'

describe('parseCommand', () => {
  it('parses commands with and without args', () => {
    expect(parseCommand('/start')).toEqual({ command: 'start', args: '' })
    expect(parseCommand('  /watch   MNDE  ')).toEqual({ command: 'watch', args: 'MNDE' })
    expect(parseCommand('/WATCH mnde')).toEqual({ command: 'watch', args: 'mnde' })
    expect(parseCommand(`/unwatch ${MARINADE}`)).toEqual({ command: 'unwatch', args: MARINADE })
    expect(parseCommand('/watch Grape Protocol')).toEqual({ command: 'watch', args: 'Grape Protocol' })
  })

  it('handles @botname suffixes (groups)', () => {
    expect(parseCommand('/watch@MyGovBot MNDE', 'mygovbot')).toEqual({ command: 'watch', args: 'MNDE' })
    expect(parseCommand('/watch@OtherBot MNDE', 'MyGovBot')).toBeNull()
    expect(parseCommand('/list@MyGovBot', 'MyGovBot')).toEqual({ command: 'list', args: '' })
  })

  it('rejects non-commands and junk', () => {
    expect(parseCommand(undefined)).toBeNull()
    expect(parseCommand('hello')).toBeNull()
    expect(parseCommand('/')).toBeNull()
    expect(parseCommand('/wat-ch x')).toBeNull()
    expect(parseCommand('/watch' + ' x'.repeat(300))).toBeNull() // > 512 chars
  })
})

function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    state: emptyState(),
    chatId: 42,
    maxRealms: 3,
    maxWatchesPerChat: 2,
    resolve: async (raw) => {
      if (raw.toUpperCase() === 'MNDE' || raw === MARINADE) {
        return { realmPk: MARINADE, programId: GOV_MAI, symbol: 'MNDE', name: 'Marinade DAO' }
      }
      if (raw === 'BOOM') throw new Error('RPC 503 http://secret-rpc/?api-key=abc')
      throw new UserInputError(`Unknown realm symbol "${raw}".`)
    },
    ...over,
  }
}

describe('handleCommand', () => {
  it('help/start', async () => {
    const c = ctx()
    expect(await handleCommand({ command: 'start', args: '' }, c)).toBe(HELP_TEXT)
    expect(await handleCommand({ command: 'help', args: '' }, c)).toBe(HELP_TEXT)
  })

  it('watch -> list -> unwatch lifecycle', async () => {
    const c = ctx()
    const watched: string[] = []
    c.onWatched = (pk) => watched.push(pk)
    const r1 = await handleCommand({ command: 'watch', args: 'mnde' }, c)
    expect(r1).toContain('Watching Marinade DAO (MNDE)')
    expect(r1).toContain(GOV_MAI)
    expect(watched).toEqual([MARINADE])
    expect(c.state.realms[MARINADE]).toMatchObject({ programId: GOV_MAI, subscribers: [42], baselineDone: false })

    expect(await handleCommand({ command: 'watch', args: MARINADE }, c)).toContain('Already watching')

    // second chat joins the same realm: no new baseline
    const c2 = { ...c, chatId: 7 }
    await handleCommand({ command: 'watch', args: 'MNDE' }, c2)
    expect(c.state.realms[MARINADE].subscribers).toEqual([42, 7])
    expect(watched).toEqual([MARINADE])

    expect(await handleCommand({ command: 'list', args: '' }, c)).toContain(MARINADE)
    expect(await handleCommand({ command: 'unwatch', args: 'mnde' }, c)).toContain('Stopped watching')
    expect(c.state.realms[MARINADE].subscribers).toEqual([7])
    expect(await handleCommand({ command: 'unwatch', args: MARINADE }, c2)).toContain('Stopped watching')
    expect(c.state.realms[MARINADE]).toBeUndefined()
    expect(await handleCommand({ command: 'list', args: '' }, c)).toContain('not watching any realm')
  })

  it('validates input strictly and reports errors', async () => {
    const c = ctx()
    expect(await handleCommand({ command: 'watch', args: '' }, c)).toMatch(/^⚠️ Usage: \/watch/)
    expect(await handleCommand({ command: 'watch', args: '<script>' }, c)).toMatch(/^⚠️ Invalid realm/)
    expect(await handleCommand({ command: 'watch', args: '0'.repeat(40) }, c)).toMatch(/not base58/)
    expect(await handleCommand({ command: 'watch', args: 'NOPE' }, c)).toMatch(/Unknown realm symbol/)
    expect(await handleCommand({ command: 'unwatch', args: 'MNDE' }, c)).toMatch(/not watching/)
    expect(await handleCommand({ command: 'frobnicate', args: '' }, c)).toMatch(/Unknown command/)
    expect(Object.keys(c.state.realms)).toHaveLength(0)
  })

  it('does not leak internal RPC errors to users', async () => {
    const logs: string[] = []
    const c = ctx({ log: (m) => logs.push(m) })
    const r = await handleCommand({ command: 'watch', args: 'BOOM' }, c)
    expect(r).toMatch(/RPC error/)
    expect(r).not.toContain('api-key')
    expect(logs.length).toBe(1)
  })

  it('enforces per-chat and global limits', async () => {
    const realms = ['A', 'B', 'C', 'D'].map((s, i) => ({
      realmPk: `Realm${i}111111111111111111111111111111111`,
      programId: GOV_MAI,
      symbol: s,
    }))
    const resolve = async (raw: string) => realms.find((r) => r.symbol === raw)!
    const c = ctx({ resolve, maxWatchesPerChat: 2, maxRealms: 3 })
    await handleCommand({ command: 'watch', args: 'A' }, c)
    await handleCommand({ command: 'watch', args: 'B' }, c)
    expect(await handleCommand({ command: 'watch', args: 'C' }, c)).toMatch(/limit 2/)
    const other = { ...c, chatId: 99 }
    await handleCommand({ command: 'watch', args: 'C' }, other)
    expect(await handleCommand({ command: 'watch', args: 'D' }, other)).toMatch(/realm limit/)
    expect(Object.keys(c.state.realms)).toHaveLength(3)
  })
})
