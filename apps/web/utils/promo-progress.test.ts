import { describe, expect, it } from 'vitest'
import { promoProgressView, remainingToTarget } from './promo-progress'

describe('promoProgressView — a signed figure made safe to draw', () => {
  it('floors a winning period at empty rather than drawing it full', () => {
    // The bug this replaces: width: -37% is invalid, the browser drops it, and
    // with no width in the CSS the fill spanned its parent — so the emptiest
    // bar rendered as the fullest.
    const { pct, announced } = promoProgressView(-250, 500)
    expect(pct).toBe(0)
    expect(announced).toBe(0)
  })

  it('caps a player past the threshold at full, and announces no more than the target', () => {
    const { pct, announced } = promoProgressView(900, 500)
    expect(pct).toBe(100)
    expect(announced).toBe(500)
  })

  it('reports the true proportion in between', () => {
    expect(promoProgressView(320, 500).pct).toBe(64)
    expect(promoProgressView(320, 500).announced).toBe(320)
  })

  it('keeps the announced value inside the range it is declared against', () => {
    // aria-valuemin is 0 and aria-valuemax is target, so anything outside that
    // is a screen reader announcing a figure the bar contradicts.
    for (const current of [-1000, -1, 0, 1, 250, 499, 500, 501, 10_000]) {
      const { announced } = promoProgressView(current, 500)
      expect(announced).toBeGreaterThanOrEqual(0)
      expect(announced).toBeLessThanOrEqual(500)
    }
  })

  it('draws nothing rather than dividing by zero when there is no target', () => {
    expect(promoProgressView(50, 0)).toEqual({ pct: 0, announced: 0 })
    expect(promoProgressView(50, -1)).toEqual({ pct: 0, announced: 0 })
  })
})

describe('remainingToTarget', () => {
  it('is what is left to earn', () => {
    expect(remainingToTarget(320, 500)).toBe(180)
  })

  it('is zero once the threshold is passed, never a negative debt', () => {
    expect(remainingToTarget(900, 500)).toBe(0)
  })

  it('is the whole target for a player who is net up', () => {
    expect(remainingToTarget(-250, 500)).toBe(750)
  })
})
