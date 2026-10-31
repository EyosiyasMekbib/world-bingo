import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisMock = vi.hoisted(() => ({ incr: vi.fn(), expire: vi.fn() }))
vi.mock('../lib/redis', () => ({ default: redisMock }))

const accountStatusMock = vi.hoisted(() => ({ AccountStatusService: { playerView: vi.fn() } }))
vi.mock('../services/account-status.service', () => accountStatusMock)

const supportServiceMock = vi.hoisted(() => ({
  SupportService: { ensureConversationFor: vi.fn(), addMessage: vi.fn() },
}))
vi.mock('../services/support/support.service', () => supportServiceMock)

const fanoutMock = vi.hoisted(() => ({ afterSupportMessage: vi.fn() }))
vi.mock('../services/support/fanout', () => fanoutMock)

import { openAppeal, AlreadyActiveError } from '../services/support/appeal'
import { SupportMessageSource } from '@world-bingo/shared-types'

describe('openAppeal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    redisMock.incr.mockResolvedValue(1)
    supportServiceMock.SupportService.ensureConversationFor.mockResolvedValue({ id: 'conv-1' })
    supportServiceMock.SupportService.addMessage.mockResolvedValue({
      message: { id: 'm1', senderRole: 'SYSTEM', body: 'appeal' },
      reopened: false,
      ownerId: 'user-1',
    })
  })

  it('refuses on an ACTIVE account — nothing to appeal', async () => {
    accountStatusMock.AccountStatusService.playerView.mockResolvedValue({ status: 'ACTIVE', category: null, expiresAt: null })
    await expect(openAppeal('user-1', SupportMessageSource.WEB)).rejects.toBeInstanceOf(AlreadyActiveError)
    expect(supportServiceMock.SupportService.addMessage).not.toHaveBeenCalled()
  })

  it('opens a thread naming the plain-language category for a RESTRICTED account', async () => {
    accountStatusMock.AccountStatusService.playerView.mockResolvedValue({
      status: 'RESTRICTED',
      category: 'BONUS_ABUSE',
      expiresAt: null,
    })

    const opened = await openAppeal('user-1', SupportMessageSource.TELEGRAM)

    expect(opened).toBe(true)
    expect(supportServiceMock.SupportService.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        senderRole: 'SYSTEM',
        source: SupportMessageSource.TELEGRAM,
        body: expect.stringContaining('bonus terms'),
      }),
    )
    expect(fanoutMock.afterSupportMessage).toHaveBeenCalled()
  })

  it('is a rate-limited no-op on a repeat within the cooldown — returns false, writes nothing', async () => {
    accountStatusMock.AccountStatusService.playerView.mockResolvedValue({ status: 'SUSPENDED', category: null, expiresAt: null })
    redisMock.incr.mockResolvedValue(2) // not the first this window

    const opened = await openAppeal('user-1', SupportMessageSource.WEB)

    expect(opened).toBe(false)
    expect(supportServiceMock.SupportService.addMessage).not.toHaveBeenCalled()
  })

  it('falls back to a generic label when the category is unset', async () => {
    accountStatusMock.AccountStatusService.playerView.mockResolvedValue({ status: 'SUSPENDED', category: null, expiresAt: null })
    await openAppeal('user-1', SupportMessageSource.WEB)
    expect(supportServiceMock.SupportService.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('an account review') }),
    )
  })
})
