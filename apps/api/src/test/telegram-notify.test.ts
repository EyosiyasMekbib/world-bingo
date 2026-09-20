import { describe, it, expect, vi, beforeEach } from 'vitest'

const queueMock = vi.hoisted(() => ({ add: vi.fn() }))
vi.mock('../lib/queue', () => ({
  getQueue: vi.fn(() => queueMock),
  QUEUE_NAMES: { TELEGRAM_SEND: 'telegram-send' },
}))

const configMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  webBaseUrl: vi.fn(() => 'https://www.aradabingo.bet'),
}))
vi.mock('../gateways/telegram/config', () => configMock)

import { NotificationType } from '@world-bingo/shared-types'
import { isPushedType, renderPush, enqueueNotificationPush, escapeHtml } from '../services/telegram/notify'

describe('isPushedType', () => {
  it('excludes SUPPORT_REPLY — the fanout bridge delivers it directly', () => {
    expect(isPushedType(NotificationType.SUPPORT_REPLY)).toBe(false)
  })

  it('excludes GAME_STARTING — fires once per game entered, would get the bot muted', () => {
    expect(isPushedType(NotificationType.GAME_STARTING)).toBe(false)
  })

  it('includes an ordinary money-moving type', () => {
    expect(isPushedType(NotificationType.DEPOSIT_APPROVED)).toBe(true)
    expect(isPushedType(NotificationType.WITHDRAWAL_PROCESSED)).toBe(true)
  })
})

describe('renderPush', () => {
  it('bolds the title and includes an Open button for a type with a landing page', () => {
    const rendered = renderPush(NotificationType.DEPOSIT_APPROVED, 'Deposit approved', '100 ETB credited')
    expect(rendered.text).toBe('<b>Deposit approved</b>\n100 ETB credited')
    expect(rendered.buttonUrl).toBe('https://www.aradabingo.bet/wallet')
    expect(rendered.buttonLabel).toBe('Open')
  })

  it('sends text only, no button, for a type with no landing page', () => {
    const rendered = renderPush(NotificationType.GAME_CANCELLED, 'Game cancelled', 'Refunded')
    expect(rendered.buttonUrl).toBeUndefined()
  })

  it('sends text only when WEB_BASE_URL is not configured, even for a type with a landing page', () => {
    configMock.webBaseUrl.mockReturnValueOnce('')
    const rendered = renderPush(NotificationType.DEPOSIT_APPROVED, 'Deposit approved', 'body')
    expect(rendered.buttonUrl).toBeUndefined()
  })

  it('escapes HTML-significant characters in title and body', () => {
    const rendered = renderPush(NotificationType.GAME_CANCELLED, 'A < B', 'R&D <script>')
    expect(rendered.text).toContain('A &lt; B')
    expect(rendered.text).toContain('R&amp;D &lt;script&gt;')
  })
})

describe('escapeHtml', () => {
  it('escapes &, < and >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })
})

describe('enqueueNotificationPush', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configMock.isEnabled.mockReturnValue(true)
  })

  it('enqueues a notification-kind job for a pushed type', async () => {
    await enqueueNotificationPush('user-1', NotificationType.DEPOSIT_APPROVED, 'Title', 'Body')
    expect(queueMock.add).toHaveBeenCalledWith(
      'push',
      expect.objectContaining({ userId: 'user-1', kind: 'notification' }),
    )
  })

  it('does not enqueue anything for an excluded type', async () => {
    await enqueueNotificationPush('user-1', NotificationType.SUPPORT_REPLY, 'Title', 'Body')
    expect(queueMock.add).not.toHaveBeenCalled()
  })

  it('does not enqueue anything when the bot is disabled', async () => {
    configMock.isEnabled.mockReturnValue(false)
    await enqueueNotificationPush('user-1', NotificationType.DEPOSIT_APPROVED, 'Title', 'Body')
    expect(queueMock.add).not.toHaveBeenCalled()
  })
})
