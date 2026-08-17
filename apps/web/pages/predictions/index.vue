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
import { mockSettledMarkets, mockSettledTotals } from '~/utils/mockSettledMarkets'

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

// ── Past results (LOCAL MOCK) ───────────────────────────────────────────────
// Not real, never persisted, and compiled out of any production build — see
// utils/mockSettledMarkets.ts. Present so this section can be reviewed against
// realistic density rather than an empty page.
const settled = computed(() => mockSettledMarkets())
const settledTotals = computed(() => mockSettledTotals())

/** Compact money: 1_284_600 -> '1.28M'. Keeps the strip readable at a glance. */
function compactEtb(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function daysAgoLabel(days: number): string {
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.round(days / 30)
  return months === 1 ? 'a month ago' : `${months} months ago`
}

/**
 * A bout row is self-describing: the outcomes ARE the fighters, so the question
 * ("Sedo vs Johnny — who wins?") only repeats them. A novelty market is not —
 * its outcomes are "Yes" and "No", which mean nothing without the question. Show
 * the question exactly when the outcome labels do not already appear in it.
 */
function cardQuestion(market: PredictionMarketSummary): string | null {
  const outcomes = sortedOutcomes(market)
  const q = market.question.toLowerCase()
  const selfDescribing = outcomes.every((o) => o.label && q.includes(o.label.toLowerCase()))
  return selfDescribing ? null : market.question
}

/**
 * The detail line takes the first clause only.
 *
 * A bout description is short ("Heavyweight, 3 rounds"). A novelty description
 * carries its whole resolution rule, which belongs on the market page, not
 * dumped into a card row — so cut at the first sentence and cap the length.
 */
function shortDetail(description: string | null | undefined): string {
  const detail = boutMetaOf(description).detail
  if (!detail) return ''
  const firstSentence = detail.split(/\.\s/)[0] ?? detail
  return firstSentence.length > 64 ? `${firstSentence.slice(0, 61).trimEnd()}…` : firstSentence
}

/** A sparkline path for a settled market's price history, in a 100x28 box. */
function sparkline(path: number[]): string {
  if (path.length < 2) return ''
  const w = 100
  const h = 28
  const step = w / (path.length - 1)
  return path
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)} ${(h - (p / 100) * h).toFixed(1)}`)
    .join(' ')
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

    <!-- Skeleton rows, sized like the real bout rows they replace, so the page
         does not reflow when the data lands. A spinner would say "something is
         happening"; this says "three bouts are coming, and this is their shape". -->
    <div v-if="store.marketsLoading && !store.markets.length" class="pm-skeletons" aria-busy="true">
      <span class="u-sr">{{ t('prediction.loading') }}</span>
      <div v-for="n in 3" :key="n" class="pm-skel" :style="{ '--i': n - 1 }">
        <div class="pm-skel-head">
          <span class="pm-skel-chip" />
          <span class="pm-skel-chip pm-skel-chip--sm" />
        </div>
        <div class="pm-skel-fighters">
          <span class="pm-skel-block" />
          <span class="pm-skel-block" />
        </div>
        <span class="pm-skel-line" />
      </div>
    </div>

    <div v-else-if="!store.markets.length" class="pm-empty">
      <svg class="pm-empty-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <rect x="9" y="14" width="19" height="21" rx="6.5" stroke="currentColor" stroke-width="1.6" />
        <path d="M28 20h4.5A5.5 5.5 0 0 1 38 25.5v0a5.5 5.5 0 0 1-5.5 5.5H28" stroke="currentColor" stroke-width="1.6" />
        <path d="M14 14v-2.5A3.5 3.5 0 0 1 17.5 8h2A3.5 3.5 0 0 1 23 11.5V14" stroke="currentColor" stroke-width="1.6" />
        <path d="M9 24h19" stroke="currentColor" stroke-width="1.6" />
      </svg>
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
        v-for="(market, i) in group.markets"
        :key="market.id"
        :to="`/predictions/${market.id}`"
        class="pm-bout"
        :style="{ '--i': i }"
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

        <h3 v-if="cardQuestion(market)" class="pm-question">{{ cardQuestion(market) }}</h3>

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
          <span v-if="shortDetail(market.description)" class="pm-detail">
            {{ shortDetail(market.description) }}
          </span>
          <span class="pm-cta">{{ t('prediction.viewMarket') }} →</span>
        </div>
      </NuxtLink>
    </section>

    <!-- ── Past results ── -->
    <section v-if="settled.length" class="pm-past">
      <div class="pm-past-head">
        <h2 class="pm-group-title">Past results</h2>
        <div class="pm-past-totals">
          <span><strong>{{ compactEtb(settledTotals.volume) }}</strong> ETB traded</span>
          <span><strong>{{ settledTotals.traders.toLocaleString() }}</strong> traders</span>
          <span><strong>{{ settledTotals.count }}</strong> markets settled</span>
        </div>
      </div>

      <article v-for="m in settled" :key="m.id" class="pm-past-row">
        <div class="pm-past-main">
          <div class="pm-past-top">
            <span class="pm-past-event">{{ m.eventName }}</span>
            <span class="pm-past-when">{{ daysAgoLabel(m.settledDaysAgo) }}</span>
          </div>
          <h3 class="pm-past-q">{{ m.question }}</h3>
          <div class="pm-past-winner">
            <span class="pm-past-check" aria-hidden="true">✓</span>
            <span class="pm-past-winner-name">{{ m.outcomes[m.winner] }}</span>
            <span class="pm-past-paid">paid 100 ETB a share</span>
          </div>
        </div>

        <div class="pm-past-side">
          <svg class="pm-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
            <path :d="sparkline(m.path)" fill="none" />
          </svg>
          <div class="pm-past-stats">
            <span><strong>{{ compactEtb(m.volume) }}</strong> ETB</span>
            <span>{{ m.traders }} traders</span>
            <span class="pm-past-top-payout">top win {{ compactEtb(m.topPayout) }}</span>
          </div>
        </div>
      </article>
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

/* ── Skeletons ──
   Shaped like the bout rows they stand in for, so nothing jumps when the real
   data arrives. The shimmer is a transform on a pseudo-element, never a width
   or background-position animation, so it stays on the compositor. */
.pm-skeletons {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.u-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.pm-skel {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  padding: 0.9rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  opacity: 0;
  animation: pm-skel-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  animation-delay: calc(var(--i) * 70ms);
}
@keyframes pm-skel-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.pm-skel-head { display: flex; gap: 0.5rem; }
.pm-skel-fighters { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
.pm-skel-chip,
.pm-skel-block,
.pm-skel-line {
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface-border) 60%, var(--surface-raised));
}
.pm-skel-chip { width: 74px; height: 18px; border-radius: 999px; }
.pm-skel-chip--sm { width: 52px; }
.pm-skel-block { height: 54px; border-radius: 10px; }
.pm-skel-line { width: 45%; height: 12px; }
.pm-skel-chip::after,
.pm-skel-block::after,
.pm-skel-line::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--text-secondary) 14%, transparent),
    transparent
  );
  transform: translateX(-100%);
  animation: pm-shimmer 1.4s ease-in-out infinite;
}
@keyframes pm-shimmer {
  to { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .pm-skel { animation: none; opacity: 1; }
  .pm-skel-chip::after,
  .pm-skel-block::after,
  .pm-skel-line::after { animation: none; }
}

/* The empty mark is drawn, not an emoji — it inherits ink colour and scales
   with the type rather than rendering as someone else's glyph. */
.pm-empty-mark {
  width: 46px;
  height: 46px;
  color: var(--text-secondary);
  opacity: 0.55;
  margin-bottom: 0.35rem;
}

/* Question heading — only on markets whose outcomes do not name themselves. */
.pm-question {
  margin: 0 0 0.5rem;
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  line-height: 1.35;
  color: var(--text-primary);
}

/* ── Past results ── */
.pm-past {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.pm-past-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.pm-past-totals {
  display: flex;
  gap: 0.9rem;
  flex-wrap: wrap;
  font-size: 0.78rem;
  color: var(--text-secondary);
}
.pm-past-totals strong {
  color: var(--text-primary);
  font-weight: 700;
}
.pm-past-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  padding: 0.85rem 1rem;
}
.pm-past-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.pm-past-top {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.pm-past-event {
  color: var(--brand-primary);
  font-weight: 700;
}
.pm-past-q {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pm-past-winner {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  flex-wrap: wrap;
}
.pm-past-check {
  color: var(--status-success);
  font-weight: 800;
}
.pm-past-winner-name {
  color: var(--text-primary);
  font-weight: 600;
}
.pm-past-paid {
  color: var(--text-secondary);
}
.pm-past-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.3rem;
  flex-shrink: 0;
}
.pm-spark {
  width: 96px;
  height: 28px;
}
.pm-spark path {
  stroke: var(--brand-primary);
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.pm-past-stats {
  display: flex;
  gap: 0.6rem;
  font-size: 0.72rem;
  color: var(--text-secondary);
  white-space: nowrap;
}
.pm-past-stats strong {
  color: var(--text-primary);
  font-weight: 700;
}
.pm-past-top-payout {
  color: var(--status-success);
}
@media (max-width: 560px) {
  .pm-past-row {
    flex-direction: column;
    align-items: stretch;
  }
  .pm-past-side {
    align-items: flex-start;
  }
  .pm-past-q {
    white-space: normal;
  }
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
  /* One easing for everything that moves on this page. The overshoot curve
     reads as weight rather than as a fade. */
  transition:
    border-color 240ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 240ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 240ms cubic-bezier(0.16, 1, 0.3, 1);
  /* Staggered reveal — rows arrive in reading order instead of all at once. */
  animation: pm-row-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: calc(var(--i, 0) * 55ms);
}
@keyframes pm-row-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.pm-bout:hover {
  border-color: color-mix(in srgb, var(--brand-primary) 45%, var(--surface-border));
  /* Tinted to the surface rather than a neutral drop shadow, and no glow. */
  box-shadow: 0 10px 28px -18px color-mix(in srgb, var(--brand-primary) 55%, transparent);
}
/* Tactile feedback: the row physically gives under the finger. */
.pm-bout:active {
  transform: scale(0.988);
  transition-duration: 90ms;
}
.pm-bout:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .pm-bout { animation: none; }
  .pm-bout:active { transform: none; }
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
  transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1), filter 200ms ease;
}
.pm-retry:hover { filter: brightness(1.06); }
.pm-retry:active { transform: scale(0.96); transition-duration: 90ms; }
.pm-retry:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  .pm-retry:active { transform: none; }
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
