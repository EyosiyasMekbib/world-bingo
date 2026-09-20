import { defineStore } from 'pinia'
import type {
  CashbackPromoSummary,
  DepositBonusSummary,
  PromotionProgressDto,
  PromotionsPayload,
  PublicPromotionDto,
} from '@world-bingo/shared-types'
import { useAuthStore } from './auth'

interface PromotionsState {
  promotions: PublicPromotionDto[]
  progress: PromotionProgressDto[]
  cashback: CashbackPromoSummary | null
  firstDepositBonus: number | null
  dailyDepositBonus: DepositBonusSummary | null
  weeklyDepositBonus: DepositBonusSummary | null
}

export const usePromotionsStore = defineStore('promotions', {
  state: (): PromotionsState => ({
    promotions: [],
    progress: [],
    cashback: null,
    firstDepositBonus: null,
    dailyDepositBonus: null,
    weeklyDepositBonus: null,
  }),

  getters: {
    /**
     * A promotion's own progress, or null. Keyed on `refId` alone: the ids are a
     * CashbackPromotion id, a BonusRule id, or the literals 'welcome' and
     * 'referral', none of which collide across kinds.
     */
    progressFor: (state: PromotionsState) => {
      return (refId: string): PromotionProgressDto | null =>
        state.progress.find((p) => p.refId === refId) ?? null
    },
  },

  actions: {
    async fetch() {
      const config = useRuntimeConfig()
      try {
        const data = await $fetch<PromotionsPayload>(`${config.public.apiBase}/promotions`)
        // Defaulted, not assumed: the four legacy fields predate the tile list,
        // so a deployment still running the older API answers without it and
        // must keep its deposit hints rather than lose them to an undefined.
        this.promotions = data.promotions ?? []
        this.cashback = data.cashback
        this.firstDepositBonus = data.firstDepositBonus
        this.dailyDepositBonus = data.dailyDepositBonus
        this.weeklyDepositBonus = data.weeklyDepositBonus
      } catch {
        // silently ignore — banners and tiles remain hidden
      }
    },

    /**
     * Per-player progress for the tiles. Separate from `fetch` because that one
     * is public and cacheable; this one never is, and a signed-out visitor has
     * no progress to ask for.
     */
    async fetchProgress() {
      const auth = useAuthStore()
      if (!auth.isAuthenticated) return
      try {
        const body = await auth.apiFetch<PromotionProgressDto[] | { progress: PromotionProgressDto[] }>(
          '/promotions/me',
        )
        this.progress = Array.isArray(body) ? body : (body?.progress ?? [])
      } catch {
        // A failed progress call must leave the tiles standing without their
        // bars, never blank them: the offers are still real.
      }
    },
  },
})
