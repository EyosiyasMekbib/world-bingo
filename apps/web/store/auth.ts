import { defineStore } from 'pinia'
import type { LoginDto, RegisterDto, User, Wallet } from '@world-bingo/shared-types'

interface AuthState {
  user: User | null
  token: string | null
  wallet: Wallet | null
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    user: null,
    token: null,
    wallet: null
  }),
  
  getters: {
    isAuthenticated: (state: AuthState) => !!state.token,
  },

  actions: {
    async login(credentials: LoginDto) {
      // @ts-ignore
      const self = this as AuthState & typeof this
      const config = useRuntimeConfig()
      try {
        const { user, token } = await $fetch<{ user: User, token: string }>(`${config.public.apiBase}/auth/login`, {
          method: 'POST',
          body: credentials
        })
        self.user = user
        self.token = token
        // Fetch wallet after login
        await self.fetchWallet()
      } catch (e) {
        throw e
      }
    },

    async register(data: RegisterDto) {
      // @ts-ignore
      const self = this as AuthState & typeof this
      const config = useRuntimeConfig()
      try {
        const { user, token } = await $fetch<{ user: User, token: string }>(`${config.public.apiBase}/auth/register`, {
          method: 'POST',
          body: data
        })
        self.user = user
        self.token = token
        await self.fetchWallet()
      } catch (e) {
        throw e
      }
    },

    async fetchWallet() {
       // @ts-ignore
       const self = this as AuthState & typeof this
       if (!self.token) return
       const config = useRuntimeConfig()
       try {
           const wallet = await $fetch<Wallet>(`${config.public.apiBase}/wallet`, {
               headers: { Authorization: `Bearer ${self.token}` }
           })
           self.wallet = wallet
       } catch (e) {
           console.error(e)
       }
    },
    
    logout() {
        this.user = null
        this.token = null
        this.wallet = null
    }
  },
  // @ts-ignore
  persist: true 
})

export const useAuth = () => useAuthStore()
