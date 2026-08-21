import { defineStore } from 'pinia'

interface CashbackPromo {
  name: string
  refundType: 'PERCENTAGE' | 'FIXED'
  refundValue: number
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
}

interface DepositBonusPromo {
  name: string
  type: 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT'
  threshold: number
  rewardType: 'FIXED' | 'PERCENTAGE'
  rewardValue: number
  maxReward: number | null
  validityHours: number
}

interface PromotionsState {
  cashback: CashbackPromo | null
  firstDepositBonus: number | null
  dailyDepositBonus: DepositBonusPromo | null
  weeklyDepositBonus: DepositBonusPromo | null
}

export const usePromotionsStore = defineStore('promotions', {
  state: (): PromotionsState => ({
    cashback: null,
    firstDepositBonus: null,
    dailyDepositBonus: null,
    weeklyDepositBonus: null,
  }),
  actions: {
    async fetch() {
      const config = useRuntimeConfig()
      try {
        const data = await $fetch<{
          cashback: CashbackPromo | null
          firstDepositBonus: number | null
          dailyDepositBonus: DepositBonusPromo | null
          weeklyDepositBonus: DepositBonusPromo | null
        }>(`${config.public.apiBase}/promotions`)
        this.cashback = data.cashback
        this.firstDepositBonus = data.firstDepositBonus
        this.dailyDepositBonus = data.dailyDepositBonus
        this.weeklyDepositBonus = data.weeklyDepositBonus
      } catch {
        // silently ignore — banners remain hidden
      }
    },
  },
})
