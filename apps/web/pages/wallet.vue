<script setup lang="ts">
import type { PromotionProgressDto, PublicPromotionDto } from '@world-bingo/shared-types'
import { useAuthStore } from '~/store/auth'
import { usePromotionsStore } from '~/store/promotions'
import { expiresTonight } from '~/utils/bonus-expiry'

const auth = useAuthStore()
const promos = usePromotionsStore()
const router = useRouter()
const { t, te } = useI18n()

// Redirect unauthenticated users
onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.replace('/auth/login')
    return
  }
  await Promise.all([
    refreshBalance(),
    fetchRecentTx(),
    fetchBonusGrants(),
    promos.fetch(),
    promos.fetchProgress(),
  ])
  await claimReturnedDeposit()
})

const route = useRoute()
const confirmingDeposit = ref(false)

/**
 * ZareCash sends the player back with ?deposit=dp_…&status=pending.
 *
 * "pending" means a receipt was accepted, NOT that money arrived — the balance
 * moves only when the deposit.approved webhook lands. So this records the
 * pending deposit and shows a waiting state. It must never credit anything.
 */
async function claimReturnedDeposit() {
  const depositId = route.query.deposit
  if (typeof depositId !== 'string' || !depositId) return
  // Strip the query first, so a refresh does not replay this.
  router.replace({ path: '/wallet' })
  confirmingDeposit.value = true
  try {
    await auth.apiFetch('/wallet/deposit/checkout/claim', {
      method: 'POST',
      body: { depositId },
    })
  } catch {
    // The webhook is the source of truth and creates the row without us.
    // A failed claim is not worth alarming the player over.
  }
  await Promise.all([refreshBalance(), fetchRecentTx()])
}

const showDeposit = ref(false)
const showWithdrawal = ref(false)
const refreshing = ref(false)
const txLoading = ref(false)
const recentTx = ref<any[]>([])

// ── Spend-account toggle ──────────────────────────────────────────
const spendAccount = computed(() => auth.wallet?.spendAccount ?? 'REAL')
const togglingAccount = ref(false)
const spendAccountError = ref('')

async function setSpendAccount(account: 'REAL' | 'BONUS') {
  if (account === spendAccount.value || togglingAccount.value) return
  togglingAccount.value = true
  spendAccountError.value = ''
  try {
    await auth.apiFetch('/wallet/spend-account', { method: 'PATCH', body: { account } })
    await auth.fetchWallet()
  } catch {
    spendAccountError.value = 'Could not switch account. Please try again.'
  } finally {
    togglingAccount.value = false
  }
}

