import { describe, expect, it } from 'vitest'
import { expiresTonight } from './bonus-expiry'

/** Local wall-clock instant, which is the clock the wording is about. */
function at(day: number, hour: number, minute = 0) {
  return new Date(2026, 8, day, hour, minute, 0, 0).getTime()
}

describe('expiresTonight — the night the player is standing in, not the calendar date', () => {
  it('is false for a morning deadline read that morning, though the date matches', () => {
    // The bug this replaced: same `toDateString()`, so the bar announced
    // "expires tonight" beside a countdown reading 02:00:00.
    expect(expiresTonight(at(14, 10), at(14, 8))).toBe(false)
  })

  it('is true just before midnight for a deadline just after it, though the dates differ', () => {
    // The same bug's mirror image: read at 23:50, a 00:30 deadline IS tonight.
    expect(expiresTonight(at(15, 0, 30), at(14, 23, 50))).toBe(true)
  })

  it('counts the small hours as still last night, so a pre-dawn player is not told "within the day"', () => {
    expect(expiresTonight(at(15, 5), at(15, 2))).toBe(true)
  })

  it('is false for tomorrow evening, which is inside 24h but is not tonight', () => {
    expect(expiresTonight(at(15, 20), at(14, 21))).toBe(false)
  })

  it('is false for an afternoon deadline an hour away', () => {
    expect(expiresTonight(at(14, 16), at(14, 15))).toBe(false)
  })

  it('is true for a pre-dawn deadline seen the previous morning', () => {
    expect(expiresTonight(at(15, 5, 30), at(14, 11))).toBe(true)
  })

  it('treats the window as half-open, so dusk counts and dawn does not', () => {
    expect(expiresTonight(at(14, 18), at(14, 12))).toBe(true)
    expect(expiresTonight(at(15, 6), at(14, 23))).toBe(false)
  })
})
