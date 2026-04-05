import { defineStore } from 'pinia'

interface CashbackPromo {
  name: string
  refundType: 'PERCENTAGE' | 'FIXED'
  refundValue: number
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
}

interface PromotionsState {
  cashback: CashbackPromo | null
  firstDepositBonus: number | null
}

export const usePromotionsStore = defineStore('promotions', {
  state: (): PromotionsState => ({
    cashback: null,
    firstDepositBonus: null,
  }),
  actions: {
    async fetch() {
      const config = useRuntimeConfig()
      try {
        const data = await $fetch<{ cashback: CashbackPromo | null; firstDepositBonus: number | null }>(
          `${config.public.apiBase}/promotions`,
        )
        this.cashback = data.cashback
        this.firstDepositBonus = data.firstDepositBonus
      } catch {
        // silently ignore — banners remain hidden
      }
    },
  },
})
