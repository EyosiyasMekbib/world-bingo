<script setup lang="ts">
import { usePromotionsStore } from '~/store/promotions'

const { t } = useI18n()
const store = usePromotionsStore()
</script>

<template>
  <div
    v-if="store.firstDepositBonus"
    class="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
  >
    <span aria-hidden="true">🎁</span>
    <span>{{ t('promo.first_deposit', { amount: store.firstDepositBonus }) }}</span>
  </div>
</template>
