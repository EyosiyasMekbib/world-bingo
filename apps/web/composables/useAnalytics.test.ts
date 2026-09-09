import { describe, it, expect, vi, beforeEach } from 'vitest'

// Node 22+'s built-in `localStorage`/`sessionStorage` globals (stable under
// --experimental-webstorage) shadow jsdom's working implementation with a
// stub that lacks .clear()/.setItem() unless --localstorage-file is set.
// Vitest's jsdom environment inherits that broken global as-is (window.localStorage
// is the very same stub), so it must be swapped for a real in-memory Storage
// here before any test touches it. Guarded so it's a no-op on Node builds
// where jsdom's own Storage already works.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() {
    return this.store.size
  }
  clear() {
    this.store.clear()
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string) {
    this.store.delete(key)
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value))
  }
}
for (const key of ['localStorage', 'sessionStorage'] as const) {
  const existing = (globalThis as any)[key]
  if (!existing || typeof existing.clear !== 'function') {
    Object.defineProperty(globalThis, key, { value: new MemoryStorage(), configurable: true })
  }
}

const ph = { capture: vi.fn(), identify: vi.fn(), reset: vi.fn() }
let installed: typeof ph | null = ph
vi.stubGlobal('useNuxtApp', () => ({ $posthog: installed }))
vi.stubGlobal('useRuntimeConfig', () => ({
  public: { apiBase: '/api', posthog: { brand: 'arada' } },
}))
vi.stubGlobal('useBrand', () => ({ value: { shortName: 'Arada' } }))
const fetchMock = vi.fn().mockResolvedValue({ ok: true })
vi.stubGlobal('fetch', fetchMock)

import { useAnalytics } from './useAnalytics'

const user = { id: 'u-1', serial: 9, telegramId: null, createdAt: '2026-05-01T00:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  installed = ph
  localStorage.clear()
  sessionStorage.clear()
})

describe('track', () => {
  it('forwards any event name to PostHog', () => {
    useAnalytics().track('brand_new_event', { a: 1 })
    expect(ph.capture).toHaveBeenCalledWith('brand_new_event', { a: 1 })
  })

  it('still only queues allowlisted names for the /events sink', async () => {
    const { track, flush } = useAnalytics()
    track('brand_new_event')
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    track('lobby_view')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.events).toEqual([{ name: 'lobby_view', props: null }])
  })

  it('accepts games_lobby_view for the /events sink', async () => {
    const { track, flush } = useAnalytics()
    track('games_lobby_view')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not throw when PostHog is not installed', () => {
    installed = null
    expect(() => useAnalytics().track('lobby_view')).not.toThrow()
  })
})

describe('identify', () => {
  it('identifies in PostHog with person props and posts the anon link', () => {
    localStorage.setItem('wb_anon_id', 'anon-1')
    useAnalytics().identify(user)
    expect(ph.identify).toHaveBeenCalledWith('u-1', {
      serial: 9,
      brand: 'arada',
      signup_method: 'phone',
      created_at: '2026-05-01T00:00:00.000Z',
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/events/identify', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).anonId).toBe('anon-1')
  })

  it('skips PostHog when no user is given but still links the anon id', () => {
    localStorage.setItem('wb_anon_id', 'anon-2')
    useAnalytics().identify(null)
    expect(ph.identify).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('reset', () => {
  it('resets PostHog and rotates the anonymous id', () => {
    localStorage.setItem('wb_anon_id', 'anon-old')
    sessionStorage.setItem('wb_session_id', 'sess-old')
    useAnalytics().reset()
    expect(ph.reset).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('wb_anon_id')).toBeNull()
    expect(sessionStorage.getItem('wb_session_id')).toBeNull()
  })
})

describe('track with { instant: true }', () => {
  // deposit_checkout_redirect is tracked a few milliseconds before
  // window.location.assign(). Batched capture lost every one of them (0 of
  // 174 checkouts in 14 hours). PostHog's send_instantly bypasses the batch.
  it('asks PostHog to send the event immediately', () => {
    installed = ph
    ph.capture.mockClear()
    useAnalytics().track('deposit_checkout_redirect', { ms: 12 }, { instant: true })
    expect(ph.capture).toHaveBeenCalledWith('deposit_checkout_redirect', { ms: 12 }, { send_instantly: true })
  })

  it('leaves ordinary tracking batched', () => {
    installed = ph
    ph.capture.mockClear()
    useAnalytics().track('lobby_view', { a: 1 })
    expect(ph.capture).toHaveBeenCalledWith('lobby_view', { a: 1 })
  })
})
