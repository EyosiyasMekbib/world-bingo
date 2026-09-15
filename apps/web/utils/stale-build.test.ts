// Node 25 exposes its own inert localStorage/sessionStorage globals that shadow
// jsdom's; without this the guard silently reads back nothing.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const existing = (globalThis as Record<string, any>)[name]
  if (!existing || typeof existing.clear !== 'function') {
    const store = new Map<string, string>()
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: unknown) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size
        },
      },
    })
  }
}

import { describe, it, expect, beforeEach } from 'vitest'
import {
  STALE_BUILD_KEY,
  STALE_RELOAD_GUARD_MS,
  claimStaleReload,
  markBuildStale,
  resolveSessionStorage,
} from './stale-build'

// A page restored from the back/forward cache after a deploy is still the old
// build: a player bounced between /games and a quick game eight times in a
// minute on 2026-09-11, every Back landing on the same deleted chunk. The
// guard remembers which build failed and reloads a restored copy of it, once.

beforeEach(() => {
  sessionStorage.clear()
})

describe('markBuildStale', () => {
  it('records the build that failed to load a chunk', () => {
    markBuildStale(sessionStorage, 'build-a')
    expect(JSON.parse(sessionStorage.getItem(STALE_BUILD_KEY)!)).toEqual({
      buildId: 'build-a',
      reloadedAt: null,
    })
  })

  it('keeps the reload timestamp when the same build fails again', () => {
    markBuildStale(sessionStorage, 'build-a')
    expect(claimStaleReload(sessionStorage, 'build-a', 1_000)).toBe(true)
    markBuildStale(sessionStorage, 'build-a')
    expect(claimStaleReload(sessionStorage, 'build-a', 2_000)).toBe(false)
  })

  it('replaces the record when a different build fails', () => {
    markBuildStale(sessionStorage, 'build-a')
    claimStaleReload(sessionStorage, 'build-a', 1_000)
    markBuildStale(sessionStorage, 'build-b')
    expect(JSON.parse(sessionStorage.getItem(STALE_BUILD_KEY)!)).toEqual({
      buildId: 'build-b',
      reloadedAt: null,
    })
  })

  it('does nothing without storage or a build id', () => {
    expect(() => markBuildStale(null, 'build-a')).not.toThrow()
    markBuildStale(sessionStorage, '')
    expect(sessionStorage.getItem(STALE_BUILD_KEY)).toBeNull()
  })
})

describe('claimStaleReload', () => {
  it('refuses when no build was marked stale', () => {
    expect(claimStaleReload(sessionStorage, 'build-a', 1_000)).toBe(false)
  })

  it('refuses for a build other than the one marked stale', () => {
    markBuildStale(sessionStorage, 'build-a')
    expect(claimStaleReload(sessionStorage, 'build-b', 1_000)).toBe(false)
  })

  it('allows one reload of the stale build, then holds inside the guard window', () => {
    markBuildStale(sessionStorage, 'build-a')
    expect(claimStaleReload(sessionStorage, 'build-a', 1_000)).toBe(true)
    expect(claimStaleReload(sessionStorage, 'build-a', 1_000 + STALE_RELOAD_GUARD_MS - 1)).toBe(
      false,
    )
  })

  it('allows another reload once the guard window has passed', () => {
    markBuildStale(sessionStorage, 'build-a')
    expect(claimStaleReload(sessionStorage, 'build-a', 1_000)).toBe(true)
    expect(claimStaleReload(sessionStorage, 'build-a', 1_000 + STALE_RELOAD_GUARD_MS)).toBe(true)
  })

  it('ignores a corrupt record instead of throwing', () => {
    sessionStorage.setItem(STALE_BUILD_KEY, '{not json')
    expect(claimStaleReload(sessionStorage, 'build-a', 1_000)).toBe(false)
    sessionStorage.setItem(STALE_BUILD_KEY, JSON.stringify({ buildId: 42 }))
    expect(claimStaleReload(sessionStorage, 'build-a', 1_000)).toBe(false)
  })

  it('refuses when the guard cannot be written, so a blocked store cannot loop', () => {
    const readOnly = {
      getItem: () => JSON.stringify({ buildId: 'build-a', reloadedAt: null }),
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(claimStaleReload(readOnly, 'build-a', 1_000)).toBe(false)
  })

  it('refuses without storage or a build id', () => {
    expect(claimStaleReload(null, 'build-a', 1_000)).toBe(false)
    markBuildStale(sessionStorage, 'build-a')
    expect(claimStaleReload(sessionStorage, '', 1_000)).toBe(false)
  })
})

describe('resolveSessionStorage', () => {
  it('returns the window session storage', () => {
    expect(resolveSessionStorage({ sessionStorage } as unknown as Window)).toBe(sessionStorage)
  })

  it('returns null when reading session storage throws', () => {
    const blocked = Object.defineProperty({}, 'sessionStorage', {
      get() {
        throw new Error('SecurityError')
      },
    })
    expect(resolveSessionStorage(blocked as Window)).toBeNull()
  })
})
