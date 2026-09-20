import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  wallet: { findUnique: vi.fn() },
  transaction: { findMany: vi.fn() },
}))
vi.mock('../lib/prisma', () => ({ default: prismaMock }))

const redisMock = vi.hoisted(() => ({ incr: vi.fn(), expire: vi.fn() }))
vi.mock('../lib/redis', () => ({ default: redisMock }))

const clientMock = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendMessagePlain: vi.fn(),
  getFile: vi.fn(),
  fileUrl: vi.fn(),
}))
vi.mock('../gateways/telegram/client', () => ({ telegramClient: vi.fn(() => clientMock) }))

const linkServiceMock = vi.hoisted(() => ({
  consumeLinkToken: vi.fn(),
  linkChatToUser: vi.fn(),
  matchPhoneToPlayer: vi.fn(),
  mintPasswordResetToken: vi.fn(),
  passwordResetLinkFor: vi.fn(() => 'https://example.com/reset'),
  setNotifyEnabled: vi.fn(),
}))
vi.mock('../services/telegram/link.service', () => linkServiceMock)

const authServiceMock = vi.hoisted(() => ({ AuthService: { revokeAllSessions: vi.fn() } }))
vi.mock('../services/auth.service', () => authServiceMock)

const accountStatusMock = vi.hoisted(() => ({
  AccountStatusService: { playerView: vi.fn(() => Promise.resolve({ status: 'ACTIVE', category: null, expiresAt: null })) },
}))
vi.mock('../services/account-status.service', () => accountStatusMock)

const supportServiceMock = vi.hoisted(() => ({
  SupportService: {
    ensureConversationFor: vi.fn(),
    addMessage: vi.fn(),
    getById: vi.fn(),
    withHistory: vi.fn(),
  },
}))
vi.mock('../services/support/support.service', () => supportServiceMock)

const rateLimitMock = vi.hoisted(() => ({ SupportRateLimit: { checkMessage: vi.fn(() => Promise.resolve(true)) } }))
vi.mock('../services/support/support-rate-limit', () => rateLimitMock)

const supportContactMock = vi.hoisted(() => ({ SupportContact: { get: vi.fn(() => Promise.resolve({ phone: '', telegram: '', hours: '' })) } }))
vi.mock('../services/support/support-contact', () => supportContactMock)

const fanoutMock = vi.hoisted(() => ({ afterSupportMessage: vi.fn() }))
vi.mock('../services/support/fanout', () => fanoutMock)

const presenceMock = vi.hoisted(() => ({ anyAgentOnline: vi.fn(() => Promise.resolve(true)) }))
vi.mock('../services/support/presence', () => presenceMock)

const appealMock = vi.hoisted(() => ({
  openAppeal: vi.fn(),
  AlreadyActiveError: class AlreadyActiveError extends Error {},
}))
vi.mock('../services/support/appeal', () => appealMock)

vi.mock('../lib/socket', () => ({ getIo: vi.fn(() => ({})) }))

const storageMock = vi.hoisted(() => ({ uploadFile: vi.fn(), validateFile: vi.fn() }))
vi.mock('../lib/storage', () => storageMock)

import { handlePlayerMessage } from '../services/telegram/player-handlers'

function privateMsg(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 1,
    date: 0,
    chat: { id: 555, type: 'private' as const },
    from: { id: 555, is_bot: false },
    text: '',
    ...overrides,
  }
}

const LINKED_USER = { id: 'user-1', firstName: 'Abebe', username: 'abebe' }

describe('handlePlayerMessage — shared contact ownership guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.incr.mockResolvedValue(1)
  })

  it('rejects a contact whose user_id does not match the sending chat', async () => {
    await handlePlayerMessage(
      privateMsg({ contact: { phone_number: '251912345678', user_id: 999 } }),
    )
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith('555', expect.stringContaining('your own phone number'))
    expect(linkServiceMock.matchPhoneToPlayer).not.toHaveBeenCalled()
  })

  it('rejects a contact with no user_id at all (a forwarded card)', async () => {
    await handlePlayerMessage(privateMsg({ contact: { phone_number: '251912345678' } }))
    expect(linkServiceMock.matchPhoneToPlayer).not.toHaveBeenCalled()
  })

  it('proceeds to match when the contact belongs to the sender themself', async () => {
    linkServiceMock.matchPhoneToPlayer.mockResolvedValue({ kind: 'NO_MATCH' })
    await handlePlayerMessage(
      privateMsg({ contact: { phone_number: '251912345678', user_id: 555 } }),
    )
    expect(linkServiceMock.matchPhoneToPlayer).toHaveBeenCalledWith('251912345678')
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith('555', expect.stringContaining('No account uses this number'))
  })

  it('links and continues into a password reset link on a match', async () => {
    linkServiceMock.matchPhoneToPlayer.mockResolvedValue({ kind: 'MATCH', userId: 'user-1' })
    linkServiceMock.linkChatToUser.mockResolvedValue({ ok: true, relinked: false, previousChatId: null })
    linkServiceMock.mintPasswordResetToken.mockResolvedValue('tok123')

    await handlePlayerMessage(privateMsg({ contact: { phone_number: '251912345678', user_id: 555 } }))

    expect(linkServiceMock.linkChatToUser).toHaveBeenCalledWith('user-1', '555')
    expect(clientMock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '555', buttons: [{ text: 'Set new password', url: 'https://example.com/reset' }] }),
    )
  })

  it('refuses and notifies neither side when the chat is already linked elsewhere', async () => {
    linkServiceMock.matchPhoneToPlayer.mockResolvedValue({ kind: 'MATCH', userId: 'user-1' })
    linkServiceMock.linkChatToUser.mockResolvedValue({ ok: false, reason: 'CONFLICT' })

    await handlePlayerMessage(privateMsg({ contact: { phone_number: '251912345678', user_id: 555 } }))

    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith('555', expect.stringContaining('already connected'))
    expect(linkServiceMock.mintPasswordResetToken).not.toHaveBeenCalled()
  })
})

