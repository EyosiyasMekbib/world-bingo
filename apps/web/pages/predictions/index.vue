<script setup lang="ts">
/**
 * The fight card.
 *
 * One row per bout, grouped by discipline, because that is how a card is read:
 * MMA headlines it, Boxing fills the middle, Muay Thai closes the undercard. The
 * grouping is derived from each market's description — there is no discipline
 * column — and anything unrecognized falls into its own group rather than
 * vanishing from the card.
 *
 * Prices show as birr AND percent side by side ('35 ETB (35%)'). Both numbers
 * come from the market's own `shareValue`; nothing here assumes 100, even though
 * the default is 100 and that is precisely why the two read the same.
 */
import {
  boutMetaOf,
  DISCIPLINE_ORDER,
  formatAmount,
  percentOfShare,
  usePredictionStore,
  type DisciplineKey,
  type PredictionMarketSummary,
} from '~/store/prediction'

const { t } = useI18n()
const store = usePredictionStore()
const { flags, loaded } = useFeatureFlags()

const predictionsEnabled = computed(() => flags.value.feature_prediction_market === true)

// Only redirect once the flags have actually landed — they default to false
// while in flight, and bouncing the player home on a slow request would make the
// whole feature look broken.
watch(
  [loaded, predictionsEnabled],
  ([flagsLoaded, enabled]) => {
    if (flagsLoaded && !enabled) navigateTo('/')
  },
  { immediate: true },
)

// ── Countdown ───────────────────────────────────────────────────────────────

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null

const MINUTE_MS = 60_000
const HOUR_MINUTES = 60
const DAY_MINUTES = 24 * HOUR_MINUTES

/** Time to close, coarsened to the largest two units that still say something. */
function closesIn(closesAt: string): string {
  const remaining = new Date(closesAt).getTime() - now.value
  if (!Number.isFinite(remaining) || remaining <= 0) return t('prediction.closedLabel')

  const totalMinutes = Math.floor(remaining / MINUTE_MS)
  const days = Math.floor(totalMinutes / DAY_MINUTES)
  const hours = Math.floor((totalMinutes % DAY_MINUTES) / HOUR_MINUTES)
  const minutes = totalMinutes % HOUR_MINUTES

  if (days > 0) return t('prediction.closesIn', { time: `${days}${t('prediction.unitDay')} ${hours}${t('prediction.unitHour')}` })
  if (hours > 0) return t('prediction.closesIn', { time: `${hours}${t('prediction.unitHour')} ${minutes}${t('prediction.unitMinute')}` })
  return t('prediction.closesIn', { time: `${Math.max(minutes, 1)}${t('prediction.unitMinute')}` })
}

// ── Grouping ────────────────────────────────────────────────────────────────

interface CardGroup {
  discipline: DisciplineKey
  markets: PredictionMarketSummary[]
}

const groups = computed<CardGroup[]>(() => {
  const byDiscipline = new Map<DisciplineKey, PredictionMarketSummary[]>()

  for (const market of store.markets) {
    const { discipline } = boutMetaOf(market.description)
    const bucket = byDiscipline.get(discipline)
    if (bucket) bucket.push(market)
    else byDiscipline.set(discipline, [market])
  }

  return DISCIPLINE_ORDER.filter((discipline) => byDiscipline.has(discipline)).map((discipline) => ({
    discipline,
    markets: byDiscipline.get(discipline) ?? [],
  }))
})

/** The card's event name, when every bout belongs to the same one. */
const eventName = computed(() => {
  const names = new Set(store.markets.map((market) => market.eventName))
  return names.size === 1 ? store.markets[0].eventName : ''
})

/**
 * The denomination to explain the mechanism with, read off a real market rather
 * than assumed. The explainer only renders when there is a market to read.
 */
const shareValueText = computed(() =>
  store.markets.length > 0 ? formatAmount(store.markets[0].shareValue) : '',
)

