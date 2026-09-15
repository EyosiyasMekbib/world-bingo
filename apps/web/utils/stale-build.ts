/**
 * Remembers which build failed to load a chunk, so a page of that build that
 * the browser later restores from its back/forward cache reloads instead of
 * failing again.
 *
 * Nuxt's `emitRouteChunkError: 'automatic-immediate'` already reloads the tab
 * that hit the 404. It cannot reach the page left behind in history: on
 * 2026-09-11 a player pressed Back from a quick game to /games eight times in
 * a minute, and every Back resumed the same pre-deploy /games document, whose
 * next click asked for the same deleted chunk. No new pageview was recorded
 * between them, so the page came back intact rather than being fetched again.
 *
 * The record lives in sessionStorage (per tab, survives reloads) and guards
 * itself: one forced reload per stale build per STALE_RELOAD_GUARD_MS.
 * Never throws.
 */
export const STALE_BUILD_KEY = 'wb:stale-build'

/** Matches the TTL reloadNuxtApp uses for its own loop guard. */
export const STALE_RELOAD_GUARD_MS = 10_000

interface StaleBuildRecord {
  buildId: string
  reloadedAt: number | null
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function readRecord(storage: StorageLike): StaleBuildRecord | null {
  try {
    const parsed = JSON.parse(storage.getItem(STALE_BUILD_KEY) ?? 'null')
    if (!parsed || typeof parsed.buildId !== 'string') return null
    const reloadedAt = typeof parsed.reloadedAt === 'number' ? parsed.reloadedAt : null
    return { buildId: parsed.buildId, reloadedAt }
  } catch {
    return null
  }
}

function writeRecord(storage: StorageLike, record: StaleBuildRecord): boolean {
  try {
    storage.setItem(STALE_BUILD_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

/** Reading `window.sessionStorage` throws when site data is blocked. */
export function resolveSessionStorage(win: Window): StorageLike | null {
  try {
    return win.sessionStorage ?? null
  } catch {
    return null
  }
}

/** Record that `buildId` references chunks the server no longer has. */
export function markBuildStale(storage: StorageLike | null, buildId: string): void {
  if (!storage || !buildId) return
  // Same build again: keep reloadedAt, or the guard would reset on every error.
  if (readRecord(storage)?.buildId === buildId) return
  writeRecord(storage, { buildId, reloadedAt: null })
}

/**
 * True when a restored page running `buildId` should reload now. Claims the
 * reload by writing its timestamp first; if that write fails it refuses, so a
 * store that cannot hold the guard cannot produce a reload loop.
 */
export function claimStaleReload(
  storage: StorageLike | null,
  buildId: string,
  now: number,
): boolean {
  if (!storage || !buildId) return false
  const record = readRecord(storage)
  if (!record || record.buildId !== buildId) return false
  if (record.reloadedAt !== null && now - record.reloadedAt < STALE_RELOAD_GUARD_MS) return false
  return writeRecord(storage, { buildId, reloadedAt: now })
}
