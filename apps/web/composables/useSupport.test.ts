import { describe, it, expect } from 'vitest'
import { contactRevealPlan, CONTACT_REVEAL_MS } from './useSupport'

const NOW = 1_700_000_000_000

describe('contactRevealPlan', () => {
  it('reveals immediately once an OPEN thread has waited past the threshold', () => {
    const escalatedAt = new Date(NOW - CONTACT_REVEAL_MS - 60_000).toISOString()
    const plan = contactRevealPlan({ status: 'OPEN', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: true, delayMs: null })
  })

  it('reveals exactly at the threshold boundary', () => {
    const escalatedAt = new Date(NOW - CONTACT_REVEAL_MS).toISOString()
    const plan = contactRevealPlan({ status: 'OPEN', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: true, delayMs: null })
  })

  it('schedules a delayed reveal for an OPEN thread that has waited less than the threshold', () => {
    const waited = 60_000
    const escalatedAt = new Date(NOW - waited).toISOString()
    const plan = contactRevealPlan({ status: 'OPEN', escalatedAt }, NOW)
    expect(plan.reveal).toBe(false)
    expect(plan.delayMs).toBe(CONTACT_REVEAL_MS - waited)
  })

  it('never reveals when escalatedAt is null, and schedules no timer', () => {
    const plan = contactRevealPlan({ status: 'OPEN', escalatedAt: null }, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })

  it('never reveals for an ASSIGNED thread, no matter how long ago it escalated', () => {
    const escalatedAt = new Date(NOW - 10 * CONTACT_REVEAL_MS).toISOString()
    const plan = contactRevealPlan({ status: 'ASSIGNED', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })

  it('never reveals for a RESOLVED thread', () => {
    const escalatedAt = new Date(NOW - 10 * CONTACT_REVEAL_MS).toISOString()
    const plan = contactRevealPlan({ status: 'RESOLVED', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })

  it('never reveals for a BOT thread', () => {
    const escalatedAt = new Date(NOW - 10 * CONTACT_REVEAL_MS).toISOString()
    const plan = contactRevealPlan({ status: 'BOT', escalatedAt }, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })

  it('never reveals when there is no conversation at all', () => {
    const plan = contactRevealPlan(null, NOW)
    expect(plan).toEqual({ reveal: false, delayMs: null })
  })
})

describe('CONTACT_REVEAL_MS', () => {
  it('is 5 minutes', () => {
    expect(CONTACT_REVEAL_MS).toBe(5 * 60 * 1000)
  })
})