function sortedOutcomes(market: PredictionMarketSummary) {
  return [...market.outcomes].sort((a, b) => a.sortOrder - b.sortOrder)
}

function priceLabel(price: string | null, shareValue: string): string {
  if (!price) return t('prediction.noPriceYet')
  return t('prediction.priceWithPercent', {
    amount: formatAmount(price),
    percent: percentOfShare(price, shareValue),
  })
}

onMounted(() => {
  store.fetchMarkets()
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (ticker) clearInterval(ticker)
  ticker = null
})

useHead({ title: 'Predictions — World Bingo' })
</script>

<template>
  <div class="pm-page">
    <header class="pm-header">
      <span v-if="eventName" class="pm-kicker">{{ eventName }}</span>
      <h1 class="pm-title">{{ t('prediction.title') }}</h1>
      <p class="pm-subtitle">{{ t('prediction.subtitle') }}</p>
    </header>

    <!-- How the book works. The two statements the player must not have to
         discover the hard way live here and again on the market page. -->
    <section v-if="store.markets.length" class="pm-explainer">
      <h2 class="pm-explainer-title">{{ t('prediction.howTitle') }}</h2>
      <ul class="pm-explainer-list">
        <li>{{ t('prediction.howPays', { share: shareValueText }) }}</li>
        <li>{{ t('prediction.howRests') }}</li>
        <li>{{ t('prediction.howHold') }}</li>
      </ul>
    </section>

    <div v-if="store.marketsLoading && !store.markets.length" class="pm-state">
      <span class="pm-spinner" />
      {{ t('prediction.loading') }}
    </div>

    <div v-else-if="!store.markets.length" class="pm-empty">
      <div class="pm-empty-icon">🥊</div>
      <p class="pm-empty-text">
        {{ store.marketsFailed ? t('prediction.loadFailed') : t('prediction.emptyCard') }}
      </p>
      <button v-if="store.marketsFailed" type="button" class="pm-retry" @click="store.fetchMarkets()">
        {{ t('common.retry') }}
      </button>
    </div>

    <section v-for="group in groups" :key="group.discipline" class="pm-group">
      <h2 class="pm-group-title">
        {{ t(`prediction.discipline.${group.discipline}`) }}
        <span class="pm-group-count">{{ group.markets.length }}</span>
      </h2>

      <NuxtLink
        v-for="market in group.markets"
        :key="market.id"
        :to="`/predictions/${market.id}`"
        class="pm-bout"
      >
        <div class="pm-bout-head">
          <span v-if="boutMetaOf(market.description).mainEvent" class="pm-badge pm-badge--main">
            {{ t('prediction.mainEvent') }}
          </span>
          <span class="pm-badge" :class="`pm-badge--${market.status.toLowerCase()}`">
            {{ t(`prediction.status.${market.status}`) }}
          </span>
          <span class="pm-closes">{{ closesIn(market.closesAt) }}</span>
        </div>

        <div class="pm-fighters">
          <div v-for="outcome in sortedOutcomes(market)" :key="outcome.id" class="pm-fighter">
            <span class="pm-fighter-name">{{ outcome.label }}</span>
            <span class="pm-fighter-price" :class="{ 'pm-fighter-price--none': !outcome.lastPrice }">
              {{ priceLabel(outcome.lastPrice, market.shareValue) }}
            </span>
          </div>
          <span class="pm-versus">{{ t('prediction.versus') }}</span>
        </div>

        <div class="pm-bout-foot">
          <span v-if="boutMetaOf(market.description).detail" class="pm-detail">
            {{ boutMetaOf(market.description).detail }}
          </span>
          <span class="pm-cta">{{ t('prediction.viewMarket') }} →</span>
        </div>
      </NuxtLink>
    </section>
  </div>
</template>

