import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
}))
vi.mock('../lib/prisma', () => ({ default: prismaMock }))

const multiChain = vi.hoisted(() => ({
  get: vi.fn().mockReturnThis(),
  del: vi.fn().mockReturnThis(),
  exec: vi.fn(),
}))
const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  multi: vi.fn(() => multiChain),
}))
vi.mock('../lib/redis', () => ({ default: redisMock }))

const configMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  botUsername: vi.fn(() => 'world_bingo_support_bot'),
  webBaseUrl: vi.fn(() => 'https://www.aradabingo.bet'),
}))
vi.mock('../gateways/telegram/config', () => configMock)

import {
  mintPlayerLinkToken,
  mintStaffLinkToken,
  consumeLinkToken,
  linkChatToUser,
  unlinkChat,
  setNotifyEnabled,
  matchPhoneToPlayer,
  mintPasswordResetToken,
  consumePasswordResetToken,
  passwordResetLinkFor,
} from '../services/telegram/link.service'

describe('mintPlayerLinkToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMock.isEnabled.mockReturnValue(true)
    configMock.botUsername.mockReturnValue('world_bingo_support_bot')
  })

  it('returns a t.me deep link and stores the payload with a TTL', async () => {
    redisMock.incr.mockResolvedValue(1)

    const link = await mintPlayerLinkToken('user-1', 'conv-1')

    expect(link).toMatch(/^https:\/\/t\.me\/world_bingo_support_bot\?start=/)
    expect(redisMock.set).toHaveBeenCalledWith(
      expect.stringMatching(/^tg:link:/),
      expect.stringContaining('"userId":"user-1"'),
      'EX',
      600,
    )
    const [, storedValue] = redisMock.set.mock.calls[0]
    expect(JSON.parse(storedValue)).toEqual({ kind: 'player', userId: 'user-1', conversationId: 'conv-1' })
  })

  it('returns null when the bot is disabled', async () => {
    configMock.isEnabled.mockReturnValue(false)
    redisMock.incr.mockResolvedValue(1)
    expect(await mintPlayerLinkToken('user-1')).toBeNull()
    expect(redisMock.set).not.toHaveBeenCalled()
  })

  it('returns null once boot has not yet learned the bot username', async () => {
    configMock.botUsername.mockReturnValue(null)
    redisMock.incr.mockResolvedValue(1)
    expect(await mintPlayerLinkToken('user-1')).toBeNull()
  })

  it('returns null once the per-user mint budget is exceeded', async () => {
    redisMock.incr.mockResolvedValue(11)
    expect(await mintPlayerLinkToken('user-1')).toBeNull()
    expect(redisMock.set).not.toHaveBeenCalled()
  })

  it('sets the rate-limit TTL only on the first mint in the window', async () => {
    redisMock.incr.mockResolvedValue(1)
    await mintPlayerLinkToken('user-1')
    expect(redisMock.expire).toHaveBeenCalledWith('tg:linkrate:user-1', 3600)

    redisMock.expire.mockClear()
    redisMock.incr.mockResolvedValue(2)
    await mintPlayerLinkToken('user-1')
    expect(redisMock.expire).not.toHaveBeenCalled()
  })
})

describe('mintStaffLinkToken', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stores a staff-kind payload with no conversationId', async () => {
    redisMock.incr.mockResolvedValue(1)
    await mintStaffLinkToken('staff-1')
    const [, storedValue] = redisMock.set.mock.calls[0]
    expect(JSON.parse(storedValue)).toEqual({ kind: 'staff', userId: 'staff-1' })
  })
})

describe('consumeLinkToken', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads and deletes the token atomically, in one MULTI', async () => {
    multiChain.exec.mockResolvedValue([[null, JSON.stringify({ kind: 'player', userId: 'user-1' })], [null, 1]])

    const payload = await consumeLinkToken('tok123')

    expect(payload).toEqual({ kind: 'player', userId: 'user-1' })
    expect(multiChain.get).toHaveBeenCalledWith('tg:link:tok123')
    expect(multiChain.del).toHaveBeenCalledWith('tg:link:tok123')
  })

  it('returns null for an expired or unknown token', async () => {
    multiChain.exec.mockResolvedValue([[null, null], [null, 0]])
    expect(await consumeLinkToken('missing')).toBeNull()
  })

  it('returns null rather than throwing on corrupt stored JSON', async () => {
    multiChain.exec.mockResolvedValue([[null, '{not json'], [null, 1]])
    expect(await consumeLinkToken('tok123')).toBeNull()
  })
})

