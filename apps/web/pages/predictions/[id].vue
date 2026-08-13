<script setup lang="ts">
/**
 * One market: both sides of the book, the order ticket, the player's resting
 * orders and their position.
 *
 * THE BOOK, READ CORRECTLY. There is one book quoted on both sides. A resting
 * order under a fighter is somebody wanting to BUY that fighter at that price —
 * it is not an offer to you. What you can actually buy at is the complement of
 * the best resting price on the OTHER fighter: buying Johnny at 65 is offering
 * Sedo at 35, and the pair escrows exactly one share value between them. That is
 * why `bestAvailableMinor` looks at the opposing side, and why switching fighter
 * in the ticket flips the price to its complement.
 *
 * TWO THINGS THIS PAGE MUST SAY OUT LOUD, and does, next to the submit button:
 *   1. An order RESTS until another player takes the other side. Not filling
 *      immediately is the normal case in a young book, not a failure.
 *   2. A position is HELD UNTIL THE RESULT. There is no cash-out in this version.
 *
 * No money value on this page passes through a JS float, and no price bound is
 * hardcoded: every one is derived from `market.shareValue`.
 */
import { toWholeBirr } from '@world-bingo/shared-types'
import type {
  PredictionBookPayload,
  PredictionSettledPayload,
  PredictionStatusPayload,
  PredictionTradePayload,
} from '@world-bingo/shared-types'
import {
  birrToMinor,
  boutMetaOf,
  feeOnProfit,
  formatAmount,
  formatMinor,
  minorToWholeBirr,
  percentOfShareMinor,
  toMinor,
  usePredictionStore,
  type PredictionPositionRow,
} from '~/store/prediction'
import { useSocket } from '~/composables/useSocket'
import { useAuthStore } from '~/store/auth'

const route = useRoute()
const { t } = useI18n()
const store = usePredictionStore()
const auth = useAuthStore()
const { socket, connect } = useSocket()
const { flags, loaded } = useFeatureFlags()

const marketId = computed(() => String(route.params.id))
const predictionsEnabled = computed(() => flags.value.feature_prediction_market === true)

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

function remainingText(target: string | null | undefined): string {
  if (!target) return ''
  const remaining = new Date(target).getTime() - now.value
  if (!Number.isFinite(remaining) || remaining <= 0) return ''

  const totalMinutes = Math.floor(remaining / MINUTE_MS)
  const days = Math.floor(totalMinutes / DAY_MINUTES)
  const hours = Math.floor((totalMinutes % DAY_MINUTES) / HOUR_MINUTES)
  const minutes = totalMinutes % HOUR_MINUTES

  if (days > 0) return `${days}${t('prediction.unitDay')} ${hours}${t('prediction.unitHour')}`
  if (hours > 0) return `${hours}${t('prediction.unitHour')} ${minutes}${t('prediction.unitMinute')}`
  return `${Math.max(minutes, 1)}${t('prediction.unitMinute')}`
}

// ── Market shape ────────────────────────────────────────────────────────────

const market = computed(() => store.market)
const outcomes = computed(() => store.outcomes)
const meta = computed(() => boutMetaOf(market.value?.description))

/** The denomination everything on this page is measured against. Never 100. */
const shareMinor = computed(() => toMinor(market.value?.shareValue ?? '0'))
const shareValueText = computed(() => formatAmount(market.value?.shareValue))

/**
 * Valid limit prices are 1 .. shareValue - 1 in whole 1 ETB ticks. `toWholeBirr`
 * refuses a fractional share value outright rather than inventing a tick grid
 * for it, which would put the ticket out of step with the server's validation.
 */
const shareValueBirr = computed(() => {
  const raw = market.value?.shareValue
  if (!raw) return 0
  try {
    return toWholeBirr(raw)
  } catch {
    return 0
  }
})
const minPriceBirr = 1
const maxPriceBirr = computed(() => Math.max(shareValueBirr.value - 1, minPriceBirr))

const isOpen = computed(() => market.value?.status === 'OPEN')
const isTradeable = computed(
  () => isOpen.value && new Date(market.value?.closesAt ?? 0).getTime() > now.value,
)

const winningOutcomeId = computed(() => market.value?.winningOutcomeId ?? null)

const closesInText = computed(() => {
  const left = remainingText(market.value?.closesAt)
  return left ? t('prediction.closesIn', { time: left }) : t('prediction.closedLabel')
})

