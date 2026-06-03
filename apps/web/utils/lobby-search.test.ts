import { describe, expect, it } from 'vitest'
import {
  filterBingoGames,
  filterProviderGames,
  matchesBingoGameSearch,
  matchesProviderGameSearch,
} from './lobby-search'
import type { ProviderGame } from '../store/provider-games'
import type { Game } from '@world-bingo/shared-types'

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

const bingoGames: Game[] = [
  {
    id: 'game-1',
    ticketPrice: 20,
    status: 'WAITING',
    title: 'Weekend Bingo',
    pattern: 'ANY_LINE',
  } as Game,
  {
    id: 'game-2',
    ticketPrice: 50,
    status: 'IN_PROGRESS',
    title: 'High Rollers',
    pattern: 'FULL_CARD',
  } as Game,
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

  it('matches bingo games by title, price, status, or pattern label', () => {
    expect(matchesBingoGameSearch(bingoGames[0], 'weekend', 'Any Line')).toBe(true)
    expect(matchesBingoGameSearch(bingoGames[0], '20', 'Any Line')).toBe(true)
    expect(matchesBingoGameSearch(bingoGames[0], 'waiting', 'Any Line')).toBe(true)
    expect(matchesBingoGameSearch(bingoGames[0], 'full', 'Any Line')).toBe(false)
  })

  it('filters bingo games with a normalized query', () => {
    expect(
      filterBingoGames(bingoGames, '  full  ', (game) =>
        game.pattern === 'FULL_CARD' ? 'Full Card' : 'Any Line',
      ),
    ).toEqual([bingoGames[1]])
  })
})
