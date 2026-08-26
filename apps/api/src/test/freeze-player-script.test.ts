import { describe, it, expect } from 'vitest'
import { parseArgs, resolveUser, type UserLookupClient } from '../lib/freeze-player-args'

describe('freeze-player script: parseArgs', () => {
  it('parses a valid freeze command with a single-word reason', () => {
    expect(parseArgs(['freeze', 'u1', 'fraud'])).toEqual({
      action: 'freeze',
      identifier: 'u1',
      reason: 'fraud',
    })
  })

  it('parses a valid unfreeze command and joins a multi-word reason', () => {
    expect(parseArgs(['unfreeze', '+251911223344', 'cleared', 'by', 'fraud', 'team'])).toEqual({
      action: 'unfreeze',
      identifier: '+251911223344',
      reason: 'cleared by fraud team',
    })
  })

  it('throws when no arguments are given', () => {
    expect(() => parseArgs([])).toThrow(/freeze.*unfreeze/i)
  })

  it('throws on an invalid action', () => {
    expect(() => parseArgs(['delete', 'u1', 'because'])).toThrow(/freeze.*unfreeze/i)
  })

  it('throws when the identifier is missing', () => {
    expect(() => parseArgs(['freeze'])).toThrow(/identifier/i)
  })

  it('throws when the reason is missing', () => {
    expect(() => parseArgs(['freeze', 'u1'])).toThrow(/reason/i)
  })

  it('throws when the reason is only whitespace', () => {
    expect(() => parseArgs(['freeze', 'u1', '   '])).toThrow(/reason/i)
  })
})

describe('freeze-player script: resolveUser', () => {
  const makeClient = (result: unknown): UserLookupClient => ({
    user: { findFirst: async () => result as never },
  })

  it('looks up the user by id, username, or phone in a single OR query', async () => {
    let capturedArgs: unknown
    const client: UserLookupClient = {
      user: {
        findFirst: async (args: unknown) => {
          capturedArgs = args
          return { id: 'u1', username: 'bob', phone: null, serial: 42, isActive: true }
        },
      },
    }

    const user = await resolveUser(client, 'bob')

    expect(user).toEqual({ id: 'u1', username: 'bob', phone: null, serial: 42, isActive: true })
    expect(capturedArgs).toEqual({
      where: { OR: [{ id: 'bob' }, { username: 'bob' }, { phone: 'bob' }] },
      select: { id: true, username: true, phone: true, serial: true, isActive: true },
    })
  })

  it('returns null (does not throw) when no user matches', async () => {
    const client = makeClient(null)
    await expect(resolveUser(client, 'nobody-1234')).resolves.toBeNull()
  })
})
