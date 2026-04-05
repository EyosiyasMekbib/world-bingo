<script setup lang="ts">
import { usePromotionsStore } from '~/store/promotions'

const { t } = useI18n()
const store = usePromotionsStore()

const cashbackText = computed(() => {
  const c = store.cashback
  if (!c) return ''
  const freq = t(`promo.frequency_${c.frequency.toLowerCase()}`)
  if (c.refundType === 'PERCENTAGE') {
    return t('promo.cashback_percentage', { value: c.refundValue, frequency: freq })
  }
  return t('promo.cashback_fixed', { value: c.refundValue, frequency: freq })
})
</script>

<template>
  <div
    v-if="store.cashback"
    class="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
  >
    <span aria-hidden="true">💰</span>
    <span>{{ cashbackText }}</span>
  </div>
</template>
