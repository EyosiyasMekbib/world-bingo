import { describe, it, expect, vi } from 'vitest'

const WorkerMock = vi.hoisted(() => vi.fn(() => ({ on: vi.fn() })))
vi.mock('bullmq', () => ({ Worker: WorkerMock }))
vi.mock('../lib/prisma.js', () => ({ default: {} }))
vi.mock('../lib/sentry.js', () => ({ reportError: vi.fn() }))
vi.mock('../gateways/telegram/client.js', () => ({ telegramClient: vi.fn(), TelegramApiError: class {} }))
vi.mock('../gateways/telegram/config.js', () => ({ isEnabled: vi.fn(() => true) }))

import '../workers/telegram-send.worker'

describe('telegram-send worker', () => {
  // Telegram allows about 30 messages a second across all chats. A
  // tournament start notifies every entrant at once; without a limiter the
  // burst 429s, and three 1s/2s/4s retries are not enough to clear it, so
  // pushes are dropped.
  it('stays under Telegram\'s bulk send limit', () => {
    const options = (WorkerMock.mock.calls[0] as unknown[])[2] as {
      limiter?: { max: number; duration: number }
    }
    expect(options.limiter).toBeDefined()
    expect(options.limiter!.max / (options.limiter!.duration / 1000)).toBeLessThanOrEqual(30)
  })
})
