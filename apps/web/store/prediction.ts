import { defineStore } from 'pinia'
import { toWholeBirr } from '@world-bingo/shared-types'
import type {
  PredictionBookPayload,
  PredictionHistoryPoint,
  PredictionMarketBook,
  PredictionMarketDto,
  PredictionPriceHistory,
  PredictionOrderDto,
  PredictionOutcomeDto,
  PredictionPositionDto,
  PredictionSettledPayload,
  PredictionStatusPayload,
  PredictionTradePayload,
} from '@world-bingo/shared-types'
import { useAuthStore } from '~/store/auth'

/**
 * Player-side state for the binary order-book prediction market.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE, before any of the fetching:
 *
 * 1. **No hardcoded share value.** A share pays `market.shareValue` ETB, not 100.
 *    Every price bound, every cost and every payout below is derived from the
 *    market's own `shareValue`, which arrives on the market and again on the book.
 *    The default happens to be 100 — which is exactly why the price in birr reads
 *    as a probability in percent — but nothing here may assume it.
 * 2. **Money never touches a JS float.** Amounts cross the wire as decimal
 *    strings (a Prisma `Decimal`, serialized). They are parsed into integer minor
 *    units with `BigInt`, multiplied and added as integers, and formatted back to
 *    a string. There is no `parseFloat`, no `Number()` and no `toFixed` on a money
 *    value anywhere in this feature's frontend.
 * 3. **Errors come back as codes, not sentences.** The API speaks English; the
 *    player may not. Every failure is mapped to a stable code the pages look up
 *    through i18n.
 *
 * Realtime lives in the page, not here: `[id].vue` owns the socket lifecycle and
 * calls the `apply*` mutators below with each payload.
 */

// ─── Wire shapes ─────────────────────────────────────────────────────────────
// These mirror what `routes/prediction/index.ts` actually serializes: the DTO
// plus whatever context each endpoint attaches so a row can render standalone.

export interface PredictionMarketSummary extends PredictionMarketDto {
  outcomes: PredictionOutcomeDto[]
}

export interface PredictionMarketDetail extends PredictionMarketSummary {
  book: PredictionMarketBook
}

export interface PredictionOrderRow extends PredictionOrderDto {
  market: {
    id: string
    eventName: string
    question: string
    status: string
    shareValue: string
    closesAt: string
  }
  outcome: PredictionOutcomeDto
}

export interface PredictionPositionRow extends PredictionPositionDto {
  market: PredictionMarketSummary
  outcome: PredictionOutcomeDto
}

/** One fill on the tape. */
export interface PredictionTradeTick {
  outcomeId: string
  price: string
  quantity: number
  at: string
}

export interface PlaceOrderResult {
  order: PredictionOrderRow
  /** The taker's own executions — empty when the whole order rested. */
  fills: Array<{ quantity: number; price: string }>
  realBalance: string
  bonusBalance: string
}

export interface PlaceOrderInput {
  marketId: string
  outcomeId: string
  /** Whole birr. Prices move in 1 ETB ticks, so this is an integer by contract. */
  limitPrice: number
  quantity: number
}

/** Stable failure codes; the pages translate them via `prediction.errors.*`. */
export type PredictionErrorCode =
  | 'notAuthenticated'
  | 'insufficientFunds'
  | 'marketClosed'
  | 'invalidOrder'
  | 'notYourOrder'
  | 'orderGone'
  | 'failed'

// ─── Money, in integer minor units ───────────────────────────────────────────

/** Two decimal places, matching every `@db.Decimal(_, 2)` column in the schema. */
const MINOR_UNITS = 100n

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/

/**
 * Read a decimal string ('35', '35.00', '-2.50') into integer minor units.
 *
 * Text in, integer out — the fractional part is padded and sliced as characters,
 * never parsed as a float. Anything unrecognizable reads as zero rather than
 * `NaN`, so a malformed field degrades to '0' on screen instead of poisoning
 * every sum it takes part in.
 */
