import { describe, it, expect, vi, beforeEach } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  supportConversation: { findFirst: vi.fn() },
}))
vi.mock('../lib/prisma', () => ({ default: prismaMock }))

const clientMock = vi.hoisted(() => ({
  sendMessagePlain: vi.fn(),
}))
vi.mock('../gateways/telegram/client', () => ({ telegramClient: vi.fn(() => clientMock) }))

const configMock = vi.hoisted(() => ({ supportGroupId: vi.fn(() => '-100999') }))
vi.mock('../gateways/telegram/config', () => configMock)

const shiftMock = vi.hoisted(() => ({
  goOnShift: vi.fn(),
  goOffShift: vi.fn(),
  touchShift: vi.fn(),
}))
vi.mock('../services/telegram/shift.service', () => shiftMock)

const staffBridgeMock = vi.hoisted(() => ({ postPlayerHeader: vi.fn() }))
vi.mock('../services/telegram/staff-bridge', () => staffBridgeMock)

const supportServiceMock = vi.hoisted(() => ({
  claim: vi.fn(),
  release: vi.fn(),
  resolve: vi.fn(),
  addMessage: vi.fn(),
  listQueue: vi.fn(),
  unassignedCount: vi.fn(),
}))
vi.mock('../services/support/support.service', () => ({ SupportService: supportServiceMock }))

const fanoutMock = vi.hoisted(() => ({
  afterSupportMessage: vi.fn(),
  afterConversationResolved: vi.fn(),
  afterConversationReopened: vi.fn(),
}))
vi.mock('../services/support/fanout', () => fanoutMock)

const auditMock = vi.hoisted(() => ({ writeSupportAudit: vi.fn() }))
vi.mock('../services/support/support-audit', () => auditMock)

import { handleStaffGroupMessage } from '../services/telegram/staff-handlers'

const STAFF_GROUP = -100999

function groupMsg(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 1,
    date: 0,
    chat: { id: STAFF_GROUP, type: 'supergroup' as const },
    from: { id: 42, is_bot: false },
    text: '',
    ...overrides,
  }
}

