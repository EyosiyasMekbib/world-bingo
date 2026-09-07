import { describe, it, expect } from 'vitest'
import { tokenExpiryMs, isExpiringWithin, TOKEN_REFRESH_MARGIN_MS } from './token'

function makeToken(expSeconds: number): string {
  const payload = btoa(JSON.stringify({ exp: expSeconds })).replace(/\+/g, '-').replace(/\//g, '_')
  return `header.${payload}.signature`
}

describe('tokenExpiryMs', () => {
  it('reads exp as milliseconds', () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    expect(tokenExpiryMs(makeToken(exp))).toBe(exp * 1000)
  })

  it('returns null for junk, empty and missing tokens', () => {
    expect(tokenExpiryMs(null)).toBeNull()
    expect(tokenExpiryMs(undefined)).toBeNull()
    expect(tokenExpiryMs('')).toBeNull()
    expect(tokenExpiryMs('not-a-jwt')).toBeNull()
    expect(tokenExpiryMs('a.!!!notbase64!!!.c')).toBeNull()
  })
})

describe('isExpiringWithin', () => {
  it('is true inside the margin', () => {
    expect(isExpiringWithin(makeToken(Math.floor(Date.now() / 1000) + 60), 120_000)).toBe(true)
  })

  it('is false well outside the margin', () => {
    expect(isExpiringWithin(makeToken(Math.floor(Date.now() / 1000) + 900), 120_000)).toBe(false)
  })

  it('treats an already-expired token as expiring', () => {
    expect(isExpiringWithin(makeToken(Math.floor(Date.now() / 1000) - 10), 120_000)).toBe(true)
  })

  it('treats an unreadable token as NOT expiring, so it is not refreshed blindly', () => {
    expect(isExpiringWithin('not-a-jwt', 120_000)).toBe(false)
    expect(isExpiringWithin(null, 120_000)).toBe(false)
  })
})

describe('TOKEN_REFRESH_MARGIN_MS', () => {
  it('is two minutes — comfortably inside the 15-minute access token', () => {
    expect(TOKEN_REFRESH_MARGIN_MS).toBe(120_000)
  })
})
