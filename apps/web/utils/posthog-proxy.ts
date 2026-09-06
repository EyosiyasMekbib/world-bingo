/**
 * Pure helpers behind server/routes/ingest/[...].ts — the PostHog reverse proxy.
 *
 * These used to be two `routeRules.proxy` entries. Route rules hand the request
 * to h3's `proxyRequest`, which forwards every request header except a fixed
 * ignore list (`transfer-encoding, accept-encoding, connection, keep-alive,
 * upgrade, expect, host, accept`). `cookie` is not on that list, and the auth
 * store persists to a cookie — so every event and replay batch was shipping the
 * player's JWT access token, refresh token and full user record (phone, names,
 * Telegram handle) to PostHog. Same-origin `/ingest/*` requests carry that
 * cookie automatically; nothing in the browser could opt out.
 *
 * So the proxy is a handler now, and these helpers decide what it forwards.
 */

/** The path prefix the proxy is mounted at. */
export const INGEST_PREFIX = '/ingest'

/**
 * Headers that must never reach PostHog. Lowercase — h3 normalises incoming
 * header names, and the handler lowercases again before comparing.
 *
 * `cookie` carries the persisted auth store. `authorization` carries the bearer
 * token on any request that happens to set it. Neither is of the slightest use
 * to an ingest endpoint.
 */
export const STRIPPED_HEADERS = ['cookie', 'authorization'] as const

export interface IngestProxyTargets {
  /** Event/replay ingest origin, e.g. `https://eu.i.posthog.com`. */
  ingest: string
  /** Static asset origin, e.g. `https://eu-assets.i.posthog.com`. */
  assets: string
}

/**
 * Drop the credential headers, keep the rest. Header values that are undefined
 * (h3 hands back a sparse record) are dropped too, so the result is safe to
 * pass straight to fetch.
 */
export function stripSensitiveHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if ((STRIPPED_HEADERS as readonly string[]).includes(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/**
 * Map an incoming `/ingest/...` path onto an upstream URL, preserving the query
 * string. `/ingest/static/**` goes to the assets host, everything else to the
 * ingest host — the same split the two route rules used to make, in the same
 * order (static first).
 */
export function resolveIngestTarget(path: string, targets: IngestProxyTargets): string {
  const rest = path.startsWith(INGEST_PREFIX) ? path.slice(INGEST_PREFIX.length) : path
  const suffix = rest.startsWith('/') ? rest : `/${rest}`
  const isStatic =
    suffix === '/static' || suffix.startsWith('/static/') || suffix.startsWith('/static?')
  const base = isStatic ? targets.assets : targets.ingest
  return `${base.replace(/\/+$/, '')}${suffix}`
}
