// Node 25 exposes its own inert localStorage/sessionStorage globals that shadow
// jsdom's; without this the persisted store silently reads back nothing.
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

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const track = vi.fn()
const reset = vi.fn()
vi.stubGlobal('useAnalytics', () => ({ track, reset, identify: vi.fn(), flush: vi.fn() }))
vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: '/api' } }))

const $fetch = vi.fn()
vi.stubGlobal('$fetch', $fetch)

import { useAuthStore } from './auth'
import { TOKEN_REFRESH_MARGIN_MS } from '~/utils/token'

function jwt(secondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `h.${payload}.s`
}

function httpError(status: number, code?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    statusCode: status,
    data: code ? { code } : undefined,
    response: { status, _data: code ? { code } : undefined },
  })
}

let store: ReturnType<typeof useAuthStore>

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  store = useAuthStore()
  store.user = { id: 'u-1', serial: 1, createdAt: new Date().toISOString() } as any
  store.accessToken = jwt(600)
  store.refreshToken = 'rt-1'
})

describe('refresh — single flight', () => {
  it('issues ONE network call for five concurrent callers', async () => {
    $fetch.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ user: store.user, accessToken: jwt(900), refreshToken: 'rt-2' }), 10),
        ),
    )
    const results = await Promise.all([
      store.refresh(),
      store.refresh(),
      store.refresh(),
      store.refresh(),
      store.refresh(),
    ])
    expect($fetch).toHaveBeenCalledTimes(1)
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBeTruthy()
  })

  it('allows a fresh attempt after the previous one settles', async () => {
    $fetch.mockResolvedValue({ user: store.user, accessToken: jwt(900), refreshToken: 'rt-2' })
    await store.refresh()
    await store.refresh()
    expect($fetch).toHaveBeenCalledTimes(2)
  })
})

describe('refresh — what ends a session', () => {
  it('clears the session on refresh_token_invalid and reports the reason', async () => {
    $fetch.mockRejectedValue(httpError(401, 'refresh_token_invalid'))
    expect(await store.refresh()).toBeNull()
    expect(store.accessToken).toBeNull()
    expect(store.user).toBeNull()
    expect(track).toHaveBeenCalledWith('session_expired', { reason: 'refresh_token_invalid' })
  })

  it('clears the session on refresh_token_expired', async () => {
    $fetch.mockRejectedValue(httpError(401, 'refresh_token_expired'))
    expect(await store.refresh()).toBeNull()
    expect(store.user).toBeNull()
  })

  it('KEEPS the session on a network error', async () => {
    $fetch.mockRejectedValue(new Error('Failed to fetch'))
    await expect(store.refresh()).rejects.toThrow('Failed to fetch')
    expect(store.accessToken).not.toBeNull()
    expect(store.user).not.toBeNull()
    expect(track).toHaveBeenCalledWith('session_refresh_failed', { status: 0, transient: true })
  })

  it('KEEPS the session on 429', async () => {
    $fetch.mockRejectedValue(httpError(429))
    await expect(store.refresh()).rejects.toBeTruthy()
    expect(store.user).not.toBeNull()
  })

  it('KEEPS the session on 500 and on a 401 with no code', async () => {
    $fetch.mockRejectedValue(httpError(500))
    await expect(store.refresh()).rejects.toBeTruthy()
    expect(store.user).not.toBeNull()

    $fetch.mockRejectedValue(httpError(401))
    await expect(store.refresh()).rejects.toBeTruthy()
    expect(store.user).not.toBeNull()
  })
})

describe('ensureFreshToken', () => {
  it('refreshes when inside the margin', async () => {
    store.accessToken = jwt(Math.floor(TOKEN_REFRESH_MARGIN_MS / 1000) - 30)
    $fetch.mockResolvedValue({ user: store.user, accessToken: jwt(900), refreshToken: 'rt-2' })
    await store.ensureFreshToken()
    expect($fetch).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the token has plenty of life', async () => {
    store.accessToken = jwt(900)
    await store.ensureFreshToken()
    expect($fetch).not.toHaveBeenCalled()
  })
})
