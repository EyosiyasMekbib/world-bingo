import { describe, it, expect, vi, beforeEach } from 'vitest'

// The limiter owns its own ioredis client rather than sharing lib/redis.ts —
// see the comment there for why — so this mocks the driver, not the module.
const client = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
  on: vi.fn(),
}))

vi.mock('ioredis', () => ({ default: vi.fn(() => client) }))

import Redis from 'ioredis'
import { SupportRateLimit, MESSAGES_PER_MINUTE } from '../services/support/support-rate-limit'

describe('SupportRateLimit.checkMessage', () => {
  beforeEach(() => {
    client.incr.mockReset()
    client.expire.mockReset()
  })

  it('allows the first message and sets a TTL on the fresh counter', async () => {
    client.incr.mockResolvedValue(1)

    const allowed = await SupportRateLimit.checkMessage('user-1')

    expect(allowed).toBe(true)
    expect(client.expire).toHaveBeenCalledWith(expect.stringContaining('support:msg:user-1:'), 60)
  })

  it('does not reset the TTL on subsequent messages', async () => {
    client.incr.mockResolvedValue(5)

    await SupportRateLimit.checkMessage('user-1')

    expect(client.expire).not.toHaveBeenCalled()
  })

  it('allows exactly up to the limit', async () => {
    client.incr.mockResolvedValue(MESSAGES_PER_MINUTE)
    expect(await SupportRateLimit.checkMessage('user-1')).toBe(true)
  })

  it('blocks one past the limit', async () => {
    client.incr.mockResolvedValue(MESSAGES_PER_MINUTE + 1)
    expect(await SupportRateLimit.checkMessage('user-1')).toBe(false)
  })

  it('fails open when Redis is unreachable', async () => {
    // A support widget that goes silent because Redis blipped is worse than
    // a missing rate limit for one minute.
    client.incr.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await SupportRateLimit.checkMessage('user-1')).toBe(true)
  })

  it('is built with an offline queue that rejects instead of parking the command', async () => {
    // This is what makes the failure above FAST. Under ioredis defaults —
    // enableOfflineQueue: true, maxRetriesPerRequest: 20 — a down Redis makes
    // incr neither resolve nor reject for tens of seconds, and this is the
    // first thing support:send awaits, so every message hangs rather than
    // failing into the catch. A Promise.race timeout would not fix it: the
    // command would stay queued and a sustained outage would grow the queue
    // without bound.
    expect(Redis).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
    )
  })

  it('fails open fast rather than hanging on an unreachable Redis', async () => {
    client.incr.mockRejectedValue(
      new Error('Stream isn’t writeable and enableOfflineQueue is false'),
    )

    const started = Date.now()
    const allowed = await SupportRateLimit.checkMessage('user-1')

    expect(allowed).toBe(true)
    expect(Date.now() - started).toBeLessThan(50)
  })
})
