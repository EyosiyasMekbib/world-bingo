/**
 * Final-review Minor 4. ZARECASH_WITHDRAWAL_ATTEMPTS was read with a bare
 * `Number(...)`, and a bad value silently INVERTED the refund decision:
 * `Number('eight')` is NaN, `job.attemptsMade < NaN` is false, so the worker's
 * "have we exhausted retries?" gate passes on the FIRST failure and fires the
 * terminal refund immediately — refunding a payout after one transient blip.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { __readWithdrawalAttemptsForTest } from '../lib/queue'

const ORIGINAL = { ...process.env }

describe('ZARECASH_WITHDRAWAL_ATTEMPTS validation', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => { process.env = { ...ORIGINAL } })

  it('accepts a valid positive integer', () => {
    process.env.ZARECASH_WITHDRAWAL_ATTEMPTS = '5'
    expect(__readWithdrawalAttemptsForTest()).toBe(5)
  })

  it('defaults to 8 when unset', () => {
    delete process.env.ZARECASH_WITHDRAWAL_ATTEMPTS
    expect(__readWithdrawalAttemptsForTest()).toBe(8)
  })

  it('never yields NaN for a non-numeric value — that would refund on the first failure', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.ZARECASH_WITHDRAWAL_ATTEMPTS = 'eight'

    const attempts = __readWithdrawalAttemptsForTest()

    expect(Number.isNaN(attempts)).toBe(false)
    expect(attempts).toBe(8)
    // Proves the gate still works: `0 < NaN` is false, `0 < 8` is true.
    expect(0 < attempts).toBe(true)
  })

  it('rejects zero, negatives and fractions, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of ['0', '-3', '2.5', '  ']) {
      process.env.ZARECASH_WITHDRAWAL_ATTEMPTS = bad
      expect(__readWithdrawalAttemptsForTest()).toBe(8)
    }
    // '  ' trims to empty and takes the silent unset path; the other three warn.
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
