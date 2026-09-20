<script setup lang="ts">
/**
 * Promotions page
 *
 * One full-width promo tile per live offer, each with its progress figures on a
 * line beneath it rather than inside it — the tile may be an uploaded banner,
 * and the 3px rail is the only thing this design ever draws over artwork.
 *
 * Unlike /refer, this page never silently redirects: it shows an empty state
 * when no promotions are live.
 */
import { PromoKind } from '@world-bingo/shared-types'
import type { PublicPromotionDto } from '@world-bingo/shared-types'
import { usePromotionsStore } from '~/store/promotions'

const { t } = useI18n()
const store = usePromotionsStore()
const { referralsEnabled } = useFeatureFlags()

const loading = ref(true)

/**
 * The API ships a referral tile for the lobby carousel, but here Refer & Earn is
 * the plain row below — it is a programme, not an offer with a balance moving
 * towards it, and drawing it twice on one page says the opposite.
 */
const tiles = computed<PublicPromotionDto[]>(() =>
  store.promotions.filter((p) => p.kind !== PromoKind.REFERRAL),
)

const hasPromos = computed(() => tiles.value.length > 0 || referralsEnabled.value)

const figures = (value: number) => value.toLocaleString('en-ET', { maximumFractionDigits: 2 })

/**
 * Each tile with its own progress resolved once, so the template neither calls a
 * lookup three times per row nor asserts away a null it has already tested.
 *
 * `meta` is null when the player has nothing in flight against the offer — an
 * offer with no progress gets no empty line holding space beneath it. The
 * figures carry no unit of their own: `hint` already names the currency
 * ('180 ETB to go'), and the progress DTO has nothing to read for an offer that
 * counts something other than money.
 */
const rows = computed(() =>
  tiles.value.map((promo) => {
    const p = store.progressFor(promo.refId)
    return {
      promo,
      progress: p,
      meta:
        p && p.target > 0
          ? {
              left: p.hint ? `${p.label} · ${p.hint}` : p.label,
              value: `${figures(p.current)} / ${figures(p.target)}`,
            }
          : null,
    }
  }),
)

onMounted(async () => {
  // Progress is authenticated and no-ops when signed out, so the two run
  // together and neither can fail the other.
  await Promise.all([store.fetch(), store.fetchProgress()])
  loading.value = false
})

useHead({ title: 'Promotions — World Bingo' })
</script>

<template>
  <div class="promo-page">
    <!-- Header -->
    <div class="promo-header">
      <h1 class="promo-title">{{ t('promo.title') }}</h1>
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
      <div v-if="rows.length" class="offers">
        <div v-for="row in rows" :key="row.promo.kind + ':' + row.promo.refId" class="offer">
          <PromoTile :promo="row.promo" :progress="row.progress" size="wide" />
          <div v-if="row.meta" class="meta">
            <span class="meta-k">{{ row.meta.left }}</span>
            <span class="meta-v">{{ row.meta.value }}</span>
          </div>
        </div>
      </div>

      <!-- Refer & Earn — a programme, not a promotion, so it stays a plain row -->
      <NuxtLink v-if="referralsEnabled" to="/refer" class="refer-row">
        <span class="refer-icon">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            aria-hidden="true"
          >
            <circle cx="9" cy="8" r="3.4" />
            <path d="M2.8 20a6.4 6.4 0 0 1 12.4 0" stroke-linecap="round" />
            <path
              d="M16.5 5.2a3.4 3.4 0 0 1 0 5.6M18.6 20a6.5 6.5 0 0 0-2.1-4.8"
              stroke-linecap="round"
            />
          </svg>
        </span>
        <span class="refer-text">
          <span class="refer-title">{{ t('promo.refer_title') }}</span>
          <span class="refer-sub">{{ t('promo.refer_text') }}</span>
        </span>
        <svg
          class="refer-chev"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </NuxtLink>
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
  gap: 1.25rem;
}

/* ── Header ── */
.promo-header { display: flex; flex-direction: column; gap: 0.4rem; }
.promo-title {
  font-family: var(--font-heading, var(--font-ui));
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.3px;
  text-transform: uppercase;
  color: var(--text-primary);
  margin: 0;
}
.promo-subtitle {
  font-size: 0.9rem;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.55;
  text-wrap: pretty;
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
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 0 1.4rem;
  border-radius: 8px;
  text-decoration: none;
}

/* ── Offers — one wide tile each, figures on the line beneath ── */
.offers { display: flex; flex-direction: column; gap: 14px; }
.offer { display: flex; flex-direction: column; gap: 6px; }

.meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 0 3px;
}
/* 12px rather than the artboard's 11.5/12.5: both halves are body text and have
   to clear the floor, and a matched size keeps the baseline honest. */
.meta-k {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.4;
  min-width: 0;
}
.meta-v {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.85);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* ── Refer & Earn row ── */
.refer-row {
  display: flex;
  align-items: center;
  gap: 13px;
  min-height: 44px;
  padding: 18px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 16px;
  color: inherit;
  text-decoration: none;
  transition: border-color 0.2s;
}
.refer-row:hover {
  border-color: color-mix(in srgb, var(--brand-primary) 40%, transparent);
}
.refer-icon {
  width: 40px; height: 40px;
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 12px;
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
}
.refer-icon svg { width: 19px; height: 19px; }
.refer-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.refer-title {
  font-family: var(--font-ui);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--text-primary);
}
.refer-sub {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.45;
}
.refer-chev {
  width: 17px; height: 17px;
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.55);
}
</style>
