import { describe, it, expect } from 'vitest'
import { markTap, playHrefTarget, takeTap, TAP_MAX_AGE_MS } from './launch-handoff'

describe('playHrefTarget', () => {
  it('reads provider and game codes', () => {
    expect(playHrefTarget('/play/palace/aviator')).toEqual({
      providerCode: 'palace',
      gameCode: 'aviator',
    })
  })

  it('decodes encoded segments', () => {
    expect(playHrefTarget('/play/palace/chicken%20road')).toEqual({
      providerCode: 'palace',
      gameCode: 'chicken road',
    })
  })

  it.each([
    '/games/bingo',
    '/play/palace',
    '/play/palace/aviator/extra',
    'https://x.example/play/a/b',
  ])('ignores %s', (href) => {
    expect(playHrefTarget(href)).toBeNull()
  })
})

describe('markTap / takeTap', () => {
  const aviator = { providerCode: 'palace', gameCode: 'aviator' }

  it('hands a fresh tap to the matching page exactly once', () => {
    markTap(aviator, 1000)
    expect(takeTap(aviator, 1600)).toBe(1000)
    expect(takeTap(aviator, 1700)).toBeNull()
  })

  it('ignores a tap for a different game', () => {
    markTap(aviator, 1000)
    expect(takeTap({ providerCode: 'palace', gameCode: 'keno' }, 1200)).toBeNull()
  })

  it('ignores a stale tap', () => {
    markTap(aviator, 1000)
    expect(takeTap(aviator, 1000 + TAP_MAX_AGE_MS + 1)).toBeNull()
  })
})
