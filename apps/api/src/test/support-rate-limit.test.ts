import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/redis', () => ({
  default: {
    incr: vi.fn(),
    expire: vi.fn(),
  },
}))

import redis from '../lib/redis'
import { SupportRateLimit, MESSAGES_PER_MINUTE } from '../services/support/support-rate-limit'

describe('SupportRateLimit.checkMessage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allows the first message and sets a TTL on the fresh counter', async () => {
    ;(redis.incr as any).mockResolvedValue(1)

    const allowed = await SupportRateLimit.checkMessage('user-1')

    expect(allowed).toBe(true)
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('support:msg:user-1:'), 60)
  })

  it('does not reset the TTL on subsequent messages', async () => {
    ;(redis.incr as any).mockResolvedValue(5)

    await SupportRateLimit.checkMessage('user-1')

    expect(redis.expire).not.toHaveBeenCalled()
  })

  it('allows exactly up to the limit', async () => {
    ;(redis.incr as any).mockResolvedValue(MESSAGES_PER_MINUTE)
    expect(await SupportRateLimit.checkMessage('user-1')).toBe(true)
  })

  it('blocks one past the limit', async () => {
    ;(redis.incr as any).mockResolvedValue(MESSAGES_PER_MINUTE + 1)
    expect(await SupportRateLimit.checkMessage('user-1')).toBe(false)
  })

  it('fails open when Redis is unreachable', async () => {
    // A support widget that goes silent because Redis blipped is worse than
    // a missing rate limit for one minute.
    ;(redis.incr as any).mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await SupportRateLimit.checkMessage('user-1')).toBe(true)
  })
})
