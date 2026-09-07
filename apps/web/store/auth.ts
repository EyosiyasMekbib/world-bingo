import { defineStore } from 'pinia'
import type { LoginDto, RegisterDto, User, Wallet, TelegramAuthDto } from '@world-bingo/shared-types'
import { isExpiringWithin, TOKEN_REFRESH_MARGIN_MS } from '~/utils/token'

/**
 * The only two answers that mean "this session is over". Anything else — a
 * dropped mobile connection, a 429 behind carrier NAT, a 502 during a deploy —
 * is transient, and treating it as fatal is what put players back on the login
 * screen mid-game.
 */
const SESSION_ENDING_CODES = new Set(['refresh_token_invalid', 'refresh_token_expired'])

/**
 * Whether the shared refresh slot below may be used.
 *
 * `typeof window` is the load-bearing half: under Nitro there is no `window`,
 * and a test can simulate the server by removing it. `import.meta.client` is
 * the Nuxt idiom and is checked with `!== false` because Vitest leaves it
 * undefined — so the browser and jsdom both share, and only SSR does not.
 */
function sharesRefresh(): boolean {
  return typeof window !== 'undefined' && import.meta.client !== false
}

/**
 * Module-level, not per-store-instance: in the browser every caller must await
 * the same request. The lobby alone fires several authenticated calls in
 * parallel, and before this each one refreshed separately — one won, the others
 * got a retired token back and logged the player out.
 *
 * Deliberately NOT shared during SSR. Module scope on the Nitro server is
 * shared by concurrent requests from different users, so a shared promise there
 * would hand one player's freshly minted access token to another player's page.
 * No SSR path reaches a refresh today (`refresh()` returns at its
 * `!this.refreshToken` guard, and every apiFetch call site is in `onMounted` or
 * a handler), so this closes the door before someone opens it — an SSR fetch
 * added later must not silently become a cross-user token leak.
 */
let refreshPromise: Promise<string | null> | null = null

function errorStatus(error: any): number {
  return error?.status ?? error?.statusCode ?? error?.response?.status ?? 0
}

function errorCode(error: any): string | null {
  return error?.data?.code ?? error?.response?._data?.code ?? error?.response?.data?.code ?? null
}

export { SESSION_ENDING_CODES }

interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  wallet: Wallet | null
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    user: null,
    accessToken: null,
    refreshToken: null,
    wallet: null,
  }),

  getters: {
    isAuthenticated: (state: AuthState) => !!state.accessToken || !!state.refreshToken,
    // Backward-compat alias used by some composables
    token: (state: AuthState) => state.accessToken,
  },

  actions: {
    async login(credentials: LoginDto) {
      const config = useRuntimeConfig()
      const { user, accessToken, refreshToken } = await $fetch<{
        user: User
        accessToken: string
        refreshToken: string
      }>(`${config.public.apiBase}/auth/login`, {
        method: 'POST',
        body: credentials,
      })
      this.user = user
      this.accessToken = accessToken
      this.refreshToken = refreshToken
      useAnalytics().identify(user)
      await this.fetchWallet()
    },

    async telegramLogin(payload: TelegramAuthDto) {
      const config = useRuntimeConfig()
      const { user, accessToken, refreshToken } = await $fetch<{
        user: User
        accessToken: string
        refreshToken: string
      }>(`${config.public.apiBase}/auth/telegram`, {
        method: 'POST',
        body: payload,
      })
      this.user = user
      this.accessToken = accessToken
      this.refreshToken = refreshToken
      useAnalytics().identify(user)
      await this.fetchWallet()
    },

    async register(data: RegisterDto) {
      const config = useRuntimeConfig()
      const { user, accessToken, refreshToken } = await $fetch<{
        user: User
        accessToken: string
        refreshToken: string
      }>(`${config.public.apiBase}/auth/register`, {
        method: 'POST',
        body: data,
      })
      this.user = user
      this.accessToken = accessToken
      this.refreshToken = refreshToken
      useAnalytics().identify(user)
      await this.fetchWallet()
    },

    async refresh(): Promise<string | null> {
      if (!this.refreshToken) return null
      const shared = sharesRefresh()
      if (shared && refreshPromise) return refreshPromise

      const config = useRuntimeConfig()
      const token = this.refreshToken

      const pending = (async () => {
        try {
          const { user, accessToken, refreshToken } = await $fetch<{
            user: User
            accessToken: string
            refreshToken: string
          }>(`${config.public.apiBase}/auth/refresh`, {
            method: 'POST',
            body: { refreshToken: token },
          })
          this.user = user
          this.accessToken = accessToken
          this.refreshToken = refreshToken
          return accessToken
        } catch (error: any) {
          const status = errorStatus(error)
          const code = errorCode(error)

          if (code && SESSION_ENDING_CODES.has(code)) {
            this.accessToken = null
            this.refreshToken = null
            this.user = null
            this.wallet = null
            useAnalytics().track('session_expired', { reason: code })
            useAnalytics().reset()
            return null
          }

          // Survivable. Keep the session and let the caller decide — a retry, a
          // spinner, or its own error state.
          useAnalytics().track('session_refresh_failed', { status, transient: true })
          throw error
        } finally {
          // Only clear a slot this call actually wrote. An SSR call never took
          // the slot, so it must not blank out a browser refresh in flight.
          if (shared) refreshPromise = null
        }
      })()

      if (shared) refreshPromise = pending
      return pending
    },

    /**
     * Refresh BEFORE the access token dies, so the parallel-request burst that
     * used to arrive with an expired token never happens. Cheap: a no-op until
     * the token is inside the margin.
     */
    async ensureFreshToken(): Promise<string | null> {
      if (!this.refreshToken) return this.accessToken
      if (!isExpiringWithin(this.accessToken, TOKEN_REFRESH_MARGIN_MS)) return this.accessToken
      try {
        return await this.refresh()
      } catch {
        // Transient: keep the current token and let the request try it.
        return this.accessToken
      }
    },

    clearStoredUser() {
      useAnalytics().reset()
      this.user = null
      this.accessToken = null
      this.refreshToken = null
      this.wallet = null
    },

    async logout() {
      const config = useRuntimeConfig()
      if (this.refreshToken) {
        try {
          await $fetch(`${config.public.apiBase}/auth/logout`, {
            method: 'POST',
            body: { refreshToken: this.refreshToken },
          })
        } catch {
          // ignore
        }
      }
      useAnalytics().reset()
      this.user = null
      this.accessToken = null
      this.refreshToken = null
      this.wallet = null
    },

    async fetchWallet() {
      try {
        const wallet = await this.apiFetch<Wallet>('/wallet')
        this.wallet = wallet
      } catch (e) {
        console.error('Failed to fetch wallet:', e)
      }
    },

    /**
     * Authenticated fetch — auto-refreshes on 401.
     */
    async apiFetch<T = unknown>(url: string, options: any = {}): Promise<T> {
      const config = useRuntimeConfig()

      const doFetch = (token: string) =>
        $fetch<T>(`${config.public.apiBase}${url}`, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${token}`,
          },
        })

      // Proactive: refresh while the old token is still valid, so a burst of
      // parallel calls never races on an expired one.
      const token = (await this.ensureFreshToken()) ?? this.accessToken
      if (!token) {
        const refreshed = await this.refresh()
        if (!refreshed) throw new Error('Not authenticated')
        return doFetch(refreshed)
      }

      try {
        return await doFetch(token)
      } catch (error: any) {
        const status = error?.status ?? error?.statusCode ?? error?.response?.status
        if (status !== 401) throw error

        // Reactive fallback: the server rejected a token we thought was fine.
        // A failed refresh throws for transient causes and returns null only
        // when the session is genuinely over.
        const newToken = await this.refresh()
        if (!newToken) throw new Error('Session expired')
        return doFetch(newToken)
      }
    },
  },
  // @ts-ignore
  persist: true,
})

export const useAuth = () => useAuthStore()