const disputeText = computed(() => {
  const left = remainingText(market.value?.disputeUntil)
  return left ? t('prediction.disputeEnds', { time: left }) : ''
})

// ── Book reads ──────────────────────────────────────────────────────────────

function bookFor(outcomeId: string) {
  return market.value?.book?.outcomes.find((side) => side.outcomeId === outcomeId) ?? null
}

function levelsFor(outcomeId: string) {
  return bookFor(outcomeId)?.levels ?? []
}

function opposingIdOf(outcomeId: string): string | null {
  return outcomes.value.find((outcome) => outcome.id !== outcomeId)?.id ?? null
}

/**
 * The cheapest price this side could be bought at right now: the complement of
 * the best resting order on the opposing side. Null when nobody is offering.
 */
function bestAvailableMinor(outcomeId: string): bigint | null {
  const opposing = opposingIdOf(outcomeId)
  if (!opposing) return null
  const best = levelsFor(opposing)[0]
  if (!best) return null
  const price = shareMinor.value - toMinor(best.price)
  return price > 0n ? price : null
}

/** '35 ETB (35%)' — the two numbers that are the same number at a 100 ETB share. */
function priceLabelMinor(priceMinor: bigint): string {
  return t('prediction.priceWithPercent', {
    amount: formatMinor(priceMinor),
    percent: percentOfShareMinor(priceMinor, shareMinor.value),
  })
}

function priceLabel(price: string | null | undefined): string {
  if (!price) return t('prediction.noPriceYet')
  return priceLabelMinor(toMinor(price))
}

function bestAvailableLabel(outcomeId: string): string {
  const best = bestAvailableMinor(outcomeId)
  return best === null ? t('prediction.noOffers') : priceLabelMinor(best)
}

function outcomeLabelOf(outcomeId: string): string {
  return outcomes.value.find((outcome) => outcome.id === outcomeId)?.label ?? ''
}

// ── Order ticket ────────────────────────────────────────────────────────────

const selectedOutcomeId = ref('')
const priceBirr = ref(0)
const quantity = ref(1)
const submitted = ref(false)

const minShares = computed(() => market.value?.minOrderShares ?? 1)
const maxShares = computed(() => market.value?.maxOrderShares ?? 1)

/**
 * The best available price as a tick the input can hold, or null when there is
 * none — either the book is empty or the price is off the 1 ETB grid, and a
 * price the server would reject is worse than no suggestion at all.
 */
function bestAvailableBirr(outcomeId: string): number | null {
  const best = bestAvailableMinor(outcomeId)
  if (best === null) return null
  try {
    return clampPrice(minorToWholeBirr(best))
  } catch {
    return null
  }
}

/** Half the share value: a 50/50 opening guess when the book is silent. */
function defaultPriceFor(outcomeId: string): number {
  const best = bestAvailableBirr(outcomeId)
  if (best !== null) return best
  return Math.max(Math.min(Math.floor(shareValueBirr.value / 2), maxPriceBirr.value), minPriceBirr)
}

function clampPrice(value: number): number {
  if (!Number.isFinite(value)) return minPriceBirr
  return Math.min(Math.max(Math.trunc(value), minPriceBirr), maxPriceBirr.value)
}

/**
 * Switching fighter flips the price to its complement, because that is what the
 * switch means: wanting Johnny at 65 IS offering Sedo at 35. Carrying the old
 * number across would silently invert the player's opinion.
 */
function selectOutcome(outcomeId: string) {
  if (selectedOutcomeId.value === outcomeId) return
  const previous = selectedOutcomeId.value
  selectedOutcomeId.value = outcomeId
  store.clearOrderError()
  submitted.value = false

  const best = bestAvailableBirr(outcomeId)
  if (best !== null) {
    priceBirr.value = best
    return
  }
  priceBirr.value = previous ? clampPrice(shareValueBirr.value - priceBirr.value) : defaultPriceFor(outcomeId)
}

// A changed ticket is a new intention: the previous order's outcome banner and
// the previous failure both stop describing what the button will do.
watch([priceBirr, quantity], () => {
  if (!submitted.value && !store.orderError) return
  submitted.value = false
  store.clearOrderError()
})

const priceMinor = computed(() => birrToMinor(priceBirr.value))
const shareCount = computed(() => Math.trunc(quantity.value))

