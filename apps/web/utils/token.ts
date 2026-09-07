/**
 * Access-token expiry, read from the JWT payload without verifying it — the
 * client only needs to know *when* to ask for a new one; the server is the only
 * thing that decides whether a token is valid.
 *
 * Lifted out of composables/useSocket.ts so the socket and the auth store share
 * one definition. They used to disagree: the socket refreshed at 60s to expiry,
 * the store not at all, so a page load could fire a burst of requests with a
 * token that expired mid-flight.
 */

/**
 * Refresh this long before expiry. Two minutes on a 15-minute token: early
 * enough that a slow mobile round trip still lands before the old token dies,
 * late enough that a normal session refreshes about six times an hour.
 */
export const TOKEN_REFRESH_MARGIN_MS = 120_000

export function tokenExpiryMs(token: string | null | undefined): number | null {
  if (!token) return null
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json?.exp === 'number' ? json.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * True when the token expires within `marginMs`. An unreadable token returns
 * FALSE on purpose: we cannot tell, and refreshing on every call would turn one
 * bad parse into a refresh storm. A real 401 still triggers the reactive path.
 */
export function isExpiringWithin(token: string | null | undefined, marginMs: number): boolean {
  const expiry = tokenExpiryMs(token)
  if (expiry === null) return false
  return expiry - Date.now() < marginMs
}