<style scoped>
.pm-page {
  max-width: 880px;
  margin: 0 auto;
  padding: 1.75rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Header ── */
.pm-header {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.pm-kicker {
  align-self: flex-start;
  background: color-mix(in srgb, var(--brand-primary) 18%, transparent);
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.68rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  padding: 0.25rem 0.65rem;
  border-radius: var(--radius-full, 999px);
}
.pm-title {
  font-family: var(--font-ui);
  font-size: 1.7rem;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--text-primary);
  margin: 0;
}
.pm-subtitle {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.55;
  margin: 0;
}

/* ── Explainer ── */
.pm-explainer {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-left: 3px solid var(--brand-primary);
  border-radius: var(--radius-md, 12px);
  padding: 1rem 1.15rem;
}
.pm-explainer-title {
  font-family: var(--font-ui);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--brand-primary);
  margin: 0 0 0.6rem;
}
.pm-explainer-list {
  margin: 0;
  padding-left: 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  font-size: 0.85rem;
  line-height: 1.55;
  color: var(--text-secondary);
}

/* ── Groups ── */
.pm-group {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.pm-group-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-primary);
  margin: 0.5rem 0 0.15rem;
  padding-bottom: 0.45rem;
  border-bottom: 1px solid var(--surface-border);
}
.pm-group-count {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--text-secondary);
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-full, 999px);
  padding: 0.1rem 0.45rem;
}

/* ── Bout row ── */
.pm-bout {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  padding: 0.9rem 1rem;
  text-decoration: none;
  color: inherit;
  transition: border-color var(--duration-fast, 200ms), transform var(--duration-fast, 200ms);
}
.pm-bout:hover {
  border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
  transform: translateY(-2px);
}

.pm-bout-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.pm-badge {
  font-family: var(--font-ui);
  font-size: 0.63rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.2rem 0.5rem;
  border-radius: var(--radius-full, 999px);
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
}
.pm-badge--main {
  background: color-mix(in srgb, var(--brand-primary) 20%, transparent);
  border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
  color: var(--brand-primary);
}
.pm-badge--open {
  background: color-mix(in srgb, var(--status-success) 18%, transparent);
  border-color: color-mix(in srgb, var(--status-success) 40%, transparent);
  color: var(--status-success);
}
.pm-badge--resolving {
  background: color-mix(in srgb, var(--status-warning) 18%, transparent);
  border-color: color-mix(in srgb, var(--status-warning) 40%, transparent);
  color: var(--status-warning);
}
.pm-closes {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* ── Fighters ── */
.pm-fighters {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}
.pm-fighter {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-sm, 8px);
  padding: 0.6rem 0.7rem;
  min-width: 0;
}
.pm-fighter-name {
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.pm-fighter-price {
  font-family: var(--font-ui);
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--brand-primary);
  font-variant-numeric: tabular-nums;
}
.pm-fighter-price--none {
  color: var(--text-secondary);
  font-weight: 500;
}
.pm-versus {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-family: var(--font-ui);
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--surface-raised);
  border-radius: var(--radius-full, 999px);
  padding: 0.1rem 0.3rem;
  pointer-events: none;
}

.pm-bout-foot {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.pm-detail {
  font-size: 0.75rem;
  color: var(--text-secondary);
}
.pm-cta {
  margin-left: auto;
  font-family: var(--font-ui);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--brand-primary);
}

/* ── States ── */
.pm-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 3rem 0;
  color: var(--text-secondary);
  font-size: 0.95rem;
}
.pm-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: pm-spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes pm-spin {
  to {
    transform: rotate(360deg);
  }
}

.pm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  text-align: center;
  padding: 3rem 1.5rem;
  color: var(--text-secondary);
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
}
.pm-empty-icon {
  font-size: 2rem;
}
.pm-empty-text {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.55;
}
.pm-retry {
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border: none;
  border-radius: 8px;
  padding: 0.55rem 1.3rem;
  cursor: pointer;
}

@media (max-width: 480px) {
  .pm-fighters {
    grid-template-columns: 1fr;
  }
  .pm-versus {
    display: none;
  }
}
</style>
