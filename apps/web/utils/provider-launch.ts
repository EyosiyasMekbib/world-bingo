/**
 * The provider a game launches at. Game lists can mix providers — the lobby
 * bootstrap merges every ACTIVE provider's games into one feed, and the
 * provider-games store holds that merged list after the homepage hydrates —
 * so the game row's own providerCode wins. The store's activeProviderCode is
 * only the default for /games' provider switcher, used here as a fallback for
 * rows that don't carry a provider (getGames() flattens a missing one to null).
 */
export function launchProviderFor(
  game: { providerCode?: string | null },
  activeProviderCode: string,
): string {
  return game.providerCode || activeProviderCode
}
