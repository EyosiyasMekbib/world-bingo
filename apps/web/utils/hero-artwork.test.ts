import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '@world-bingo/shared-types'
import { heroArtworkFor, heroToneFor } from './hero-artwork'

describe('hero artwork is scoped to the brand it was drawn for', () => {
  it('gives arada no artwork slides', () => {
    expect(heroArtworkFor('arada')).toEqual([])
  })

  it('gives winner no artwork slides until banners are drawn for it', () => {
    expect(heroArtworkFor('winner')).toEqual([])
  })

  it('returns a list for every theme id, so a new brand shows coded slides rather than crashing', () => {
    for (const id of THEME_IDS) {
      expect(Array.isArray(heroArtworkFor(id)), `no entry for '${id}'`).toBe(true)
    }
  })
})

describe('coded hero slide tones', () => {
  it('turns every coded slide red on winner', () => {
    for (const id of ['predictions', 'aviator', 'bingo', 'bonus']) {
      const tone = heroToneFor('winner', id)
      expect(tone, `no winner tone for '${id}'`).toBeDefined()
      expect(tone!.gradient).toMatch(/#(e62733|c41a26|a3111c|9e0f1a)/)
    }
  })

  it("leaves arada's slides on their own tones", () => {
    expect(heroToneFor('arada', 'aviator')).toBeUndefined()
  })

  it('leaves an unknown slide alone', () => {
    expect(heroToneFor('winner', 'nope')).toBeUndefined()
  })
})
