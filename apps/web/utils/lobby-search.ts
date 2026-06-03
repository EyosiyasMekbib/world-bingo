import type { Game } from '@world-bingo/shared-types'
import type { ProviderGame } from '../store/provider-games'

export function normalizeLobbySearchQuery(query: string) {
  return query.trim().toLowerCase()
}

export function matchesProviderGameSearch(game: ProviderGame, query: string) {
  const q = normalizeLobbySearchQuery(query)
  if (!q) return true

  return [game.gameName, game.gameCode, game.categoryCode, game.vendorCode].some((value) =>
    value?.toLowerCase().includes(q),
  )
}

export function filterProviderGames(games: ProviderGame[], query: string) {
  const q = normalizeLobbySearchQuery(query)
  if (!q) return games

  return games.filter((game) => matchesProviderGameSearch(game, q))
}

export function matchesBingoGameSearch(game: Game, query: string, label = '') {
  const q = normalizeLobbySearchQuery(query)
  if (!q) return true

  return (
    String(game.ticketPrice).includes(q) ||
    game.status.toLowerCase().includes(q) ||
    label.toLowerCase().includes(q) ||
    (game as any).title?.toLowerCase().includes(q)
  )
}

export function filterBingoGames(
  games: Game[],
  query: string,
  getLabel: (game: Game) => string = () => '',
) {
  const q = normalizeLobbySearchQuery(query)
  if (!q) return games

  return games.filter((game) => matchesBingoGameSearch(game, q, getLabel(game)))
}
