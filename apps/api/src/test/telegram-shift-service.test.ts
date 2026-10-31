import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisMock = vi.hoisted(() => ({
  zadd: vi.fn(),
  zrem: vi.fn(),
  zscore: vi.fn(),
  zremrangebyscore: vi.fn(),
  zcount: vi.fn(),
}))
vi.mock('../lib/redis', () => ({ default: redisMock }))

vi.mock('../gateways/telegram/config', () => ({ shiftHours: vi.fn(() => 8) }))

import { goOnShift, goOffShift, touchShift, anyOnShift, isOnShift } from '../services/telegram/shift.service'

describe('goOnShift / goOffShift', () => {
  beforeEach(() => vi.clearAllMocks())

  it('adds the user with an expiry roughly shiftHours from now', async () => {
    const before = Date.now()
    await goOnShift('clerk-1')
    const [key, score, member] = redisMock.zadd.mock.calls[0]
    expect(key).toBe('tg:onshift')
    expect(member).toBe('clerk-1')
    expect(score).toBeGreaterThanOrEqual(before + 8 * 3_600_000 - 1000)
    expect(score).toBeLessThanOrEqual(Date.now() + 8 * 3_600_000 + 1000)
  })

  it('removes the user from the set', async () => {
    await goOffShift('clerk-1')
    expect(redisMock.zrem).toHaveBeenCalledWith('tg:onshift', 'clerk-1')
  })
})

describe('touchShift', () => {
  beforeEach(() => vi.clearAllMocks())

  it('re-adds (refreshes) a clerk who is currently on shift', async () => {
    redisMock.zscore.mockResolvedValue(String(Date.now() + 1000))
    await touchShift('clerk-1')
    expect(redisMock.zadd).toHaveBeenCalled()
  })

  it('does nothing for a clerk who is not on shift — never grants presence', async () => {
    redisMock.zscore.mockResolvedValue(null)
    await touchShift('clerk-1')
    expect(redisMock.zadd).not.toHaveBeenCalled()
  })
})

describe('anyOnShift', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sweeps expired members before counting', async () => {
    redisMock.zcount.mockResolvedValue(1)
    await anyOnShift()
    expect(redisMock.zremrangebyscore).toHaveBeenCalledWith('tg:onshift', '-inf', expect.any(Number))
  })

  it('is true when at least one unexpired member remains', async () => {
    redisMock.zcount.mockResolvedValue(2)
    expect(await anyOnShift()).toBe(true)
  })

  it('is false when the set is empty after the sweep', async () => {
    redisMock.zcount.mockResolvedValue(0)
    expect(await anyOnShift()).toBe(false)
  })
})

describe('isOnShift', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is true for a member whose expiry is in the future', async () => {
    redisMock.zscore.mockResolvedValue(String(Date.now() + 60_000))
    expect(await isOnShift('clerk-1')).toBe(true)
  })

  it('is false for a member whose expiry has already passed', async () => {
    redisMock.zscore.mockResolvedValue(String(Date.now() - 60_000))
    expect(await isOnShift('clerk-1')).toBe(false)
  })

  it('is false for a user never on shift', async () => {
    redisMock.zscore.mockResolvedValue(null)
    expect(await isOnShift('clerk-1')).toBe(false)
  })
})
