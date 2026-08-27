import { describe, it, expect } from 'vitest'
import { parseArgs, resolveUser, matchedFields, type UserLookupClient, type UserLookupRow } from '../lib/freeze-player-args'

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
  const row = (overrides: Partial<UserLookupRow>): UserLookupRow => ({
    id: 'id-default',
    username: null,
    phone: null,
    serial: 1,
    accountStatus: 'ACTIVE',
    ...overrides,
  })

  it('looks up the user by id, username, or phone in a single OR query', async () => {
    let capturedArgs: unknown
    const client: UserLookupClient = {
      user: {
        findMany: async (args: unknown) => {
          capturedArgs = args
          return [row({ id: 'u1', username: 'bob', serial: 42 })]
        },
      },
    }

    const result = await resolveUser(client, 'bob')

    expect(result).toEqual({
      status: 'found',
      user: row({ id: 'u1', username: 'bob', serial: 42 }),
    })
    expect(capturedArgs).toEqual({
      where: { OR: [{ id: 'bob' }, { username: 'bob' }, { phone: 'bob' }] },
      select: { id: true, username: true, phone: true, serial: true, accountStatus: true },
    })
  })

  it('returns not_found (does not throw) when no user matches', async () => {
    const client: UserLookupClient = { user: { findMany: async () => [] } }
    await expect(resolveUser(client, 'nobody-1234')).resolves.toEqual({ status: 'not_found' })
  })

  it('returns ambiguous — WITHOUT picking one — when the identifier matches more than one row', async () => {
    // e.g. player A's phone happens to equal player B's username: both rows
    // satisfy the same OR clause, and there is nothing in the schema that
    // rules this out (username/phone are independently unique, not
    // cross-constrained). findFirst would silently return one of them.
    const matches = [
      row({ id: 'u1', username: '0911223344', serial: 1 }),
      row({ id: 'u2', phone: '0911223344', serial: 2 }),
    ]
    const client: UserLookupClient = { user: { findMany: async () => matches } }

    const result = await resolveUser(client, '0911223344')

    expect(result).toEqual({ status: 'ambiguous', matches })
  })
})

describe('freeze-player script: matchedFields', () => {
  const row = (overrides: Partial<UserLookupRow>): UserLookupRow => ({
    id: 'id-default',
    username: null,
    phone: null,
    serial: 1,
    accountStatus: 'ACTIVE',
    ...overrides,
  })

  it('reports id when the identifier matches the id column', () => {
    expect(matchedFields(row({ id: 'abc' }), 'abc')).toEqual(['id'])
  })

  it('reports username when the identifier matches the username column', () => {
    expect(matchedFields(row({ username: 'bob' }), 'bob')).toEqual(['username'])
  })

  it('reports phone when the identifier matches the phone column', () => {
    expect(matchedFields(row({ phone: '0911223344' }), '0911223344')).toEqual(['phone'])
  })

  it('can report more than one field for a pathological row that matches on both', () => {
    expect(matchedFields(row({ username: 'x', phone: 'x' }), 'x')).toEqual(['username', 'phone'])
  })
})
