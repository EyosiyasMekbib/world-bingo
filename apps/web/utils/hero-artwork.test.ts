import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '@world-bingo/shared-types'
import { heroArtworkFor } from './hero-artwork'

describe('hero artwork is scoped to the brand it was drawn for', () => {
  it('gives arada no artwork slides', () => {
    expect(heroArtworkFor('arada')).toEqual([])
  })

  it('gives dash5 the three banners drawn for it', () => {
    expect(heroArtworkFor('dash5').map((s) => s.id)).toEqual([
      'multi-bonus',
      'sport-cashback',
      'we-are-back',
    ])
  })

  it('returns a list for every theme id, so a new brand shows coded slides rather than crashing', () => {
    for (const id of THEME_IDS) {
      expect(Array.isArray(heroArtworkFor(id)), `no entry for '${id}'`).toBe(true)
    }
  })
})
