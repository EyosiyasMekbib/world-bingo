/**
 * Lobby tap → play page hand-off, in module memory: it survives the
 * client-side route change and nothing else. Records when a player tapped a
 * game so the play page can report how long reaching it took.
 */
export interface PlayTarget {
  providerCode: string
  gameCode: string
}

/** A tap older than this did not lead to this page view (back button, deep link). */
export const TAP_MAX_AGE_MS = 15_000

/** `/play/<provider>/<game>` → its codes; anything else → null. Pure. */
export function playHrefTarget(href: string): PlayTarget | null {
  const m = /^\/play\/([^/?#]+)\/([^/?#]+)$/.exec(href)
  return m ? { providerCode: decodeURIComponent(m[1]), gameCode: decodeURIComponent(m[2]) } : null
}

const keyOf = (t: PlayTarget) => `${t.providerCode}/${t.gameCode}`

let lastTap: { key: string; at: number } | null = null

export function markTap(target: PlayTarget, at: number): void {
  lastTap = { key: keyOf(target), at }
}

/** The tap time for this game when it is fresh; forgets the tap either way. */
export function takeTap(target: PlayTarget, now: number): number | null {
  const tap = lastTap
  lastTap = null
  if (!tap || tap.key !== keyOf(target)) return null
  if (now < tap.at || now - tap.at > TAP_MAX_AGE_MS) return null
  return tap.at
}