describe('linkChatToUser — conflict matrix', () => {
  beforeEach(() => vi.clearAllMocks())

  it('links a chat with no prior owner', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null) // no user currently holds this chat
      .mockResolvedValueOnce({ telegramChatId: null }) // this user has no chat yet
    prismaMock.user.update.mockResolvedValue({})

    const result = await linkChatToUser('user-1', 'chat-1')

    expect(result).toEqual({ ok: true, relinked: false, previousChatId: null })
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { telegramChatId: 'chat-1', telegramLinkedAt: expect.any(Date), telegramBlockedAt: null },
    })
  })

  it('refuses when the chat is already linked to a different account', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({ id: 'someone-else' })

    const result = await linkChatToUser('user-1', 'chat-1')

    expect(result).toEqual({ ok: false, reason: 'CONFLICT' })
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })

  it('is a no-op re-link, not a conflict, when the chat already belongs to the same user', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ id: 'user-1' })
      .mockResolvedValueOnce({ telegramChatId: 'chat-1' })
    prismaMock.user.update.mockResolvedValue({})

    const result = await linkChatToUser('user-1', 'chat-1')

    expect(result).toEqual({ ok: true, relinked: false, previousChatId: null })
  })

  it('allows re-linking the same user to a different chat and reports the old one', async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ telegramChatId: 'old-chat' })
    prismaMock.user.update.mockResolvedValue({})

    const result = await linkChatToUser('user-1', 'new-chat')

    expect(result).toEqual({ ok: true, relinked: true, previousChatId: 'old-chat' })
  })

  it('translates a DB-level unique violation (lost race) into CONFLICT rather than throwing', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ telegramChatId: null })
    prismaMock.user.update.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))

    const result = await linkChatToUser('user-1', 'chat-1')

    expect(result).toEqual({ ok: false, reason: 'CONFLICT' })
  })

  it('does not swallow an unrelated database error', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ telegramChatId: null })
    prismaMock.user.update.mockRejectedValueOnce(new Error('connection reset'))

    await expect(linkChatToUser('user-1', 'chat-1')).rejects.toThrow('connection reset')
  })
})

describe('unlinkChat / setNotifyEnabled', () => {
  beforeEach(() => vi.clearAllMocks())

  it('clears the chat id and linked-at timestamp', async () => {
    await unlinkChat('user-1')
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { telegramChatId: null, telegramLinkedAt: null },
    })
  })

  it('writes the notify toggle', async () => {
    await setNotifyEnabled('user-1', false)
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { telegramNotifyEnabled: false },
    })
  })
})

describe('matchPhoneToPlayer', () => {
  beforeEach(() => vi.clearAllMocks())

  it('matches a player whose stored phone is in any raw form', async () => {
    prismaMock.user.findMany.mockResolvedValue([{ id: 'user-1' }])

    const result = await matchPhoneToPlayer('251912345678')

    expect(result).toEqual({ kind: 'MATCH', userId: 'user-1' })
    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: {
        role: 'PLAYER',
        phone: { in: expect.arrayContaining(['0912345678', '912345678', '251912345678', '+251912345678']) },
      },
      select: { id: true },
    })
  })

  it('reports NO_MATCH for a well-formed number nobody registered with', async () => {
    prismaMock.user.findMany.mockResolvedValue([])
    expect(await matchPhoneToPlayer('0912345678')).toEqual({ kind: 'NO_MATCH' })
  })

  it('reports AMBIGUOUS rather than guessing when more than one player matches', async () => {
    prismaMock.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    expect(await matchPhoneToPlayer('0912345678')).toEqual({ kind: 'AMBIGUOUS' })
  })

  it('reports INVALID without querying the database for a non-Ethiopian-mobile shape', async () => {
    expect(await matchPhoneToPlayer('12345')).toEqual({ kind: 'INVALID' })
    expect(prismaMock.user.findMany).not.toHaveBeenCalled()
  })
})

describe('password reset tokens', () => {
  beforeEach(() => vi.clearAllMocks())

  it('mints a token, stores the user id, and rate-limits at three per hour', async () => {
    redisMock.incr.mockResolvedValue(1)
    const token = await mintPasswordResetToken('user-1')
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(redisMock.set).toHaveBeenCalledWith(`tg:pwreset:${token}`, 'user-1', 'EX', 600)

    redisMock.incr.mockResolvedValue(4)
    expect(await mintPasswordResetToken('user-1')).toBeNull()
  })

  it('consumes the token to the stored user id exactly once', async () => {
    multiChain.exec.mockResolvedValue([[null, 'user-1'], [null, 1]])
    expect(await consumePasswordResetToken('tok')).toBe('user-1')
  })

  it('builds the reset link against the configured web base URL', () => {
    expect(passwordResetLinkFor('tok123')).toBe(
      'https://www.aradabingo.bet/auth/reset-password?token=tok123',
    )
  })
})