describe('handleStaffGroupMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // vi.fn() with no configured resolution returns undefined, not a
    // Promise, and several source call sites chain .catch() straight off
    // these — sensible defaults here so a test that doesn't care about one
    // of these calls doesn't crash on `undefined.catch`.
    supportServiceMock.claim.mockResolvedValue({})
    supportServiceMock.release.mockResolvedValue({})
    supportServiceMock.resolve.mockResolvedValue({})
    auditMock.writeSupportAudit.mockResolvedValue(undefined)
    fanoutMock.afterSupportMessage.mockResolvedValue(undefined)
    fanoutMock.afterConversationResolved.mockResolvedValue(undefined)
    fanoutMock.afterConversationReopened.mockResolvedValue(undefined)
    supportServiceMock.listQueue.mockResolvedValue([])
    supportServiceMock.unassignedCount.mockResolvedValue(0)
  })

  it('ignores a message from any chat other than the configured staff group', async () => {
    await handleStaffGroupMessage(groupMsg({ chat: { id: -1, type: 'supergroup' as const } }))
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
  })

  it('ignores a message posted by a bot account', async () => {
    await handleStaffGroupMessage(groupMsg({ from: { id: 42, is_bot: true } }))
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
  })

  it('tells an unlinked sender to link their account, and writes nothing', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    await handleStaffGroupMessage(groupMsg({ text: '/queue' }))
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith(
      String(STAFF_GROUP),
      expect.stringContaining('Link your account'),
      undefined,
    )
    expect(supportServiceMock.addMessage).not.toHaveBeenCalled()
  })

  it('tells a linked but non-staff-role sender to link, without writing anything', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u1', role: 'PLAYER', username: 'p1' })
    await handleStaffGroupMessage(groupMsg({ text: '/queue' }))
    expect(clientMock.sendMessagePlain).toHaveBeenCalledWith(
      String(STAFF_GROUP),
      expect.stringContaining('Link your account'),
      undefined,
    )
  })

  it('/onshift puts a linked clerk on shift', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'clerk-1', role: 'CLERK', username: 'c1' })
    await handleStaffGroupMessage(groupMsg({ text: '/onshift' }))
    expect(shiftMock.goOnShift).toHaveBeenCalledWith('clerk-1')
  })

  it('/offshift takes a linked clerk off shift', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'clerk-1', role: 'CLERK', username: 'c1' })
    await handleStaffGroupMessage(groupMsg({ text: '/offshift' }))
    expect(shiftMock.goOffShift).toHaveBeenCalledWith('clerk-1')
  })

  it('does nothing for a non-command message with no topic — there is no conversation to attach it to', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'clerk-1', role: 'CLERK', username: 'c1' })
    await handleStaffGroupMessage(groupMsg({ text: 'hello' }))
    expect(prismaMock.supportConversation.findFirst).not.toHaveBeenCalled()
    expect(supportServiceMock.addMessage).not.toHaveBeenCalled()
  })

  it('a free-text reply in a mapped topic posts an AGENT message, claims the thread, and fans out', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'clerk-1', role: 'CLERK', username: 'c1' })
    prismaMock.supportConversation.findFirst.mockResolvedValue({ id: 'conv-1', userId: 'player-1' })
    supportServiceMock.addMessage.mockResolvedValue({
      message: { id: 'm1', senderRole: 'AGENT', body: 'hi' },
      reopened: false,
      ownerId: 'player-1',
    })

    await handleStaffGroupMessage(groupMsg({ text: 'How can I help?', message_thread_id: 7 }))

    expect(supportServiceMock.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', senderRole: 'AGENT', senderId: 'clerk-1', body: 'How can I help?' }),
    )
    expect(supportServiceMock.claim).toHaveBeenCalledWith('conv-1', 'clerk-1')
    expect(fanoutMock.afterSupportMessage).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      message: { id: 'm1', senderRole: 'AGENT', body: 'hi' },
      ownerId: 'player-1',
    })
  })

  it('a claim failure on auto-claim (already assigned) does not block the reply itself', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'clerk-1', role: 'CLERK', username: 'c1' })
    prismaMock.supportConversation.findFirst.mockResolvedValue({ id: 'conv-1', userId: 'player-1' })
    supportServiceMock.addMessage.mockResolvedValue({
      message: { id: 'm1', senderRole: 'AGENT', body: 'hi' },
      reopened: false,
      ownerId: 'player-1',
    })
    supportServiceMock.claim.mockRejectedValue(new Error('not open'))

    await expect(
      handleStaffGroupMessage(groupMsg({ text: 'How can I help?', message_thread_id: 7 })),
    ).resolves.not.toThrow()
    expect(fanoutMock.afterSupportMessage).toHaveBeenCalled()
  })

  it('/note writes only an audit entry, never a support message', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'clerk-1', role: 'CLERK', username: 'c1' })
    prismaMock.supportConversation.findFirst.mockResolvedValue({ id: 'conv-1', userId: 'player-1' })

    await handleStaffGroupMessage(groupMsg({ text: '/note keep an eye on this one', message_thread_id: 7 }))

    expect(auditMock.writeSupportAudit).toHaveBeenCalledWith(
      'clerk-1',
      'support.note',
      'conv-1',
      expect.objectContaining({ channel: 'telegram', note: 'keep an eye on this one' }),
    )
    expect(supportServiceMock.addMessage).not.toHaveBeenCalled()
  })

  it('/resolve resolves the conversation and closes the topic', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'clerk-1', role: 'CLERK', username: 'c1' })
    prismaMock.supportConversation.findFirst.mockResolvedValue({ id: 'conv-1', userId: 'player-1' })

    await handleStaffGroupMessage(groupMsg({ text: '/resolve', message_thread_id: 7 }))

    expect(supportServiceMock.resolve).toHaveBeenCalledWith('conv-1', 'clerk-1', false)
    expect(fanoutMock.afterConversationResolved).toHaveBeenCalledWith('conv-1')
  })
})
