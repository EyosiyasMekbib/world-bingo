import { describe, expect, it } from 'vitest'
import { filterProviderGames, matchesProviderGameSearch } from './lobby-search'
import type { ProviderGame } from '../store/provider-games'

const games: ProviderGame[] = [
  {
    gameCode: 'aviator',
    gameName: 'Aviator Deluxe',
    categoryCode: 'CRASH',
    imageSquare: null,
    imageLandscape: null,
    vendorCode: 'SPRIBE',
  },
  {
    gameCode: 'book-of-ra',
    gameName: 'Book of Ra',
    categoryCode: 'SLOTS',
    imageSquare: null,
    imageLandscape: null,
    vendorCode: 'NOVOMATIC',
  },
]

describe('lobby search', () => {
  it('matches provider games by name, code, category, or vendor', () => {
    expect(matchesProviderGameSearch(games[0], 'aviator')).toBe(true)
    expect(matchesProviderGameSearch(games[0], 'crash')).toBe(true)
    expect(matchesProviderGameSearch(games[0], 'spribe')).toBe(true)
    expect(matchesProviderGameSearch(games[0], 'missing')).toBe(false)
  })

  it('filters provider games with a normalized query', () => {
    expect(filterProviderGames(games, '  BOOK  ')).toEqual([games[1]])
    expect(filterProviderGames(games, '')).toEqual(games)
  })
})
