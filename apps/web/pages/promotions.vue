<script setup lang="ts">
/**
 * Promotions page
 *
 * Surfaces the active player offers (cashback, first-deposit bonus) sourced
 * from the promotions store, plus an optional Refer & Earn entry point when
 * the referrals feature is enabled. Unlike /refer, this page never silently
 * redirects — it shows an empty state when no promotions are live.
 */
import { usePromotionsStore } from '~/store/promotions'

const { t } = useI18n()
const store = usePromotionsStore()
const { referralsEnabled } = useFeatureFlags()

const loading = ref(true)

const cashbackText = computed(() => {
  const c = store.cashback
  if (!c) return ''
  const freq = t(`promo.frequency_${c.frequency.toLowerCase()}`)
  if (c.refundType === 'PERCENTAGE') {
    return t('promo.cashback_percentage', { value: c.refundValue, frequency: freq })
  }
  return t('promo.cashback_fixed', { value: c.refundValue, frequency: freq })
})

const hasPromos = computed(
  () => !!store.cashback || !!store.firstDepositBonus || referralsEnabled.value,
)

onMounted(async () => {
  await store.fetch()
  loading.value = false
})

useHead({ title: 'Promotions — World Bingo' })
</script>

<template>
  <div class="promo-page">
    <!-- Header -->
    <div class="promo-header">
      <h1 class="promo-title">🎉 {{ t('promo.title') }}</h1>
      <p class="promo-subtitle">{{ t('promo.subtitle') }}</p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="state-message">
      <span class="spinner-lg" />
      {{ t('promo.loading') }}
    </div>

    <!-- Empty state — never redirects away -->
    <div v-else-if="!hasPromos" class="empty-box">
      <div class="empty-icon">🎁</div>
      <p>{{ t('promo.empty') }}</p>
      <NuxtLink to="/games" class="empty-cta">{{ t('promo.browse_games') }}</NuxtLink>
    </div>

    <template v-else>
      <div class="promo-grid">
        <!-- First deposit bonus -->
        <div v-if="store.firstDepositBonus" class="promo-card promo-card--hero">
          <div class="promo-card-orb" />
          <div class="promo-card-ghost">BONUS</div>
          <div class="promo-card-body">
            <span class="promo-kicker">{{ t('promo.welcome_offer') }}</span>
            <h2 class="promo-card-title">
              {{ t('promo.first_deposit', { amount: store.firstDepositBonus }) }}
            </h2>
            <NuxtLink to="/wallet" class="promo-card-cta">{{ t('promo.deposit_now') }}</NuxtLink>
          </div>
        </div>

        <!-- Cashback -->
        <div v-if="store.cashback" class="promo-card">
          <div class="promo-card-icon">💰</div>
          <h2 class="promo-card-h">{{ store.cashback.name || t('promo.cashback_title') }}</h2>
          <p class="promo-card-text">{{ cashbackText }}</p>
        </div>

        <!-- Refer & Earn -->
        <div v-if="referralsEnabled" class="promo-card">
          <div class="promo-card-icon">👥</div>
          <h2 class="promo-card-h">{{ t('promo.refer_title') }}</h2>
          <p class="promo-card-text">{{ t('promo.refer_text') }}</p>
          <NuxtLink to="/refer" class="promo-card-link">{{ t('promo.refer_cta') }} →</NuxtLink>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.promo-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 1.75rem 1.5rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Header ── */
.promo-header { display: flex; flex-direction: column; gap: 0.4rem; }
.promo-title {
  font-family: var(--font-ui);
  font-size: 1.7rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-primary);
  margin: 0;
}
.promo-subtitle {
  font-size: 0.9rem;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.55;
}

/* ── Loading ── */
.state-message {
  display: flex; align-items: center; gap: 0.75rem;
  color: var(--text-secondary);
  padding: 3rem 0; justify-content: center; font-size: 0.95rem;
}
.spinner-lg {
  width: 18px; height: 18px;
  border: 2px solid rgba(255,255,255,0.1);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Empty ── */
.empty-box {
  display: flex; flex-direction: column; align-items: center; gap: 0.75rem;
  text-align: center;
  padding: 3rem 1.5rem;
  color: var(--text-secondary);
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
}
.empty-icon { font-size: 2rem; }
.empty-cta {
  margin-top: 0.5rem;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 0.6rem 1.4rem;
  border-radius: 8px;
  text-decoration: none;
}

/* ── Grid ── */
.promo-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}

.promo-card {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  padding: 1.25rem;
  display: flex; flex-direction: column; gap: 0.5rem;
  transition: border-color 0.2s, transform 0.2s;
}
.promo-card:hover {
  border-color: color-mix(in srgb, var(--brand-primary) 40%, transparent);
  transform: translateY(-2px);
}
.promo-card-icon { font-size: 1.5rem; line-height: 1; }
.promo-card-h {
  font-family: var(--font-ui);
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}
.promo-card-text {
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0;
}
.promo-card-link {
  margin-top: auto;
  color: var(--brand-primary);
  font-weight: 700;
  font-size: 0.85rem;
  text-decoration: none;
}
.promo-card-link:hover { text-decoration: underline; }

/* ── Hero card (first-deposit) — echoes the lobby hero slide ── */
.promo-card--hero {
  position: relative;
  grid-column: 1 / -1;
  background: linear-gradient(105deg, #071633 0%, #0d2a5c 50%, #143b86 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-lg, 16px);
  overflow: hidden;
  min-height: 150px;
  box-shadow: var(--shadow-card, 0 4px 24px rgba(0, 0, 0, 0.4));
}
.promo-card-orb {
  position: absolute;
  right: -50px; top: -70px;
  width: 280px; height: 280px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--brand-primary) 24%, transparent), transparent 70%);
}
.promo-card-ghost {
  position: absolute;
  right: 28px; bottom: 4px;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 90px;
  color: rgba(255, 255, 255, 0.05);
  line-height: 0.8;
  pointer-events: none;
}
.promo-card-body { position: relative; padding: 0.25rem; max-width: 460px; }
.promo-kicker {
  display: inline-block;
  background: color-mix(in srgb, var(--brand-primary) 18%, transparent);
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  padding: 4px 10px;
  border-radius: 16px;
  margin-bottom: 10px;
}
.promo-card-title {
  font-family: var(--font-heading, var(--font-ui));
  font-weight: 700;
  font-size: clamp(20px, 3vw, 28px);
  line-height: 1.1;
  color: #fff;
  margin: 0 0 14px;
  text-wrap: balance;
}
.promo-card-cta {
  display: inline-block;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.9rem;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 9px 22px;
  border-radius: 8px;
  text-decoration: none;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--brand-primary) 38%, transparent);
}
</style>