const costMinor = computed(() => priceMinor.value * BigInt(Math.max(shareCount.value, 0)))
const payoutMinor = computed(() => shareMinor.value * BigInt(Math.max(shareCount.value, 0)))
const profitMinor = computed(() => {
  const profit = payoutMinor.value - costMinor.value
  return profit > 0n ? profit : 0n
})
const feeMinor = computed(() => feeOnProfit(profitMinor.value, market.value?.feePct ?? '0'))
const netMinor = computed(() => payoutMinor.value - feeMinor.value)

const priceValid = computed(
  () =>
    Number.isInteger(priceBirr.value) &&
    priceBirr.value >= minPriceBirr &&
    priceBirr.value <= maxPriceBirr.value,
)
const quantityValid = computed(
  () =>
    Number.isInteger(shareCount.value) &&
    shareCount.value >= minShares.value &&
    shareCount.value <= maxShares.value,
)
const canSubmit = computed(
  () =>
    isTradeable.value &&
    !!selectedOutcomeId.value &&
    priceValid.value &&
    quantityValid.value &&
    !store.placing,
)

async function submitOrder() {
  if (!canSubmit.value || !market.value) return
  submitted.value = false
  const result = await store.placeOrder({
    marketId: market.value.id,
    outcomeId: selectedOutcomeId.value,
    limitPrice: priceBirr.value,
    quantity: shareCount.value,
  })
  if (result) submitted.value = true
}

/** How the last order actually landed — filled, part-filled, or fully resting. */
const resultMessage = computed(() => {
  const result = store.lastResult
  if (!submitted.value || !result) return ''
  const filled = result.order.filledQuantity
  const resting = result.order.quantity - filled
  if (filled === 0) return t('prediction.resultAllResting', { shares: result.order.quantity })
  if (resting > 0) return t('prediction.resultPartial', { filled, resting })
  return t('prediction.resultFilled', { filled })
})

// ── Positions ───────────────────────────────────────────────────────────────

function basisMinorOf(position: PredictionPositionRow): bigint {
  return toMinor(position.costBasisReal) + toMinor(position.costBasisBonus)
}

function averagePriceLabel(position: PredictionPositionRow): string {
  if (position.shares <= 0) return '—'
  return priceLabelMinor(basisMinorOf(position) / BigInt(position.shares))
}

function positionPayoutLabel(position: PredictionPositionRow): string {
  return t('prediction.amountEtb', {
    amount: formatMinor(shareMinor.value * BigInt(position.shares)),
  })
}

// ── Realtime ────────────────────────────────────────────────────────────────

/**
 * The socket is typed against the bingo event maps, which do not carry the
 * prediction events. A narrow structural handle keeps this page honest without
 * reaching into another agent's contract file.
 */
interface EventBus {
  on(event: string, listener: (...args: any[]) => void): void
  off(event: string, listener?: (...args: any[]) => void): void
  emit(event: string, ...args: any[]): void
}

let bus: EventBus | null = null

/**
 * The room actually joined, remembered separately from `marketId`. Navigating
 * between two markets updates the route param first, so leaving on the current
 * param would abandon the new room and keep listening to the old one.
 */
let joinedMarketId: string | null = null

function onBook(payload: PredictionBookPayload) {
  store.applyBook(payload)
}

function onTrade(payload: PredictionTradePayload) {
  store.applyTrade(payload)
}

function onStatus(payload: PredictionStatusPayload) {
  store.applyStatus(payload)
  // A transition out of OPEN cancels and refunds resting orders server-side.
  store.fetchMyOrders(marketId.value)
}

function onSettled(payload: PredictionSettledPayload) {
  store.applySettled(payload)
  store.fetchMyPositions(marketId.value)
  auth.fetchWallet()
}

/** Room membership dies with the connection, so it is re-claimed on every one. */
function onConnect() {
  if (!joinedMarketId) return
  bus?.emit('prediction:join-room', { marketId: joinedMarketId })
  // Depth moved while the socket was away; the REST read is authoritative.
  store.fetchBook(joinedMarketId)
}

function subscribe() {
  const instance = connect() ?? socket.value
  if (!instance) return
  bus = instance as unknown as EventBus
  joinedMarketId = marketId.value
  bus.emit('prediction:join-room', { marketId: joinedMarketId })
  bus.on('connect', onConnect)
  bus.on('prediction:book', onBook)
  bus.on('prediction:trade', onTrade)
  bus.on('prediction:status', onStatus)
  bus.on('prediction:settled', onSettled)
}