describe('handlePlayerMessage — guest (unlinked) traffic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.user.findUnique.mockResolvedValue(null)
    redisMock.incr.mockResolvedValue(1)
  })

  it('prompts an unlinked chat to share its phone number', async () => {
    await handlePlayerMessage(privateMsg({ text: 'hi' }))
    expect(clientMock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '555', requestContact: true }),
    )
    expect(supportServiceMock.SupportService.addMessage).not.toHaveBeenCalled()
  })

  it('rate-limits guest traffic and goes silent past the per-minute budget', async () => {
    redisMock.incr.mockResolvedValue(6)
    await handlePlayerMessage(privateMsg({ text: 'hi again' }))
    expect(clientMock.sendMessage).not.toHaveBeenCalled()
    expect(clientMock.sendMessagePlain).not.toHaveBeenCalled()
  })
})

describe('handlePlayerMessage — linked player commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.user.findUnique.mockResolvedValue(LINKED_USER)
    redisMock.incr.mockResolvedValue(1)
  })

  it('/logout alone only asks for confirmation — does not revoke sessions', async () => {
    await handlePlayerMessage(privateMsg({ text: '/logout' }))
    expect(authServiceMock.AuthService.revokeAllSessions).not.toHaveBeenCalled()
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith('555', expect.stringContaining('logout confirm'))
  })

  it('"/logout confirm" revokes every session', async () => {
    await handlePlayerMessage(privateMsg({ text: '/logout confirm' }))
    expect(authServiceMock.AuthService.revokeAllSessions).toHaveBeenCalledWith('user-1')
  })

  it('/stop turns off Telegram notifications without unlinking', async () => {
    await handlePlayerMessage(privateMsg({ text: '/stop' }))
    expect(linkServiceMock.setNotifyEnabled).toHaveBeenCalledWith('user-1', false)
  })

  it('/appeal on an ACTIVE account replies that there is nothing to appeal, and writes nothing', async () => {
    appealMock.openAppeal.mockRejectedValue(new appealMock.AlreadyActiveError())
    await handlePlayerMessage(privateMsg({ text: '/appeal' }))
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith('555', expect.stringContaining('nothing to appeal'))
  })

  it('/appeal opens a fresh appeal and confirms it', async () => {
    appealMock.openAppeal.mockResolvedValue(true)
    await handlePlayerMessage(privateMsg({ text: '/appeal' }))
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith('555', expect.stringContaining('flagged this for review'))
  })

  it('/appeal on a cooldown repeat says one is already in progress, not that a new one was filed', async () => {
    appealMock.openAppeal.mockResolvedValue(false)
    await handlePlayerMessage(privateMsg({ text: '/appeal' }))
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith('555', expect.stringContaining('already have an appeal'))
  })

  it('free text becomes a PLAYER support message tagged with the Telegram source', async () => {
    supportServiceMock.SupportService.ensureConversationFor.mockResolvedValue({ id: 'conv-1' })
    supportServiceMock.SupportService.addMessage.mockResolvedValue({
      message: { id: 'm1', senderRole: 'PLAYER', body: 'I need help' },
      reopened: false,
      ownerId: 'user-1',
    })

    await handlePlayerMessage(privateMsg({ text: 'I need help' }))

    expect(supportServiceMock.SupportService.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', senderRole: 'PLAYER', senderId: 'user-1', body: 'I need help', source: 'TELEGRAM' }),
    )
    expect(fanoutMock.afterSupportMessage).toHaveBeenCalled()
  })

  it('does not forward a message into support when the rate limiter denies it', async () => {
    rateLimitMock.SupportRateLimit.checkMessage.mockResolvedValue(false)
    await handlePlayerMessage(privateMsg({ text: 'spam' }))
    expect(supportServiceMock.SupportService.addMessage).not.toHaveBeenCalled()
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith('555', expect.stringContaining('Too many messages'))
  })
})
