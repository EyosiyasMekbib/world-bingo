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
