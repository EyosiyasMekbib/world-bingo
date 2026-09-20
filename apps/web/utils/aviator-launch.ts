/**
 * The Aviator nav tab opens the game itself rather than a category list.
 *
 * Game codes are provider-specific, so the tab can't link to a fixed
 * /play/<provider>/<code>; /aviator asks the API for the catalog's Aviator
 * (matched by normalized name, honoring the admin's provider priority) and
 * forwards there. When no active provider carries the title, the tab falls
 * back to the Mini Games list it used to link to.
 */
export const AVIATOR_NAME_KEY = 'aviator'
export const AVIATOR_FALLBACK_PATH = '/games/mini'

export interface NamedGame {
  providerCode?: string | null
  gameCode?: string | null
}

/** Where /aviator forwards to for the API's answer; the fallback for a miss or an unusable row. */
export function aviatorDestination(game: NamedGame | null | undefined): string {
  if (!game?.providerCode || !game.gameCode) return AVIATOR_FALLBACK_PATH
  return `/play/${encodeURIComponent(game.providerCode)}/${encodeURIComponent(game.gameCode)}`
}
