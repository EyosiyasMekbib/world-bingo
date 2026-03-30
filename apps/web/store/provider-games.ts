import { defineStore } from 'pinia'

export interface ProviderInfo {
  id: string
  code: string
  name: string
  status: string
  currency: string
}

export interface ProviderGame {
  gameCode: string
  gameName: string
  categoryCode: string
  imageSquare: string | null
  imageLandscape: string | null
  vendorCode: string | null
}

export interface GamesPage {
  data: ProviderGame[]
  total: number
  page: number
  pageSize: number
}

const CATEGORY_ALL = 'ALL'
const CATEGORY_BINGO = 'BINGO'

interface ProviderGamesState {
  providers: ProviderInfo[]
  activeProviderCode: string
  games: ProviderGame[]
  categories: string[]
  activeCategory: string
  searchQuery: string
  page: number
  pageSize: number
  total: number
  loading: boolean
  launching: string | null   // gameCode being launched
  error: string | null
}

export const useProviderGamesStore = defineStore('provider-games', {
  state: (): ProviderGamesState => ({
    providers: [],
    activeProviderCode: '',
    games: [],
    categories: [],
    activeCategory: CATEGORY_ALL,
    searchQuery: '',
    page: 1,
    pageSize: 20,
    total: 0,
    loading: false,
    launching: null,
    error: null,
  }),

  getters: {
    activeProvider: (state): ProviderInfo | null =>
      state.providers.find((p) => p.code === state.activeProviderCode) ?? null,

    hasMore: (state): boolean => state.page * state.pageSize < state.total,

    displayCategories: (state): string[] =>
      [CATEGORY_ALL, CATEGORY_BINGO, ...state.categories.filter((c) => c !== CATEGORY_BINGO)],
  },

  actions: {
    async fetchProviders() {
      const auth = (await import('~/store/auth')).useAuthStore()
      try {
        const data = await auth.apiFetch<ProviderInfo[]>('/providers')
        this.providers = data
        if (data.length > 0 && !this.activeProviderCode) {
          this.activeProviderCode = data[0].code
        }
      } catch (e: any) {
        this.error = e?.message ?? 'Failed to load providers'
      }
    },

    async fetchCategories(providerCode?: string) {
      const code = providerCode ?? this.activeProviderCode
      if (!code) return
      const auth = (await import('~/store/auth')).useAuthStore()
      try {
        const data = await auth.apiFetch<string[]>(`/providers/${code}/categories`)
        this.categories = data
      } catch {
        // Non-fatal — categories may be empty
      }
    },

    async fetchGames(opts: { reset?: boolean; category?: string; page?: number; search?: string } = {}) {
      const code = this.activeProviderCode
      if (!code) return

      if (opts.category !== undefined) this.activeCategory = opts.category
      if (opts.page !== undefined) this.page = opts.page
      if (opts.search !== undefined) this.searchQuery = opts.search
      if (opts.reset) {
        this.games = []
        this.page = 1
      }

      const category = this.activeCategory === CATEGORY_ALL || this.activeCategory === CATEGORY_BINGO
        ? undefined
        : this.activeCategory

      this.loading = true
      this.error = null

      const auth = (await import('~/store/auth')).useAuthStore()
      try {
        const params = new URLSearchParams({
          page: String(this.page),
          pageSize: String(this.pageSize),
        })
        if (category) params.set('category', category)
        if (this.searchQuery) params.set('search', this.searchQuery)

        const result = await auth.apiFetch<GamesPage>(`/providers/${code}/games?${params}`)
        if (opts.reset) {
          this.games = result.data
        } else {
          this.games = [...this.games, ...result.data]
        }
        this.total = result.total
      } catch (e: any) {
        this.error = e?.message ?? 'Failed to load games'
      } finally {
        this.loading = false
      }
    },

    async loadMore() {
      if (!this.hasMore || this.loading) return
      this.page++
      await this.fetchGames()
    },

    async launchGame(providerCode: string, gameCode: string): Promise<string | null> {
      this.launching = gameCode
      const auth = (await import('~/store/auth')).useAuthStore()
      try {
        const origin = typeof window !== 'undefined' ? window.location.origin : ''
        const lobbyUrl = `${origin}/`
        const result = await auth.apiFetch<{ gameUrl: string; token: string }>(
          `/providers/${providerCode}/games/${gameCode}/launch`,
          {
            method: 'POST',
            body: { lobbyUrl, language: 'en', currency: 'ETB' },
          },
        )
        return result.gameUrl
      } catch (e: any) {
        this.error = e?.message ?? 'Failed to launch game'
        return null
      } finally {
        this.launching = null
      }
    },

    setCategory(category: string) {
      this.activeCategory = category
      if (category !== CATEGORY_BINGO) {
        this.fetchGames({ reset: true })
      }
    },
  },
})