function unsubscribe() {
  if (!bus) return
  if (joinedMarketId) bus.emit('prediction:leave-room', { marketId: joinedMarketId })
  bus.off('connect', onConnect)
  bus.off('prediction:book', onBook)
  bus.off('prediction:trade', onTrade)
  bus.off('prediction:status', onStatus)
  bus.off('prediction:settled', onSettled)
  joinedMarketId = null
  bus = null
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

async function load() {
  await store.fetchMarket(marketId.value)
  if (!market.value) return

  const first = outcomes.value[0]
  if (first) {
    selectedOutcomeId.value = first.id
    priceBirr.value = defaultPriceFor(first.id)
  }
  quantity.value = minShares.value

  await Promise.all([
    store.fetchHistory(marketId.value),
    store.fetchMyOrders(marketId.value),
    store.fetchMyPositions(marketId.value),
  ])
}

onMounted(async () => {
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  await load()
  subscribe()
})

// Nuxt reuses this component between two markets on the same route, so the room
// has to be swapped by hand — otherwise the second market renders the first
// market's book and keeps receiving its fills.
watch(marketId, async (next, previous) => {
  if (next === previous) return
  unsubscribe()
  store.resetMarket()
  await load()
  subscribe()
})

onUnmounted(() => {
  if (ticker) clearInterval(ticker)
  ticker = null
  unsubscribe()
  store.resetMarket()
})

const pageTitle = computed(() =>
  market.value ? `${market.value.question} — World Bingo` : 'Market — World Bingo',
)
useHead({ title: pageTitle })
</script>

<template>
  <div class="pm-market">
    <NuxtLink to="/predictions" class="pm-back">← {{ t('prediction.backToCard') }}</NuxtLink>

    <div v-if="store.marketLoading && !market" class="pm-state">
      <span class="pm-spinner" />
      {{ t('prediction.loading') }}
    </div>

    <div v-else-if="!market" class="pm-empty">
      <div class="pm-empty-icon">🥊</div>
      <p class="pm-empty-text">{{ t('prediction.notFound') }}</p>
    </div>

    <!-- `v-else-if="market"` rather than a bare `v-else`: the branch below reads
         `market.*` directly, and the explicit truthiness test is what narrows it
         away from null for the template type-checker. -->
    <template v-else-if="market">
      <!-- ── Header ── -->
      <header class="pm-head">
        <div class="pm-head-badges">
          <span v-if="meta.mainEvent" class="pm-badge pm-badge--main">{{ t('prediction.mainEvent') }}</span>
          <span class="pm-badge" :class="`pm-badge--${market.status.toLowerCase()}`">
            {{ t(`prediction.status.${market.status}`) }}
          </span>
          <span class="pm-badge">{{ t(`prediction.discipline.${meta.discipline}`) }}</span>
          <span class="pm-closes">{{ closesInText }}</span>
        </div>
        <span class="pm-event">{{ market.eventName }}</span>
        <h1 class="pm-question">{{ market.question }}</h1>
        <p v-if="meta.detail" class="pm-detail">{{ meta.detail }}</p>

        <div class="pm-stats">
          <span>{{ t('prediction.statsShares', { shares: market.totalShares }) }}</span>
          <span>{{ t('prediction.statsEscrowed', { amount: formatAmount(market.totalVolume) }) }}</span>
          <span>{{ t('prediction.statsShareValue', { amount: shareValueText }) }}</span>
        </div>
      </header>

      <!-- ── Lifecycle notices ── -->
      <div v-if="market.status === 'CLOSED'" class="pm-notice">{{ t('prediction.closedNotice') }}</div>
      <div v-else-if="market.status === 'RESOLVING'" class="pm-notice pm-notice--warn">
        {{ t('prediction.resolvingNotice') }}
        <span v-if="disputeText"> · {{ disputeText }}</span>
      </div>
      <div v-else-if="market.status === 'SETTLED' && winningOutcomeId" class="pm-notice pm-notice--good">
        {{ t('prediction.settledNotice', { winner: outcomeLabelOf(winningOutcomeId), share: shareValueText }) }}
      </div>
      <div v-else-if="market.status === 'VOIDED'" class="pm-notice pm-notice--warn">
        {{ t('prediction.voidedNotice') }}
        <span v-if="market.voidReason"> · {{ market.voidReason }}</span>
      </div>

      <!-- ── Probability over time ── -->
      <PredictionPriceChart
        v-if="store.history"
        class="pm-chart"
        :points="store.history.points"
        :outcome-label="store.history.outcomeLabel"
        :share-value="Number(store.history.shareValue)"
        :loading="store.historyLoading"
      />

      <!-- ── Both sides of the book ── -->
      <section class="pm-sides">
        <article
          v-for="outcome in outcomes"
          :key="outcome.id"
          class="pm-side"
          :class="{
            'pm-side--won': winningOutcomeId === outcome.id,
            'pm-side--lost': !!winningOutcomeId && winningOutcomeId !== outcome.id,
          }"
        >
          <div class="pm-side-head">
            <h2 class="pm-side-name">{{ outcome.label }}</h2>
            <span v-if="winningOutcomeId === outcome.id" class="pm-badge pm-badge--won">
              {{ t('prediction.outcomeWon') }}
            </span>
          </div>

          <dl class="pm-side-prices">
            <div>
              <dt>{{ t('prediction.lastPrice') }}</dt>
              <dd class="pm-price">{{ priceLabel(outcome.lastPrice) }}</dd>
            </div>
            <div>
              <dt>{{ t('prediction.bestAvailable') }}</dt>
              <dd class="pm-price pm-price--dim">{{ bestAvailableLabel(outcome.id) }}</dd>
            </div>
          </dl>

          <div class="pm-depth">
            <span class="pm-depth-title">{{ t('prediction.depthTitle') }}</span>
            <table v-if="levelsFor(outcome.id).length" class="pm-depth-table">
              <thead>
                <tr>
                  <th>{{ t('prediction.depthPrice') }}</th>
                  <th>{{ t('prediction.depthShares') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="level in levelsFor(outcome.id)" :key="`${outcome.id}-${level.price}`">
                  <td>{{ priceLabelMinor(toMinor(level.price)) }}</td>
                  <td class="pm-num">{{ level.shares }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="pm-depth-empty">{{ t('prediction.depthEmpty') }}</p>
          </div>
        </article>
      </section>

      <!-- ── Order ticket ── -->
      <section class="pm-ticket">
        <h2 class="pm-section-title">{{ t('prediction.ticketTitle') }}</h2>

        <div v-if="!auth.isAuthenticated" class="pm-signin">
          <p>{{ t('prediction.signInPrompt') }}</p>
          <NuxtLink to="/auth/login" class="pm-btn">{{ t('prediction.signIn') }}</NuxtLink>
        </div>

        <template v-else>
          <p v-if="!isTradeable" class="pm-ticket-locked">{{ t('prediction.tradingClosed') }}</p>

          <fieldset class="pm-field" :disabled="!isTradeable">
            <legend class="pm-label">{{ t('prediction.ticketPick') }}</legend>
            <div class="pm-picker">
              <button
                v-for="outcome in outcomes"
                :key="outcome.id"
                type="button"
                class="pm-pick"
                :class="{ 'pm-pick--on': selectedOutcomeId === outcome.id }"
                @click="selectOutcome(outcome.id)"
              >
                <span class="pm-pick-name">{{ outcome.label }}</span>
                <span class="pm-pick-price">{{ bestAvailableLabel(outcome.id) }}</span>
              </button>
            </div>
          </fieldset>

          <div class="pm-inputs">
            <label class="pm-field">
              <span class="pm-label">{{ t('prediction.ticketPrice') }}</span>
              <input
                v-model.number="priceBirr"
                type="number"
                inputmode="numeric"
                step="1"
                :min="minPriceBirr"
                :max="maxPriceBirr"
                :disabled="!isTradeable"
                class="pm-input"
              />
              <span class="pm-hint">
                {{ t('prediction.ticketPriceHint', { min: minPriceBirr, max: maxPriceBirr }) }}
              </span>
              <span class="pm-hint pm-hint--strong">
                {{ t('prediction.ticketPriceMeans', { percent: percentOfShareMinor(priceMinor, shareMinor) }) }}
              </span>
            </label>

            <label class="pm-field">
              <span class="pm-label">{{ t('prediction.ticketQuantity') }}</span>
              <input
                v-model.number="quantity"
                type="number"
                inputmode="numeric"
                step="1"
                :min="minShares"
                :max="maxShares"
                :disabled="!isTradeable"
                class="pm-input"
              />
              <span class="pm-hint">
                {{ t('prediction.ticketQuantityHint', { min: minShares, max: maxShares }) }}
              </span>
            </label>
          </div>

          <dl class="pm-summary">
            <div>
              <dt>{{ t('prediction.summaryCost') }}</dt>
              <dd>{{ t('prediction.amountEtb', { amount: formatMinor(costMinor) }) }}</dd>
            </div>
            <div>
              <dt>{{ t('prediction.summaryPayout') }}</dt>
              <dd class="pm-good">{{ t('prediction.amountEtb', { amount: formatMinor(payoutMinor) }) }}</dd>
            </div>
            <div>
              <dt>{{ t('prediction.summaryFee', { percent: formatAmount(market.feePct) }) }}</dt>
              <dd>{{ t('prediction.amountEtb', { amount: formatMinor(feeMinor) }) }}</dd>
            </div>
            <div>
              <dt>{{ t('prediction.summaryNet') }}</dt>
              <dd class="pm-good">{{ t('prediction.amountEtb', { amount: formatMinor(netMinor) }) }}</dd>
            </div>
            <div>
              <dt>{{ t('prediction.summaryLoss') }}</dt>
              <dd class="pm-bad">{{ t('prediction.amountEtb', { amount: formatMinor(costMinor) }) }}</dd>
            </div>
          </dl>

          <!-- The two statements the player must never have to discover the hard way. -->
          <div class="pm-rules">
            <p class="pm-rule">{{ t('prediction.restingNotice') }}</p>
            <p class="pm-rule">{{ t('prediction.holdNotice', { share: shareValueText }) }}</p>
          </div>

          <p v-if="store.orderError" class="pm-error">{{ t(`prediction.errors.${store.orderError}`) }}</p>
          <p v-else-if="resultMessage" class="pm-success">{{ resultMessage }}</p>

          <button type="button" class="pm-btn pm-btn--wide" :disabled="!canSubmit" @click="submitOrder">
            {{ store.placing ? t('prediction.submitting') : t('prediction.submit') }}
          </button>
        </template>
      </section>

      <!-- ── Resting orders ── -->
      <section v-if="auth.isAuthenticated" class="pm-block">
        <h2 class="pm-section-title">{{ t('prediction.ordersTitle') }}</h2>
        <p class="pm-block-note">{{ t('prediction.ordersNote') }}</p>

        <p v-if="!store.restingOrders.length" class="pm-block-empty">{{ t('prediction.ordersEmpty') }}</p>

        <ul v-else class="pm-rows">
          <li v-for="order in store.restingOrders" :key="order.id" class="pm-row">
            <div class="pm-row-main">
              <span class="pm-row-name">{{ order.outcome.label }}</span>
              <span class="pm-row-price">{{ priceLabelMinor(toMinor(order.limitPrice)) }}</span>
            </div>
            <span class="pm-row-fill">
              {{ t('prediction.orderFilledOf', { filled: order.filledQuantity, quantity: order.quantity }) }}
            </span>
            <button
              type="button"
              class="pm-btn pm-btn--ghost"
              :disabled="store.cancellingId === order.id || !isOpen"
              @click="store.cancelOrder(order.id, marketId)"
            >
              {{ store.cancellingId === order.id ? t('prediction.cancelling') : t('prediction.cancel') }}
            </button>
          </li>
        </ul>
      </section>

      <!-- ── Position ── -->
      <section v-if="auth.isAuthenticated" class="pm-block">
        <h2 class="pm-section-title">{{ t('prediction.positionTitle') }}</h2>
        <p class="pm-block-note">{{ t('prediction.positionNote') }}</p>

        <p v-if="!store.heldPositions.length" class="pm-block-empty">{{ t('prediction.positionEmpty') }}</p>

        <ul v-else class="pm-rows">
          <li v-for="position in store.heldPositions" :key="position.id" class="pm-row pm-row--position">
            <div class="pm-row-main">
              <span class="pm-row-name">{{ position.outcome.label }}</span>
              <span class="pm-badge" :class="`pm-badge--${position.status.toLowerCase()}`">
                {{ t(`prediction.positionStatus.${position.status}`) }}
              </span>
            </div>
            <dl class="pm-position-stats">
              <div>
                <dt>{{ t('prediction.positionShares') }}</dt>
                <dd class="pm-num">{{ position.shares }}</dd>
              </div>
              <div>
                <dt>{{ t('prediction.positionAvg') }}</dt>
                <dd>{{ averagePriceLabel(position) }}</dd>
              </div>
              <div>
                <dt>{{ t('prediction.positionCost') }}</dt>
                <dd>{{ t('prediction.amountEtb', { amount: formatMinor(basisMinorOf(position)) }) }}</dd>
              </div>
              <div>
                <dt>{{ t('prediction.positionPayout') }}</dt>
                <dd class="pm-good">{{ positionPayoutLabel(position) }}</dd>
              </div>
              <div v-if="position.status !== 'OPEN'">
                <dt>{{ t('prediction.positionPaid') }}</dt>
                <dd>{{ t('prediction.amountEtb', { amount: formatAmount(position.payout) }) }}</dd>
              </div>
            </dl>
          </li>
        </ul>
      </section>

      <!-- ── Tape ── -->
      <section class="pm-block">
        <h2 class="pm-section-title">{{ t('prediction.tapeTitle') }}</h2>
        <p v-if="!store.trades.length" class="pm-block-empty">{{ t('prediction.tapeEmpty') }}</p>
        <ul v-else class="pm-tape">
          <li v-for="(trade, index) in store.trades" :key="`${trade.at}-${index}`" class="pm-tape-row">
            <span class="pm-tape-name">{{ outcomeLabelOf(trade.outcomeId) }}</span>
            <span class="pm-tape-price">{{ priceLabelMinor(toMinor(trade.price)) }}</span>
            <span class="pm-tape-qty">{{ t('prediction.tapeShares', { shares: trade.quantity }) }}</span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.pm-market {
  max-width: 880px;
  margin: 0 auto;
  padding: 1.25rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
}

.pm-back {
  align-self: flex-start;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-decoration: none;
}
.pm-back:hover {
  color: var(--brand-primary);
}

/* ── Header ── */
.pm-head {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.pm-head-badges {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.pm-event {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--brand-primary);
}
.pm-question {
  font-family: var(--font-ui);
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.25;
}
.pm-detail {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
}
.pm-stats {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  font-size: 0.75rem;
  color: var(--text-secondary);
  padding-top: 0.35rem;
  font-variant-numeric: tabular-nums;
}

/* ── Badges ── */
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
.pm-badge--open,
.pm-badge--won {
  background: color-mix(in srgb, var(--status-success) 18%, transparent);
  border-color: color-mix(in srgb, var(--status-success) 40%, transparent);
  color: var(--status-success);
}
.pm-badge--resolving,
.pm-badge--refunded {
  background: color-mix(in srgb, var(--status-warning) 18%, transparent);
  border-color: color-mix(in srgb, var(--status-warning) 40%, transparent);
  color: var(--status-warning);
}
.pm-badge--lost {
  background: color-mix(in srgb, var(--status-error) 15%, transparent);
  border-color: color-mix(in srgb, var(--status-error) 35%, transparent);
  color: var(--status-error);
}
.pm-closes {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* ── Notices ── */
.pm-notice {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-left: 3px solid var(--text-secondary);
  border-radius: var(--radius-md, 12px);
  padding: 0.75rem 1rem;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--text-secondary);
}
.pm-notice--warn {
  border-left-color: var(--status-warning);
}
.pm-notice--good {
  border-left-color: var(--status-success);
  color: var(--text-primary);
}

/* ── Sides ── */
.pm-chart {
  margin-bottom: 0.9rem;
}
.pm-sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.pm-side {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  padding: 0.9rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}
.pm-side--won {
  border-color: color-mix(in srgb, var(--status-success) 45%, transparent);
}
.pm-side--lost {
  opacity: 0.6;
}
.pm-side-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.pm-side-name {
  font-family: var(--font-ui);
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  overflow-wrap: anywhere;
}

.pm-side-prices {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
}
.pm-side-prices dt {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-secondary);
}
.pm-side-prices dd {
  margin: 0.1rem 0 0;
}
.pm-price {
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--brand-primary);
  font-variant-numeric: tabular-nums;
}
.pm-price--dim {
  font-size: 0.85rem;
  color: var(--text-primary);
}

/* ── Depth ── */
.pm-depth {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.pm-depth-title {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-secondary);
}
.pm-depth-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}
.pm-depth-table th {
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  padding: 0.2rem 0;
  border-bottom: 1px solid var(--surface-border);
}
.pm-depth-table td {
  padding: 0.28rem 0;
  color: var(--text-primary);
  border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
}
.pm-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pm-depth-table td.pm-num,
.pm-depth-table th:last-child {
  text-align: right;
}
.pm-depth-empty {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

/* ── Ticket ── */
.pm-ticket,
.pm-block {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  padding: 1rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.pm-section-title {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--brand-primary);
  margin: 0;
}
.pm-ticket-locked {
  margin: 0;
  font-size: 0.85rem;
  color: var(--status-warning);
}

.pm-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  border: none;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.pm-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-secondary);
  padding: 0;
}
.pm-picker {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}
.pm-pick {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  text-align: left;
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-sm, 8px);
  padding: 0.6rem 0.7rem;
  cursor: pointer;
  color: var(--text-primary);
  transition: border-color var(--duration-fast, 200ms), background var(--duration-fast, 200ms);
  min-width: 0;
}
.pm-pick:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.pm-pick--on {
  border-color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
}
.pm-pick-name {
  font-weight: 700;
  font-size: 0.88rem;
  overflow-wrap: anywhere;
}
.pm-pick-price {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.pm-inputs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.pm-input {
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-sm, 8px);
  padding: 0.55rem 0.7rem;
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 1rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  width: 100%;
}
.pm-input:focus {
  outline: none;
  border-color: var(--brand-primary);
}
.pm-hint {
  font-size: 0.7rem;
  color: var(--text-secondary);
  line-height: 1.4;
}
.pm-hint--strong {
  color: var(--brand-primary);
  font-weight: 600;
}