/** Every amount on this page, so the same money never reads two ways. */
function formatMoney(value: number | string): string {
  return Number(value).toLocaleString('en-ET', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// ── Active bonus grants ─────────────────────────────────────────────
/** One lot as `/wallet/bonus-grants` answers it. `source` is newer than the route. */
interface BonusGrantRow {
  id: string
  amount: number
  remaining: number
  expiresAt: string | null
  ruleName: string | null
  source?: string | null
  createdAt: string
}

const bonusGrants = ref<BonusGrantRow[]>([])
const grantsLoading = ref(false)

/** Below this much left, a lot is drawn as urgent. */
const URGENT_MS = 6 * 3_600_000
/** Below this much left, the spend-account nudge appears. */
const NUDGE_MS = 24 * 3_600_000

// Countdowns must move without a refresh: both the urgency treatment and the
// switch nudge flip on this clock, and someone watching the last hour of a lot
// should see it run down rather than a figure frozen when the page loaded.
const now = ref(Date.now())
let countdownClock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  countdownClock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onUnmounted(() => clearInterval(countdownClock))

async function fetchBonusGrants() {
  grantsLoading.value = true
  try {
    bonusGrants.value = await auth.apiFetch<BonusGrantRow[]>('/wallet/bonus-grants')
  } catch {
    // non-critical — the balance card still works without the grants list
  } finally {
    grantsLoading.value = false
  }
}

/**
 * One tone per source, keyed by the BonusSource values the route sends. The
 * words live at `wallet.bonusSource.<source>` under that same key, so a source
 * can never arrive with a colour but no label of its own.
 */
const BONUS_SOURCE_TONES: Record<string, string> = {
  CASHBACK: 'cyan',
  FIRST_DEPOSIT: 'emerald',
  DAILY_DEPOSIT: 'amber',
  WEEKLY_DEPOSIT: 'amber',
  CAMPAIGN: 'violet',
  ADMIN: 'slate',
  REFUND: 'slate',
}

/**
 * Where a lot came from, as the player should read it. `source` is NOT NULL in
 * the schema, so a lot without one can only have come from an API build older
 * than the field — naming no provenance beats guessing one, and 'Goodwill' on a
 * cashback lot is a guess. That bare noun has no key yet, so it ships English
 * `wallet.bonusGeneric` names no provenance rather than guessing one: 'Goodwill'
 * on a legacy cashback lot would be a lie.
 */
function sourceChip(source: string | null | undefined): { label: string; tone: string } {
  const tone = source ? BONUS_SOURCE_TONES[source] : undefined
  if (!tone) {
    return { label: t('wallet.bonusGeneric'), tone: 'slate' }
  }
  return { label: t(`wallet.bonusSource.${source}`), tone }
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}${t('prediction.unitDay')} ${hours % 24}${t('prediction.unitHour')}`
  if (hours > 0) return `${hours}${t('prediction.unitHour')}`
  return `${Math.floor(ms / 60_000)}${t('prediction.unitMinute')}`
}

function formatTimeRemaining(expiresAt: string | null): string {
  if (!expiresAt) return t('wallet.bonusNoExpiry')
  const ms = new Date(expiresAt).getTime() - now.value
  if (ms <= 0) return t('wallet.bonusExpiring')
  return t('wallet.bonusExpiresIn', { time: formatDuration(ms) })
}

const bonusLots = computed(() =>
  bonusGrants.value.map((grant) => {
    const expiresAt = grant.expiresAt ? new Date(grant.expiresAt).getTime() : null
    const msLeft = expiresAt === null ? null : Math.max(0, expiresAt - now.value)
    // The bar reads as "how much of this lot's life is left", so it is scaled to
    // the lot's own validity rather than a fixed span: a 24h deposit bonus and a
    // 7-day cashback lot both start full and each empties at its own pace.
    const validityMs =
      expiresAt === null ? null : Math.max(1, expiresAt - new Date(grant.createdAt).getTime())
    return {
      ...grant,
      chip: sourceChip(grant.source),
      countdown: formatTimeRemaining(grant.expiresAt),
      msLeft,
      urgent: msLeft !== null && msLeft <= URGENT_MS,
      lifeLeftPct:
        msLeft === null || validityMs === null
          ? 100
          : Math.round(Math.min(1, msLeft / validityMs) * 100),
    }
  }),
)

const expiringLots = computed(() =>
  bonusLots.value.filter((lot) => lot.msLeft !== null && lot.msLeft <= NUDGE_MS),
)
// Only worth nudging while REAL is selected — on BONUS the player is already
// spending the lot that is about to expire.
const showSwitchNudge = computed(
  () => spendAccount.value === 'REAL' && expiringLots.value.length > 0,
)
const expiringTotal = computed(() =>
  expiringLots.value.reduce((sum, lot) => sum + Number(lot.remaining), 0),
)
// NUDGE_MS is a whole day wide, so "tonight" is only sometimes true. The soonest
// deadline decides the wording, through the same `expiresTonight` the lobby bar
// uses — the two surfaces describe one lot the same way or they look broken.
const expiringSoonest = computed(() =>
  expiringLots.value.reduce<number | null>((soonest, lot) => {
    const at = lot.msLeft === null ? null : now.value + lot.msLeft
    if (at === null) return soonest
    return soonest === null || at < soonest ? at : soonest
  }, null),
)
const expiryNudgeKey = computed(() =>
  expiringSoonest.value === null || expiresTonight(expiringSoonest.value, now.value)
    ? 'wallet.bonusExpiryNudge'
    : 'wallet.bonusExpiryNudgeWithinDay',
)

// ── Earn more — progress toward the live promotions ──────────────────


/**
 * Only offers this player is part-way through. An empty bar says less than the
 * promo tile already does, and the tiles carry every offer anyway.
 */
const earnMore = computed(() =>
  promos.promotions
    .map((promo) => ({ promo, progress: promos.progressFor(promo.refId) }))
    .filter(
      (row): row is { promo: PublicPromotionDto; progress: PromotionProgressDto } =>
        row.progress !== null,
    ),
)

/** Falls back to the raw enum value, which is at least not a key path. */
function promoKindLabel(kind: string): string {
  const key = `promo.kind.${kind}`
  return te(key) ? t(key) : kind
}

/**
 * The precision the API itself prints, because `progress.hint` lands right under
 * these figures: rounding to whole ETB put a bar reading '5,000 / 5,000' above
 * the API's own '0.4 ETB to go'. Trailing zeros still go, so 5000 reads '5,000'.
 */
function formatFigure(value: number): string {
  return Number(value).toLocaleString('en-ET', { maximumFractionDigits: 2 })
}

/**
 * Clamped at BOTH ends. `current` is signed — the cashback net-loss query
 * credits wins as negatives — so a player up on the period gives a negative
 * percentage, and the browser drops a negative `width` outright; with none
 * declared in the CSS the fill then spanned its whole parent, drawing the
 * emptiest bar as the fullest. PromoTile clamps the same figure the same way.
 */
function progressPct(progress: PromotionProgressDto): number {
  if (!(progress.target > 0)) return 0
  return Math.max(0, Math.min(100, Math.round((progress.current / progress.target) * 100)))
}

function remainingToGo(progress: PromotionProgressDto): string {
  const remaining = Math.max(0, progress.target - progress.current)
  return t('wallet.bonusToGo', { amount: `${formatFigure(remaining)} ETB` })
}

const formattedRealBalance = computed(() => formatMoney(auth.wallet?.realBalance ?? 0))

const formattedBonusBalance = computed(() => formatMoney(auth.wallet?.bonusBalance ?? 0))

const formattedTotalBalance = computed(() =>
  formatMoney(Number(auth.wallet?.realBalance ?? 0) + Number(auth.wallet?.bonusBalance ?? 0)),
)

async function refreshBalance() {
  refreshing.value = true
  try {
    await auth.fetchWallet()
  } finally {
    refreshing.value = false
  }
}

async function fetchRecentTx() {
  txLoading.value = true
  try {
    const data = await auth.apiFetch<{ data: any[]; pagination: any }>('/wallet/transactions?limit=5')
    recentTx.value = data?.data ?? []
  } catch {
    // fail silently
  } finally {
    txLoading.value = false
  }
}

function txLabel(type: string): string {
  const map: Record<string, string> = {
    DEPOSIT: 'Deposit',
    WITHDRAWAL: 'Withdrawal',
    GAME_ENTRY: 'Game Entry',
    PRIZE_WIN: 'Prize Won',
    REFUND: 'Refund',
    FIRST_DEPOSIT_BONUS: 'Welcome Bonus',
    CASHBACK_BONUS: 'Cashback',
    DAILY_DEPOSIT_BONUS: 'Daily Deposit Bonus',
    WEEKLY_DEPOSIT_BONUS: 'Weekly Deposit Bonus',
    CAMPAIGN_BONUS: 'Campaign Bonus',
    BONUS_EXPIRED: 'Bonus Expired',
    ADMIN_REAL_ADJUSTMENT: 'Adjustment',
    ADMIN_BONUS_ADJUSTMENT: 'Bonus Adjustment',
    PREDICTION_ORDER_HOLD: 'Prediction Stake',
    PREDICTION_ORDER_RELEASE: 'Stake Returned',
    PREDICTION_WIN: 'Prediction Win',
    PREDICTION_REFUND: 'Prediction Refund',
    TP_BET: 'Game Bet',
    TP_WIN: 'Game Win',
    TP_ROLLBACK: 'Bet Reversed',
    TP_ADJUSTMENT: 'Game Adjustment',
  }
  return map[type] ?? type
}

const TX_CREDIT_TYPES = [
  'DEPOSIT',
  'PRIZE_WIN',
  'REFUND',
  'FIRST_DEPOSIT_BONUS',
  'CASHBACK_BONUS',
  'DAILY_DEPOSIT_BONUS',
  'WEEKLY_DEPOSIT_BONUS',
  'CAMPAIGN_BONUS',
  'PREDICTION_ORDER_RELEASE',
  'PREDICTION_WIN',
  'PREDICTION_REFUND',
  'TP_WIN',
  'TP_ROLLBACK',
]

const TX_DEBIT_TYPES = [
  'WITHDRAWAL',
  'GAME_ENTRY',
  'BONUS_EXPIRED',
  'PREDICTION_ORDER_HOLD',
  'TP_BET',
]

/** The fields of a transaction this page reads. Decimals arrive as strings. */
interface TxRow {
  type: string
  amount: number | string
  balanceBefore?: number | string | null
  balanceAfter?: number | string | null
  bonusBalanceBefore?: number | string | null
  bonusBalanceAfter?: number | string | null
}

/**
 * Whether a row put money in. The three adjustment types cannot be read from
 * the type alone: the admin pair writes a signed `amount` and TP_ADJUSTMENT
 * writes an absolute one, so for those the balance columns are the only truth.
 */
function txIsCredit(tx: TxRow): boolean {
  if (TX_CREDIT_TYPES.includes(tx.type)) return true
  if (TX_DEBIT_TYPES.includes(tx.type)) return false
  const delta =
    Number(tx.balanceAfter ?? 0) -
    Number(tx.balanceBefore ?? 0) +
    (Number(tx.bonusBalanceAfter ?? 0) - Number(tx.bonusBalanceBefore ?? 0))
  if (delta !== 0) return delta > 0
  return Number(tx.amount) >= 0
}

function txSign(tx: TxRow): string {
  return txIsCredit(tx) ? '+' : '-'
}

function txAmountClass(tx: TxRow): string {
  return txIsCredit(tx) ? 'amount-positive' : 'amount-negative'
}

// The sign is already carried by txSign, so a signed adjustment must not print
// its own minus as well.
function txAmount(tx: TxRow): string {
  return `${txSign(tx)}${Math.abs(Number(tx.amount)).toFixed(2)} ETB`
}

function txStatusClass(status: string): string {
  const s = (status ?? '').toLowerCase()
  if (s === 'approved' || s === 'completed') return 'status-approved'
  if (s === 'rejected' || s === 'failed') return 'status-rejected'
  return 'status-pending'
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-ET', { month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="wallet-page">
    <div class="wallet-inner">
<!-- ── Header ───────────────────────────────────────────────── -->
      <div class="page-header">
        <h1 class="page-title">My Wallet</h1>
        <button
          class="refresh-btn-header"
          :disabled="refreshing"
          :title="refreshing ? 'Refreshing…' : 'Refresh balance'"
          @click="refreshBalance"
        >
          <svg
            class="refresh-icon"
            :class="{ spinning: refreshing }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <!-- ── Balance Card ─────────────────────────────────────────── -->
      <div class="balance-card">
        <div class="balance-label-row">
          <span class="balance-label">Total Balance</span>
        </div>
        <div class="balance-display">
          <span class="balance-amount">{{ formattedTotalBalance }}</span>
          <span class="balance-currency">ETB</span>
        </div>

        <!-- Dual balance breakdown -->
        <div class="balance-breakdown">
          <div class="balance-part">
            <span class="balance-part-label">Withdrawable</span>
            <span class="balance-part-value">{{ formattedRealBalance }} ETB</span>
          </div>
          <div class="balance-part balance-part--bonus">
            <span class="balance-part-label">Bonus</span>
            <span class="balance-part-value balance-part-value--bonus">{{ formattedBonusBalance }} ETB</span>
          </div>
        </div>

        <!-- Spend account toggle -->
        <div class="spend-account-row">
          <span class="balance-part-label">{{ t('wallet.spendFrom') }}</span>
          <div class="spend-toggle" role="group" :aria-label="t('wallet.spendFrom')">
            <button
              type="button"
              class="spend-toggle-btn"
              :class="{ 'spend-toggle-btn--active': spendAccount === 'REAL' }"
              :disabled="togglingAccount"
              @click="setSpendAccount('REAL')"
            >
              {{ t('wallet.spendAccountReal') }}
            </button>
            <button
              type="button"
              class="spend-toggle-btn"
              :class="{ 'spend-toggle-btn--active': spendAccount === 'BONUS' }"
              :disabled="togglingAccount"
              @click="setSpendAccount('BONUS')"
            >
              {{ t('wallet.spendAccountBonus') }}
            </button>
          </div>
        </div>
        <p v-if="spendAccountError" class="spend-account-error">{{ spendAccountError }}</p>

        <!-- The question support answers most often, answered where it is asked. -->
        <div class="bonus-explainer">
          <svg class="bonus-explainer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
            <circle cx="12" cy="12" r="9" stroke-linecap="round" />
            <path stroke-linecap="round" d="M12 11v5" />
            <path stroke-linecap="round" d="M12 8h.01" />
          </svg>
          <p class="bonus-explainer-text">{{ t('wallet.bonusExplainer') }}</p>
        </div>

        <p v-if="confirmingDeposit" class="deposit-confirming">
          <span aria-hidden="true">⏳</span>{{ t('wallet.confirmingDeposit') }}
        </p>

        <!-- Actions -->
        <div class="action-row">
          <button class="action-btn action-btn--deposit" @click="showDeposit = true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Deposit
          </button>
          <button class="action-btn action-btn--withdraw" @click="showWithdrawal = true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 20V4m-8 8l8-8 8 8" />
            </svg>
            Withdraw
          </button>
        </div>
      </div>

      <!-- ── My Bonuses ───────────────────────────────────────────── -->
      <div v-if="bonusLots.length" class="section">
        <div class="section-header">
          <span class="section-title">{{ t('wallet.myBonuses') }}</span>
          <!-- 'History' alone does not say which history it is out of context. -->
          <NuxtLink
            to="/transactions"
            class="section-link bonus-history-link"
            :aria-label="t('wallet.bonusHistory')"
          >
            {{ t('wallet.history') }} →
          </NuxtLink>
        </div>

        <div class="tx-card">
          <div v-for="lot in bonusLots" :key="lot.id" class="lot" :class="`tone--${lot.chip.tone}`">
            <div class="lot-main">
              <div class="lot-icon">
                <!-- Cashback comes back to you; every other source is a gift. -->
                <svg v-if="lot.source === 'CASHBACK'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
                  <path stroke-linecap="round" d="M21 12a9 9 0 1 1-3.5-7.1" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M21 4v5h-5" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
                  <rect x="3" y="8" width="18" height="4" rx="1" stroke-linejoin="round" />
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 12v8h14v-8M12 8V4M12 8c-2 0-4-1.2-4-2.6S9.5 3 12 4M12 8c2 0 4-1.2 4-2.6S14.5 3 12 4" />
                </svg>
              </div>

              <div class="lot-info">
                <span class="lot-name">{{ lot.ruleName ?? lot.chip.label }}</span>
                <div class="lot-meta">
                  <span class="chip">{{ lot.chip.label }}</span>
                  <span class="lot-expiry" :class="{ 'lot-expiry--urgent': lot.urgent }">
                    {{ lot.countdown }}
                  </span>
                </div>
              </div>

              <span class="lot-amount">{{ formatMoney(lot.remaining) }} ETB</span>
            </div>

            <div
              class="lot-bar"
              role="progressbar"
              :aria-label="`Time left on ${lot.ruleName ?? lot.chip.label}`"
              :aria-valuenow="lot.lifeLeftPct"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div
                class="lot-bar-fill"
                :class="{ 'lot-bar-fill--urgent': lot.urgent }"
                :style="{ width: `${lot.lifeLeftPct}%` }"
              />
            </div>
          </div>

          <!-- Expiring bonus is only losable while real money is being spent first. -->
          <div v-if="showSwitchNudge" class="nudge">
            <svg class="nudge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.3 4.3 2.5 18a1.8 1.8 0 0 0 1.6 2.7h15.8A1.8 1.8 0 0 0 21.5 18L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" />
              <path stroke-linecap="round" d="M12 9.5v4" />
              <path stroke-linecap="round" d="M12 17h.01" />
            </svg>
            <p class="nudge-text">
              {{ t(expiryNudgeKey, { amount: `${formatMoney(expiringTotal)} ${t('common.etb')}` }) }}
            </p>
            <button
              type="button"
              class="nudge-btn"
              :disabled="togglingAccount"
              @click="setSpendAccount('BONUS')"
            >
              {{ t('wallet.switchToBonus') }}
            </button>
          </div>
        </div>
      </div>

      <!-- ── Earn More ────────────────────────────────────────────── -->
      <div v-if="earnMore.length" class="section">
        <div class="section-header">
          <span class="section-title">{{ t('wallet.earnMore') }}</span>
          <NuxtLink to="/promotions" class="section-link bonus-history-link">
            {{ t('promo.all_promotions') }} →
          </NuxtLink>
        </div>

        <div class="earn-list">
          <div
            v-for="row in earnMore"
            :key="`${row.promo.kind}:${row.promo.refId}`"
            class="earn-card"
            :class="`tone--${row.promo.accent}`"
          >
            <div class="earn-head">
              <div class="earn-head-text">
                <span class="earn-title">{{ row.promo.name }}</span>
                <span class="earn-sub">{{ row.promo.sub }}</span>
              </div>
              <span class="chip">{{ promoKindLabel(row.promo.kind) }}</span>
            </div>

            <div class="earn-progress">
              <div class="earn-figures">
                <span class="earn-label">{{ row.progress.label }}</span>
                <span class="earn-value">
                  {{ formatFigure(row.progress.current) }}
                  <span class="earn-target">/ {{ formatFigure(row.progress.target) }} ETB</span>
                </span>
              </div>
              <div
                class="earn-bar"
                role="progressbar"
                :aria-label="row.progress.label"
                :aria-valuenow="progressPct(row.progress)"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div class="earn-bar-fill" :style="{ width: `${progressPct(row.progress)}%` }" />
              </div>
            </div>

            <div class="earn-foot">
              <div class="earn-foot-text">
                <!-- The hint opens with the same figure, so it says it once. -->
                <span v-if="!row.progress.hint" class="earn-togo">
                  {{ remainingToGo(row.progress) }}
                </span>
                <span v-if="row.progress.hint" class="earn-hint">
                  <svg class="earn-hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
                    <circle cx="12" cy="12" r="9" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 7.5V12l3 2" />
                  </svg>
                  {{ row.progress.hint }}
                </span>
              </div>
              <button
                v-if="row.promo.action === 'deposit'"
                type="button"
                class="earn-btn"
                @click="showDeposit = true"
              >
                {{ t('wallet.deposit') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Recent Transactions ───────────────────────────────────── -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Recent Transactions</span>
          <NuxtLink to="/transactions" class="section-link">View all →</NuxtLink>
        </div>

        <div class="tx-card">
          <div v-if="txLoading" class="tx-loading">Loading…</div>
          <div v-else-if="recentTx.length === 0" class="tx-empty">No transactions yet.</div>
          <div v-else class="tx-list">
            <div v-for="(tx, i) in recentTx" :key="tx.id" class="tx-row" :class="{ 'tx-row--bordered': i < recentTx.length - 1 }">
              <!-- Icon -->
              <div class="tx-icon" :class="`tx-icon--${tx.type?.toLowerCase()}`">
                <!-- DEPOSIT -->
                <svg v-if="tx.type === 'DEPOSIT'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <!-- WITHDRAWAL -->
                <svg v-else-if="tx.type === 'WITHDRAWAL'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M12 20V4m-8 8l8-8 8 8" />
                </svg>
                <!-- PRIZE_WIN -->
                <svg v-else-if="tx.type === 'PRIZE_WIN'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0012 0V2z" />
                </svg>
                <!-- REFUND -->
                <svg v-else-if="tx.type === 'REFUND'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6M3 10l6-6" />
                </svg>
                <!-- GAME_ENTRY / default -->
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" stroke-linecap="round" stroke-linejoin="round" />
                  <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
                </svg>
              </div>

              <!-- Info -->
              <div class="tx-info">
                <span class="tx-type">{{ txLabel(tx.type) }}</span>
                <span class="tx-date">{{ formatRelativeTime(tx.createdAt) }}</span>
              </div>

              <!-- Amount + status -->
              <div class="tx-right">
                <span class="tx-amount" :class="txAmountClass(tx)">
                  {{ txAmount(tx) }}
                </span>
                <span class="tx-status" :class="txStatusClass(tx.status)">
                  {{ tx.status }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Quick Links ───────────────────────────────────────────── -->
      <div class="section">
        <div class="section-header">
          <span class="section-title">Quick Links</span>
        </div>
        <div class="quick-links">
          <NuxtLink to="/transactions" class="quick-link">
            <svg class="ql-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="12" cy="12" r="10" stroke-linecap="round" stroke-linejoin="round" />
              <polyline points="12 6 12 12 16 14" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <div class="ql-text">
              <span class="ql-title">Transaction History</span>
              <span class="ql-sub">View all deposits, withdrawals &amp; game entries</span>
            </div>
            <svg class="ql-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6" />
            </svg>
          </NuxtLink>

          <NuxtLink to="/profile" class="quick-link">
            <svg class="ql-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <circle cx="12" cy="8" r="4" stroke-linecap="round" stroke-linejoin="round" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            </svg>
            <div class="ql-text">
              <span class="ql-title">Profile &amp; Stats</span>
              <span class="ql-sub">View your game stats and account info</span>
            </div>
            <svg class="ql-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6" />
            </svg>
          </NuxtLink>
        </div>
      </div>
</div>

    <!-- ── Modals ──────────────────────────────────────────────────── -->
    <DepositModal
      v-model="showDeposit"
      @deposited="auth.fetchWallet(); showDeposit = false"
    />
    <WithdrawalModal
      v-model="showWithdrawal"
      :balance="Number(auth.wallet?.realBalance ?? 0)"
      @withdrawn="auth.fetchWallet(); showWithdrawal = false"
    />
  </div>
</template>

<style scoped>
.wallet-page {
  min-height: 100vh;
  background: var(--surface-base);
  padding-bottom: 40px;
}

.wallet-inner {
  max-width: 480px;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* ── Header ──────────────────────────────────────────────────────── */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.page-title {
  font-family: var(--font-ui);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-primary);
  margin: 0;
}
.refresh-btn-header {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  padding: 0.5rem;
  cursor: pointer;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  transition: background 0.2s, color 0.2s;
}
.refresh-btn-header:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: var(--brand-primary);
}
.refresh-btn-header:disabled { opacity: 0.4; cursor: not-allowed; }
.refresh-icon { width: 16px; height: 16px; }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Balance Card — echoes the home "Bingo" hero slide ────────────── */
.balance-card {
  position: relative;
  background: linear-gradient(105deg, #071633 0%, #0d2a5c 50%, #143b86 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-lg, 16px);
  padding: 1.6rem 1.75rem;
  box-shadow: var(--shadow-card, 0 4px 24px rgba(0, 0, 0, 0.4));
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow: hidden;
  isolation: isolate;
}
.balance-card::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 120% at 85% 0%, color-mix(in srgb, var(--brand-primary) 12%, transparent), transparent 55%);
  pointer-events: none;
  z-index: -1;
}

.balance-label-row { display: flex; align-items: center; }
.balance-label {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.55);
}

.balance-display {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.balance-amount {
  font-family: var(--font-ui);
  font-size: 2.6rem;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.balance-currency {
  font-family: var(--font-ui);
  font-size: 1rem;
  font-weight: 700;
  color: var(--brand-primary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* ── Balance Breakdown ───────────────────────────────────────────── */
.balance-breakdown {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.balance-part {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.balance-part-label {
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.7px;
  color: rgba(255, 255, 255, 0.45);
}
.balance-part-value {
  font-family: var(--font-ui);
  font-size: 1.05rem;
  font-weight: 700;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.balance-part-value--bonus {
  color: var(--brand-primary);
}

/* ── Spend Account Toggle ────────────────────────────────────────── */
.spend-account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 0.75rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.spend-toggle {
  display: flex;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-full, 9999px);
  padding: 3px;
  gap: 2px;
}
.spend-toggle-btn {
  padding: 0.35rem 0.9rem;
  border-radius: var(--radius-full, 9999px);
  border: none;
  background: transparent;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.spend-toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.spend-toggle-btn--active {
  background: var(--brand-primary);
  color: var(--text-on-brand);
}
.spend-account-error {
  margin: -0.5rem 0 0;
  font-size: 0.75rem;
  color: var(--status-error);
  text-align: right;
}

/* ── Bonus explainer ─────────────────────────────────────────────── */
.bonus-explainer {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: var(--radius-md, 12px);
  background: color-mix(in srgb, var(--brand-primary) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 30%, transparent);
}
.bonus-explainer-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--brand-primary);
}
.bonus-explainer-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  text-wrap: pretty;
}

/* ── Action Buttons ──────────────────────────────────────────────── */
.action-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  padding: 0.8rem 1rem;
  border-radius: var(--radius-md, 12px);
  border: 1px solid transparent;
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform 0.15s, background 0.2s, box-shadow 0.15s;
}
.action-btn:hover { transform: translateY(-1px); }
.action-btn:active { transform: translateY(0); }
.action-btn svg { width: 15px; height: 15px; flex-shrink: 0; }

.deposit-confirming {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  padding: 10px 14px;
  border-radius: var(--radius-md, 12px);
  background: color-mix(in srgb, var(--brand-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 34%, transparent);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.action-btn--deposit {
  background: var(--brand-primary);
  color: var(--text-on-brand);
}
.action-btn--deposit:hover {
  background: color-mix(in srgb, var(--brand-primary) 90%, white);
  box-shadow: 0 8px 22px color-mix(in srgb, var(--brand-primary) 40%, transparent);
}

.action-btn--withdraw {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border-color: rgba(255, 255, 255, 0.2);
}
.action-btn--withdraw:hover { background: rgba(255, 255, 255, 0.16); }

/* ── Section ─────────────────────────────────────────────────────── */
.section { display: flex; flex-direction: column; gap: 0.6rem; }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-title {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-secondary);
}
.section-link {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--brand-primary);
  text-decoration: none;
  transition: opacity 0.2s;
}
.section-link:hover { opacity: 0.75; }

/* ── Transaction Card ─────────────────────────────────────────────── */
.tx-card {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-lg, 16px);
  overflow: hidden;
}

.tx-loading,
.tx-empty {
  padding: 1.5rem;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.tx-list { display: flex; flex-direction: column; }

.tx-row {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.875rem 1rem;
}
.tx-row--bordered {
  border-bottom: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
}

.tx-icon {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md, 12px);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tx-icon svg { width: 16px; height: 16px; }

.tx-icon--deposit    { background: color-mix(in srgb, var(--status-success) 16%, transparent); color: var(--status-success); }
.tx-icon--withdrawal { background: color-mix(in srgb, var(--status-error) 16%, transparent); color: var(--status-error); }
.tx-icon--prize_win  { background: color-mix(in srgb, var(--brand-primary) 16%, transparent); color: var(--brand-primary); }
.tx-icon--refund     { background: color-mix(in srgb, var(--accent-primary) 22%, transparent); color: #a5b4fc; }
.tx-icon--game_entry { background: color-mix(in srgb, var(--accent-primary) 24%, transparent); color: #60a5fa; }

.tx-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.tx-type {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text-primary);
}
.tx-date {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.tx-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.2rem;
  flex-shrink: 0;
}
.tx-amount {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.amount-positive { color: var(--status-success); }
.amount-negative { color: var(--status-error); }

.tx-status {
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 0.12rem 0.5rem;
  border-radius: var(--radius-full, 9999px);
}
.status-approved { background: color-mix(in srgb, var(--status-success) 16%, transparent); color: var(--status-success); }
.status-rejected { background: color-mix(in srgb, var(--status-error) 16%, transparent); color: var(--status-error); }
.status-pending  { background: color-mix(in srgb, var(--brand-primary) 16%, transparent); color: var(--brand-primary); }

/* ── My Bonuses / Earn More ──────────────────────────────────────── */
/* One tone per row drives its chip, icon bubble and bar together, so a source
   never has to be spelled out in three places. */
.tone--amber   { --tone: var(--brand-primary); }
.tone--cyan    { --tone: #22d3ee; }
.tone--emerald { --tone: var(--status-success); }
.tone--rose    { --tone: #fb7185; }
.tone--violet  { --tone: #a78bfa; }
.tone--slate   { --tone: #94a3b8; }

.bonus-history-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 4px;
}

.chip {
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  padding: 0.12rem 0.44rem;
  border-radius: 6px;
  white-space: nowrap;
  color: var(--tone);
  background: color-mix(in srgb, var(--tone) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone) 28%, transparent);
}

.lot {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  padding: 0.875rem 1rem;
}
.lot + .lot,
.nudge {
  border-top: 1px solid color-mix(in srgb, var(--surface-border) 60%, transparent);
}

.lot-main {
  display: flex;
  align-items: center;
  gap: 0.875rem;
}
.lot-icon {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md, 12px);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--tone) 16%, transparent);
  color: var(--tone);
}
.lot-icon svg { width: 17px; height: 17px; }

.lot-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}
.lot-name {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text-primary);
}
.lot-meta {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.lot-expiry {
  font-size: 12.5px;
  color: var(--text-secondary);
}
.lot-expiry--urgent {
  font-weight: 600;
  color: color-mix(in srgb, var(--status-error) 75%, #fff);
}
.lot-amount {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--status-success);
  flex-shrink: 0;
}

.lot-bar {
  height: 4px;
  border-radius: var(--radius-full, 9999px);
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.lot-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--tone);
  transition: width 0.4s ease;
}
.lot-bar-fill--urgent { background: var(--status-error); }

/* ── Switch nudge ────────────────────────────────────────────────── */
.nudge {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.8rem 1rem;
  background: color-mix(in srgb, var(--status-error) 7%, transparent);
}
.nudge-icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
  color: color-mix(in srgb, var(--status-error) 75%, #fff);
}
.nudge-text {
  flex: 1;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}
.nudge-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 0.875rem;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.2s;
}
.nudge-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); }
.nudge-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Earn More cards ─────────────────────────────────────────────── */
.earn-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.earn-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-lg, 16px);
}

.earn-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.earn-head-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}
.earn-title {
  font-family: var(--font-ui);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--text-primary);
}
.earn-sub {
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.earn-progress {
  display: flex;
  flex-direction: column;
  gap: 0.44rem;
}
.earn-figures {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}
.earn-label {
  font-size: 12.5px;
  color: var(--text-secondary);
}
.earn-value {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  flex-shrink: 0;
}
.earn-target { color: rgba(255, 255, 255, 0.6); }

.earn-bar {
  height: 8px;
  border-radius: var(--radius-full, 9999px);
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.earn-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--tone) 70%, #000), var(--tone));
  transition: width 0.4s ease;
}

.earn-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.earn-foot-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}
.earn-togo {
  font-size: 12.5px;
  color: var(--text-secondary);
}
.earn-hint {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.58);
}
.earn-hint-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.earn-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 1.25rem;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.2s, transform 0.15s;
}
.earn-btn:hover {
  background: color-mix(in srgb, var(--brand-primary) 90%, white);
  transform: translateY(-1px);
}

/* ── Quick Links ─────────────────────────────────────────────────── */
.quick-links {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.quick-link {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.95rem 1rem;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  text-decoration: none;
  transition: background 0.2s, border-color 0.2s, transform 0.14s;
}
.quick-link:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: color-mix(in srgb, var(--brand-primary) 40%, transparent);
  transform: translateY(-1px);
}

.ql-icon {
  width: 20px;
  height: 20px;
  color: var(--brand-primary);
  flex-shrink: 0;
}

.ql-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.ql-title {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text-primary);
}
.ql-sub {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.ql-arrow {
  width: 15px;
  height: 15px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
</style>
