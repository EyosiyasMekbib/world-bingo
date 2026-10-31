import { describe, it, expect, vi, beforeEach } from 'vitest'

const clientMock = vi.hoisted(() => ({
  getChat: vi.fn(),
  getChatMember: vi.fn(),
}))
vi.mock('../gateways/telegram/client', () => ({ telegramClient: () => clientMock }))

const configMock = vi.hoisted(() => ({
  isStaffBridgeEnabled: vi.fn(() => true),
  supportGroupId: vi.fn(() => '-1001'),
}))
vi.mock('../gateways/telegram/config', () => ({
  ...configMock,
  isEnabled: vi.fn(() => true),
  webhookUrl: vi.fn(() => null),
  webhookSecret: vi.fn(() => 's'),
  setBotUsername: vi.fn(),
  WEBHOOK_PATH: '/v1/telegram/webhook',
}))

import { checkStaffGroup } from '../gateways/telegram/bot'

const READY_CHAT = { id: -1001, type: 'supergroup', title: 'Arada Support', is_forum: true }
const ADMIN = { status: 'administrator', can_manage_topics: true }

describe('checkStaffGroup (§9: wrong group id or bot not admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMock.isStaffBridgeEnabled.mockReturnValue(true)
    configMock.supportGroupId.mockReturnValue('-1001')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('does not call Telegram when the staff bridge is off', async () => {
    configMock.isStaffBridgeEnabled.mockReturnValue(false)
    configMock.supportGroupId.mockReturnValue(null as unknown as string)
    expect(await checkStaffGroup(42)).toBe(true)
    expect(clientMock.getChat).not.toHaveBeenCalled()
  })

  it('logs the group title when the group is a forum and the bot can manage topics', async () => {
    clientMock.getChat.mockResolvedValue(READY_CHAT)
    clientMock.getChatMember.mockResolvedValue(ADMIN)
    expect(await checkStaffGroup(42)).toBe(true)
    expect(clientMock.getChatMember).toHaveBeenCalledWith('-1001', 42)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Arada Support'))
  })

  it('names every problem: not a forum, bot only a member', async () => {
    clientMock.getChat.mockResolvedValue({ ...READY_CHAT, is_forum: false })
    clientMock.getChatMember.mockResolvedValue({ status: 'member' })
    expect(await checkStaffGroup(42)).toBe(false)
    const line = vi.mocked(console.error).mock.calls[0][0] as string
    expect(line).toContain('Topics')
    expect(line).toContain('not an admin')
  })

  it('flags an admin bot that lacks the Manage Topics right', async () => {
    clientMock.getChat.mockResolvedValue(READY_CHAT)
    clientMock.getChatMember.mockResolvedValue({ status: 'administrator', can_manage_topics: false })
    expect(await checkStaffGroup(42)).toBe(false)
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Manage Topics')
  })

  it('accepts the group creator without a can_manage_topics flag', async () => {
    clientMock.getChat.mockResolvedValue(READY_CHAT)
    clientMock.getChatMember.mockResolvedValue({ status: 'creator' })
    expect(await checkStaffGroup(42)).toBe(true)
  })

  it('reports an unreachable group (wrong id, bot removed) without throwing', async () => {
    clientMock.getChat.mockRejectedValue(new Error('Bad Request: chat not found'))
    expect(await checkStaffGroup(42)).toBe(false)
    const line = vi.mocked(console.error).mock.calls[0][0] as string
    expect(line).toContain('-1001')
    expect(line).toContain('chat not found')
  })
})
