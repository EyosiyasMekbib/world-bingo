import { describe, it, expect } from 'vitest'
import { contactRevealPlan, CONTACT_REVEAL_MS, telHref, telegramHref } from './useSupport'

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

describe('telHref', () => {
  it('builds a tel: href from a normal phone number', () => {
    expect(telHref('+251911223344')).toBe('tel:+251911223344')
  })

  it('allows spaces, hyphens, and parentheses', () => {
    expect(telHref('(0911) 223-344')).toBe('tel:(0911) 223-344')
  })

  it('returns null for an empty string, so the template hides the channel', () => {
    expect(telHref('')).toBeNull()
  })

  it('returns null for a value that is only whitespace', () => {
    expect(telHref('   ')).toBeNull()
  })

  it('returns null rather than a usable href for a javascript: scheme', () => {
    expect(telHref('javascript:alert(1)')).toBeNull()
  })

  it('returns null for any value containing letters', () => {
    expect(telHref('call-us-now')).toBeNull()
  })
})

describe('telegramHref', () => {
  it('builds a t.me href from a handle with a leading @', () => {
    expect(telegramHref('@aradasupport')).toBe('https://t.me/aradasupport')
  })

  it('builds the same t.me href from the bare handle', () => {
    expect(telegramHref('aradasupport')).toBe('https://t.me/aradasupport')
  })

  it('returns null for an empty string, so the template hides the channel', () => {
    expect(telegramHref('')).toBeNull()
  })

  it('returns null for a bare "@" with nothing after it', () => {
    expect(telegramHref('@')).toBeNull()
  })

  it('returns null rather than a usable href for a javascript: scheme', () => {
    expect(telegramHref('javascript:alert(1)')).toBeNull()
  })

  it('returns null for a handle containing a slash, which could smuggle a different path', () => {
    expect(telegramHref('foo/../evil')).toBeNull()
  })
})
