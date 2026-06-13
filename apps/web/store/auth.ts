import { defineStore } from 'pinia'
import type { LoginDto, RegisterDto, User, Wallet, TelegramAuthDto } from '@world-bingo/shared-types'

function sendIdentify(apiBase: string) {
    if (typeof localStorage === 'undefined') return
    const anonId = localStorage.getItem('wb_anon_id')
    const sessionId = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('wb_session_id') : null
    if (!anonId) return
    fetch(`${apiBase}/events/identify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anonId, sessionId }),
    }).catch(() => {})
}

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
      sendIdentify(config.public.apiBase as string)
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
      sendIdentify(config.public.apiBase as string)
      await this.fetchWallet()
    },

    async refresh(): Promise<string | null> {
      if (!this.refreshToken) return null
      const config = useRuntimeConfig()
      try {
        const { user, accessToken, refreshToken } = await $fetch<{
          user: User
          accessToken: string
          refreshToken: string
        }>(`${config.public.apiBase}/auth/refresh`, {
          method: 'POST',
          body: { refreshToken: this.refreshToken },
        })
        this.user = user
        this.accessToken = accessToken
        this.refreshToken = refreshToken
        return accessToken
      } catch {
        this.accessToken = null
        this.refreshToken = null
        this.user = null
        return null
      }
    },

    clearStoredUser() {
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

      if (!this.accessToken) {
        const newToken = await this.refresh()
        if (!newToken) throw new Error('Not authenticated')
        return doFetch(newToken)
      }

      try {
        return await doFetch(this.accessToken)
      } catch (error: any) {
        const status = error?.status ?? error?.statusCode ?? error?.response?.status
        if (status === 401) {
          const newToken = await this.refresh()
          if (!newToken) {
            await this.logout()
            throw new Error('Session expired')
          }
          return doFetch(newToken)
        }
        throw error
      }
    },
  },
  // @ts-ignore
  persist: true,
})

export const useAuth = () => useAuthStore()