.pm-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.5rem;
  margin: 0;
  background: var(--surface-base);
  border-radius: var(--radius-sm, 8px);
  padding: 0.75rem;
}
.pm-summary dt {
  font-size: 0.67rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  line-height: 1.3;
}
.pm-summary dd {
  margin: 0.15rem 0 0;
  font-family: var(--font-ui);
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.pm-good {
  color: var(--status-success);
}
.pm-bad {
  color: var(--status-error);
}

.pm-rules {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-left: 3px solid var(--brand-primary);
  background: var(--surface-base);
  border-radius: var(--radius-sm, 8px);
  padding: 0.7rem 0.85rem;
}
.pm-rule {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.55;
  color: var(--text-secondary);
}

.pm-error {
  margin: 0;
  font-size: 0.82rem;
  color: var(--status-error);
}
.pm-success {
  margin: 0;
  font-size: 0.82rem;
  color: var(--status-success);
}

.pm-btn {
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.85rem;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  border: none;
  border-radius: 8px;
  padding: 0.7rem 1.4rem;
  cursor: pointer;
  text-decoration: none;
  text-align: center;
  transition: opacity var(--duration-fast, 200ms);
}
.pm-btn:hover:not(:disabled) {
  opacity: 0.9;
}
.pm-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pm-btn--wide {
  width: 100%;
}
.pm-btn--ghost {
  background: transparent;
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
  padding: 0.4rem 0.9rem;
  font-size: 0.72rem;
}

.pm-signin {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.pm-signin p {
  margin: 0;
}

/* ── Rows ── */
.pm-block-note {
  margin: -0.35rem 0 0;
  font-size: 0.75rem;
  color: var(--text-secondary);
  line-height: 1.5;
}
.pm-block-empty {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-secondary);
}
.pm-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.pm-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-sm, 8px);
  padding: 0.6rem 0.75rem;
}
.pm-row--position {
  flex-direction: column;
  align-items: stretch;
}
.pm-row-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  min-width: 0;
}
.pm-row-name {
  font-weight: 700;
  font-size: 0.88rem;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.pm-row-price {
  font-family: var(--font-ui);
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--brand-primary);
  font-variant-numeric: tabular-nums;
}
.pm-row-fill {
  font-size: 0.75rem;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.pm-position-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 0.5rem;
  margin: 0.5rem 0 0;
}
.pm-position-stats dt {
  font-size: 0.64rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.pm-position-stats dd {
  margin: 0.1rem 0 0;
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

/* ── Tape ── */
.pm-tape {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.pm-tape-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.78rem;
  color: var(--text-secondary);
  padding: 0.25rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 50%, transparent);
}
.pm-tape-name {
  flex: 1;
  color: var(--text-primary);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.pm-tape-price {
  color: var(--brand-primary);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.pm-tape-qty {
  font-variant-numeric: tabular-nums;
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
}

@media (max-width: 560px) {
  .pm-sides,
  .pm-inputs,
  .pm-picker {
    grid-template-columns: 1fr;
  }
}
</style>