export function toMinor(value: string | null | undefined): bigint {
  if (value === null || value === undefined) return 0n
  const match = DECIMAL_TEXT.exec(String(value).trim())
  if (!match) return 0n
  const magnitude = BigInt(match[2]) * MINOR_UNITS + BigInt((match[3] ?? '').padEnd(2, '0').slice(0, 2))
  return match[1] === '-' ? -magnitude : magnitude
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Format minor units for display: '1,250' when whole, '1,250.75' when not.
 *
 * Trailing '.00' is dropped on purpose. Prices sit on whole 1 ETB ticks and
 * costs are price x shares, so almost everything on these pages is a round
 * number; printing '35.00 ETB (35%)' would bury the point that the two numbers
 * are the same one.
 */
export function formatMinor(minor: bigint): string {
  const negative = minor < 0n
  const magnitude = negative ? -minor : minor
  const whole = groupThousands((magnitude / MINOR_UNITS).toString())
  const fraction = magnitude % MINOR_UNITS
  const text = fraction === 0n ? whole : `${whole}.${fraction.toString().padStart(2, '0')}`
  return negative ? `-${text}` : text
}

/** Format a wire amount straight through, with a dash for a missing value. */
export function formatAmount(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return formatMinor(toMinor(value))
}

/**
 * A price as a percentage of the market's share value.
 *
 * This is THE teaching device of the whole product: at a 100 ETB share, 35 ETB
 * and 35% are the same number, and showing both together explains the mechanism
 * without a paragraph of copy. Computed from `shareValue` so it stays honest on
 * a market that runs a different denomination.
 *
 * Returned without the '%' sign — the sign belongs to the i18n string.
 */
export function percentOfShareMinor(priceMinor: bigint, shareMinor: bigint): string {
  if (shareMinor <= 0n) return '—'
  // price / shareValue x 100, carried to two decimals as an integer.
  const hundredths = (priceMinor * 10000n) / shareMinor
  const whole = hundredths / 100n
  const fraction = hundredths % 100n
  if (fraction === 0n) return whole.toString()
  const text = fraction.toString().padStart(2, '0').replace(/0$/, '')
  return `${whole}.${text}`
}

/** Wire-string form of {@link percentOfShareMinor}. */
export function percentOfShare(price: string | null | undefined, shareValue: string): string {
  if (price === null || price === undefined || price === '') return '—'
  return percentOfShareMinor(toMinor(price), toMinor(shareValue))
}

/** Whole birr as minor units. `birr` is a tick count, not a money value. */
export function birrToMinor(birr: number): bigint {
  return BigInt(Math.trunc(birr)) * MINOR_UNITS
}

/** Minor units as an ungrouped decimal string — the wire form, rebuilt. */
function toPlainDecimal(minor: bigint): string {
  const negative = minor < 0n
  const magnitude = negative ? -minor : minor
  const text = `${magnitude / MINOR_UNITS}.${(magnitude % MINOR_UNITS).toString().padStart(2, '0')}`
  return negative ? `-${text}` : text
}

/**
 * Minor units back to a whole number of birr, for the order ticket's 1 ETB tick
 * grid. THROWS on a fractional amount rather than rounding one onto a tick — the
 * full decimal is handed to `toWholeBirr`, not a pre-truncated one, so the
 * refusal is real. Callers fall back to their own default when it throws.
 */
export function minorToWholeBirr(minor: bigint): number {
  return toWholeBirr(toPlainDecimal(minor))
}

/** Integer division rounded half up. Both arguments must be non-negative. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) return 0n
  return (numerator * 2n + denominator) / (denominator * 2n)
}

/**
 * The house fee: `feePct` of PROFIT, never of the gross payout, clamped at zero.
 *
 * On gross, a share bought at 90 would return 85 — right about the fight and
 * still down 5 birr — which quietly caps the book below where a main-event
 * favourite actually trades. Mirrors `settlement.service.ts` including its
 * half-up rounding, so the ticket's preview matches what settlement pays.
 */
export function feeOnProfit(profitMinor: bigint, feePct: string): bigint {
  if (profitMinor <= 0n) return 0n
  return divideRoundHalfUp(profitMinor * toMinor(feePct), 100n * MINOR_UNITS)
}

// ─── The fight card ──────────────────────────────────────────────────────────

export type DisciplineKey = 'mma' | 'boxing' | 'muayThai' | 'other'

/** Running order of the card: MMA headlines, Muay Thai closes the undercard. */
export const DISCIPLINE_ORDER: readonly DisciplineKey[] = ['mma', 'boxing', 'muayThai', 'other']

const DISCIPLINE_BY_LABEL: Record<string, DisciplineKey> = {
  mma: 'mma',
  boxing: 'boxing',
  'muay thai': 'muayThai',
}

export interface BoutMeta {
  discipline: DisciplineKey
  /** Weight class and round count, as authored. Free text — may be empty. */
  detail: string
  mainEvent: boolean
}

/**
 * Pull the discipline out of a market description.
 *
 * The seed writes '<Discipline> — <weight class>, <rounds> rounds' with an
 * optional ' — Main Event' tail, and there is no discipline column to read
 * instead. An unrecognized head falls into 'other' rather than being dropped, so
 * a market authored by hand in the admin UI still appears on the card.
 */
export function boutMetaOf(description: string | null | undefined): BoutMeta {
  const raw = (description ?? '').trim()
  const segments = raw
    .split('—')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  const discipline = DISCIPLINE_BY_LABEL[(segments[0] ?? '').toLowerCase()] ?? 'other'
  const detail = segments
    .slice(discipline === 'other' ? 0 : 1)
    .filter((segment) => !/^main event$/i.test(segment))
    .join(' · ')

  return { discipline, detail, mainEvent: /main event/i.test(raw) }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

function statusOf(error: unknown): number | null {
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  const value = candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status
  return typeof value === 'number' ? value : null
}

function messageOf(error: unknown): string {
  const data = (error as { data?: { error?: unknown } })?.data?.error
  if (typeof data === 'string') return data
  return String((error as { message?: unknown })?.message ?? '')
}

/**
 * Map a thrown fetch error onto a translatable code.
 *
 * Status first, message second — the routes attach an accurate status to
 * everything, and matching on English prose is a fallback, not the contract.
 */
function errorCodeOf(error: unknown): PredictionErrorCode {
  const message = messageOf(error)
  if (/insufficient funds/i.test(message)) return 'insufficientFunds'

  switch (statusOf(error)) {
    case 401:
      return 'notAuthenticated'
    case 403:
      return 'notYourOrder'
    case 404:
      return 'orderGone'
    case 409:
      return 'marketClosed'
    case 400:
      return 'invalidOrder'
    default:
      return /not authenticated|session expired/i.test(message) ? 'notAuthenticated' : 'failed'
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

/** How many fills the tape keeps. Enough to show the book is alive. */
const TRADE_TAPE_LIMIT = 12

interface PredictionState {
  markets: PredictionMarketSummary[]
  marketsLoading: boolean
  marketsFailed: boolean
  market: PredictionMarketDetail | null
  marketLoading: boolean
  marketMissing: boolean
  orders: PredictionOrderRow[]
  ordersLoading: boolean
  positions: PredictionPositionRow[]
  positionsLoading: boolean
  trades: PredictionTradeTick[]
  history: PredictionPriceHistory | null
  historyLoading: boolean
  placing: boolean
  cancellingId: string | null
  orderError: PredictionErrorCode | null
  lastResult: PlaceOrderResult | null
}

export const usePredictionStore = defineStore('prediction', {
  state: (): PredictionState => ({
    markets: [],
    marketsLoading: false,
    marketsFailed: false,
    market: null,
    marketLoading: false,
    marketMissing: false,
    orders: [],
    ordersLoading: false,
    positions: [],
    positionsLoading: false,
    trades: [],
    history: null,
    historyLoading: false,
    placing: false,
    cancellingId: null,
    orderError: null,
    lastResult: null,
  }),

  getters: {
    /** Outcomes in book order — sortOrder 0 is fighter A, 1 is fighter B. */
    outcomes: (state): PredictionOutcomeDto[] =>
      [...(state.market?.outcomes ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),

    /** Orders that still hold a reserve and can still be cancelled. */
    restingOrders: (state): PredictionOrderRow[] =>
      state.orders.filter((order) => order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED'),

    /** Only positions with shares are worth a row; a zeroed one is noise. */
    heldPositions: (state): PredictionPositionRow[] =>
      state.positions.filter((position) => position.shares > 0),
  },

  actions: {
    // ── Reads ────────────────────────────────────────────────────────────────

    /** The card. Published markets only — the API never returns drafts. */
    async fetchMarkets() {
      const config = useRuntimeConfig()
      this.marketsLoading = true
      this.marketsFailed = false
      try {
        const data = await $fetch<{ markets: PredictionMarketSummary[]; nextCursor: string | null }>(
          `${config.public.apiBase}/prediction/markets?limit=100`,
        )
        this.markets = data.markets ?? []
      } catch {
        // A 404 here is the feature flag being off, which the page handles by
        // redirecting; anything else leaves the list empty with a retry.
        this.markets = []
        this.marketsFailed = true
      } finally {
        this.marketsLoading = false
      }
    },

    /** One market with both outcomes and the aggregated book. */
    async fetchMarket(marketId: string) {
      const config = useRuntimeConfig()
      this.marketLoading = true
      this.marketMissing = false
      try {
        this.market = await $fetch<PredictionMarketDetail>(
          `${config.public.apiBase}/prediction/markets/${marketId}`,
        )
      } catch {
        this.market = null
        this.marketMissing = true
      } finally {
        this.marketLoading = false
      }
    },

    /** Re-read depth without disturbing the rest of the page. */
    async fetchBook(marketId: string) {
      const config = useRuntimeConfig()
      try {
        const book = await $fetch<PredictionMarketBook>(
          `${config.public.apiBase}/prediction/markets/${marketId}/book`,
        )
        if (this.market?.id === marketId) this.market.book = book
      } catch {
        // Depth is a read model; the next socket emit or reload corrects it.
      }
    },

    /** The price trajectory for the chart. Live trades extend it via applyTrade. */
    async fetchHistory(marketId: string) {
      const config = useRuntimeConfig()
      this.historyLoading = true
      try {
        const history = await $fetch<PredictionPriceHistory>(
          `${config.public.apiBase}/prediction/markets/${marketId}/history`,
        )
        // Guard against a stale response landing after the user moved markets.
        if (this.market?.id === marketId || this.history?.marketId === marketId) {
          this.history = history
        }
      } catch {
        // A missing chart is not fatal; the empty state covers it.
      } finally {
        this.historyLoading = false
      }
    },

    /** The caller's own resting orders in one market. */
    async fetchMyOrders(marketId: string) {
      const auth = useAuthStore()
      if (!auth.isAuthenticated) {
        this.orders = []
        return
      }
      this.ordersLoading = true
      try {
        const data = await auth.apiFetch<{ orders: PredictionOrderRow[]; nextCursor: string | null }>(
          `/prediction/orders?marketId=${marketId}&status=OPEN,PARTIALLY_FILLED&limit=100`,
        )
        this.orders = data.orders ?? []
      } catch {
        this.orders = []
      } finally {
        this.ordersLoading = false
      }
    },

    /** The caller's own positions, optionally narrowed to one market. */
    async fetchMyPositions(marketId?: string) {
      const auth = useAuthStore()
      if (!auth.isAuthenticated) {
        this.positions = []
        return
      }
      this.positionsLoading = true
      try {
        const query = marketId ? `?marketId=${marketId}&limit=100` : '?limit=100'
        const data = await auth.apiFetch<{
          positions: PredictionPositionRow[]
          nextCursor: string | null
        }>(`/prediction/positions${query}`)
        this.positions = data.positions ?? []
      } catch {
        this.positions = []
      } finally {
        this.positionsLoading = false
      }
    },

    // ── Writes ───────────────────────────────────────────────────────────────

    /**
     * Place a buy-only limit order.
     *
     * The reserve leaves the wallet immediately, so the wallet is re-read on the
     * way out. A response with no fills is the ordinary outcome in a young book:
     * the order is resting, not rejected, and the page says so.
     */
    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult | null> {
      const auth = useAuthStore()
      this.orderError = null
      this.lastResult = null

      if (!auth.isAuthenticated) {
        this.orderError = 'notAuthenticated'
        return null
      }

      this.placing = true
      try {
        const result = await auth.apiFetch<PlaceOrderResult>('/prediction/orders', {
          method: 'POST',
          body: {
            marketId: input.marketId,
            outcomeId: input.outcomeId,
            limitPrice: input.limitPrice,
            quantity: input.quantity,
          },
        })
        this.lastResult = result
        await Promise.all([
          this.fetchMyOrders(input.marketId),
          this.fetchMyPositions(input.marketId),
          this.fetchBook(input.marketId),
          auth.fetchWallet(),
        ])
        return result
      } catch (error) {
        this.orderError = errorCodeOf(error)
        return null
      } finally {
        this.placing = false
      }
    },

    /**
     * Cancel a resting order.
     *
     * Releases exactly the unfilled reserve. Shares that already filled are a
     * position now and are untouched — there is no cash-out in this version.
     */
    async cancelOrder(orderId: string, marketId: string): Promise<boolean> {
      const auth = useAuthStore()
      this.orderError = null
      this.cancellingId = orderId
      try {
        await auth.apiFetch(`/prediction/orders/${orderId}`, { method: 'DELETE' })
        await Promise.all([this.fetchMyOrders(marketId), this.fetchBook(marketId), auth.fetchWallet()])
        return true
      } catch (error) {
        this.orderError = errorCodeOf(error)
        return false
      } finally {
        this.cancellingId = null
      }
    },

    clearOrderError() {
      this.orderError = null
      this.lastResult = null
    },

    // ── Realtime mutators, driven by `[id].vue` ──────────────────────────────

    /** `prediction:book` — full depth for both sides, coalesced server-side. */
    applyBook(payload: PredictionBookPayload) {
      if (this.market?.id !== payload.marketId) return
      // The socket payload carries no `shareValue`; the market's own is the
      // authority and must survive a depth refresh untouched.
      this.market.book = { ...this.market.book, outcomes: payload.outcomes }
      for (const side of payload.outcomes) {
        const outcome = this.market.outcomes.find((entry) => entry.id === side.outcomeId)
        if (outcome) outcome.lastPrice = side.lastPrice
      }
    },

    /** `prediction:trade` — one fill, never coalesced. */
    applyTrade(payload: PredictionTradePayload) {
      if (this.market?.id !== payload.marketId) return
      this.trades = [
        { outcomeId: payload.outcomeId, price: payload.price, quantity: payload.quantity, at: payload.at },
        ...this.trades,
      ].slice(0, TRADE_TAPE_LIMIT)

      const outcome = this.market.outcomes.find((entry) => entry.id === payload.outcomeId)
      if (outcome) outcome.lastPrice = payload.price

      // Extend the chart in real time. The line tracks the reference outcome, so
      // a trade on the OTHER side is mirrored across the share value — exactly
      // how the backend derives the series — keeping the live line consistent
      // with a reload. Bounded so a long session cannot grow it without limit.
      if (this.history) {
        const share = Number(this.history.shareValue)
        const price =
          payload.outcomeId === this.history.outcomeId
            ? payload.price
            : (share - Number(payload.price)).toString()
        const point: PredictionHistoryPoint = { t: payload.at, price, shares: payload.quantity }
        this.history.points = [...this.history.points, point].slice(-600)
      }
    },

    /** `prediction:status` — a lifecycle transition. */
    applyStatus(payload: PredictionStatusPayload) {
      if (this.market?.id !== payload.marketId) return
      this.market.status = payload.status
      this.market.winningOutcomeId = payload.winningOutcomeId ?? null
      this.market.disputeUntil = payload.disputeUntil ?? null

      const listed = this.markets.find((entry) => entry.id === payload.marketId)
      if (listed) listed.status = payload.status
    },

    /** `prediction:settled` — winners paid, house fee booked. */
    applySettled(payload: PredictionSettledPayload) {
      if (this.market?.id !== payload.marketId) return
      this.market.status = 'SETTLED'
      this.market.winningOutcomeId = payload.winningOutcomeId
      this.market.totalShares = payload.totalShares
    },

    /** Drop per-market state so a second market never renders the first's book. */
    resetMarket() {
      this.market = null
      this.marketMissing = false
      this.orders = []
      this.positions = []
      this.trades = []
      this.history = null
      this.orderError = null
      this.lastResult = null
    },
  },
})
