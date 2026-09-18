<template>
  <section ref="rootEl" class="agent-card" :class="{ 'agent-card--open': open }">
    <div class="agent-card__head">
      <span class="agent-card__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 9l1.5-4.5h15L21 9M3 9h18M3 9v10a1 1 0 001 1h16a1 1 0 001-1V9M8 13h8" />
        </svg>
      </span>
      <div class="agent-card__titles">
        <h4 class="agent-card__name">{{ t('wallet.agent.name') }}</h4>
        <p class="agent-card__tagline">{{ t('wallet.agent.tagline') }}</p>
      </div>
    </div>

    <div class="agent-card__body">
      <!-- Collapsed: the stack stays scannable until the player picks this. -->
      <button
        v-if="!open"
        type="button"
        class="wb-btn wb-btn--primary agent-card__cta"
        @click="expand"
      >
        {{ t('wallet.continue') }}
      </button>

      <template v-else>
        <!-- Loading ------------------------------------------------ -->
        <p v-if="view === 'loading'" class="agent-note">{{ t('common.loading') }}</p>

        <!-- The active-code lookup failed. Never fall through to the
             amount form: a second code would cancel one the player may
             already be standing in front of an agent with. -->
        <template v-else-if="view === 'error'">
          <div class="wb-notice wb-notice--error" role="alert">
            <div class="wb-notice__body">
              <span class="wb-notice__title">{{ t('wallet.agent.loadFailed') }}</span>
              <span v-if="loadError" class="wb-notice__text">{{ loadError }}</span>
            </div>
          </div>
          <button type="button" class="wb-btn wb-btn--subtle agent-card__cta" @click="load">
            {{ t('common.retry') }}
          </button>
        </template>

        <!-- Amount form -------------------------------------------- -->
        <form v-else-if="view === 'form'" class="agent-form" @submit.prevent="requestCode">
          <ol class="agent-steps">
            <li>{{ t('wallet.agent.step1') }}</li>
            <li>{{ t('wallet.agent.step2') }}</li>
            <li>{{ t('wallet.agent.step3') }}</li>
          </ol>

          <div class="wb-field">
            <label class="wb-label" for="agent-deposit-amount">{{ t('wallet.amount') }}</label>
            <input
              id="agent-deposit-amount"
              v-model.number="amount"
              type="number"
              inputmode="numeric"
              step="1"
              :min="limits ? minAmount : undefined"
              :max="limits ? maxAmount : undefined"
              class="wb-input agent-input"
              :class="{ 'wb-input--error': !!formError }"
              @input="formError = ''"
            />
            <div class="agent-chips">
              <button
                v-for="chip in QUICK_PICKS"
                :key="chip"
                type="button"
                class="wb-chip agent-chip"
                @click="pick(chip)"
              >
                {{ chip }}
              </button>
            </div>
            <p v-if="limits" class="wb-hint">
              {{ t('wallet.agent.range', { min: formatMoney(limits.min), max: formatMoney(limits.max) }) }}
            </p>
            <p v-else class="wb-hint wb-hint--error">{{ t('wallet.agent.limitsUnavailable') }}</p>
          </div>

          <p class="agent-note agent-note--bonus">{{ t('wallet.agent.bonusParity') }}</p>

          <p v-if="formError" class="wb-hint wb-hint--error" role="alert">{{ formError }}</p>

          <button
            type="submit"
            class="wb-btn wb-btn--primary agent-card__cta"
            :disabled="submitting"
          >
            {{ submitting ? t('wallet.agent.requesting') : t('wallet.agent.getCode') }}
          </button>
        </form>

        <!-- Live code ---------------------------------------------- -->
        <template v-else-if="view === 'code' && deposit">
          <p class="agent-code__lead">{{ t('wallet.agent.codeLead') }}</p>

          <p class="wb-sr-only">{{ t('wallet.agent.codeSpoken', { code: spacedCode }) }}</p>
          <div class="agent-code" aria-hidden="true">
            <span v-for="(digit, i) in codeDigits" :key="i" class="agent-code__digit">{{ digit }}</span>
          </div>

          <p class="agent-handover">
            {{ t('wallet.agent.handOver') }}
            <strong class="agent-handover__amount">{{ formatMoney(deposit.amount) }} {{ t('common.etb') }}</strong>
          </p>

          <div class="agent-ttl">
            <div class="agent-ttl__track" aria-hidden="true">
              <div class="agent-ttl__fill" :style="{ width: remainingPct + '%' }" />
            </div>
            <p class="agent-ttl__label">{{ t('wallet.agent.expiresIn', { time: remainingClock }) }}</p>
          </div>

          <ul class="agent-warnings">
            <li>{{ t('wallet.agent.warnOnce') }}</li>
            <li>{{ t('wallet.agent.warnShare') }}</li>
            <li>{{ t('wallet.agent.warnOneActive') }}</li>
          </ul>

          <p class="agent-note">{{ t('wallet.agent.waiting') }}</p>

          <p v-if="cancelError" class="wb-hint wb-hint--error" role="alert">{{ cancelError }}</p>

          <button
            type="button"
            class="wb-btn wb-btn--subtle agent-card__cta"
            :disabled="cancelling"
            @click="cancelCode"
          >
            {{ cancelling ? t('wallet.agent.cancelling') : t('wallet.agent.cancelCode') }}
          </button>
        </template>

        <!-- Expired ------------------------------------------------ -->
        <template v-else-if="view === 'expired'">
          <div class="wb-notice wb-notice--error" role="status">
            <div class="wb-notice__body">
              <span class="wb-notice__title">{{ t('wallet.agent.expiredTitle') }}</span>
              <span class="wb-notice__text">{{ t('wallet.agent.expiredHint') }}</span>
            </div>
          </div>
          <button type="button" class="wb-btn wb-btn--primary agent-card__cta" @click="startOver">
            {{ t('wallet.agent.newCode') }}
          </button>
        </template>

        <!-- Funded ------------------------------------------------- -->
        <div v-else-if="view === 'funded'" class="wb-notice wb-notice--success" role="status">
          <div class="wb-notice__body">
            <span class="wb-notice__title">
              {{ t('wallet.agent.fundedTitle', { amount: formatMoney(fundedAmount) }) }}
            </span>
            <span class="wb-notice__text">{{ t('wallet.agent.fundedText') }}</span>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { amountBucket } from '~/utils/deposit'
import { useAuthStore } from '~/store/auth'

defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'expand'): void
  (e: 'active'): void
}>()

const auth = useAuthStore()
const { t } = useI18n()
const { track } = useAnalytics()

/** The analytics method code for this option — shares the deposit funnel
 *  events with the gateway cards so the two are comparable. */
const METHOD_CODE = 'agent_cash'
const QUICK_PICKS = [100, 200, 500, 1000]
/** Only used for the countdown bar's full width when the limits call has not
 *  answered. The expiry itself always comes from the server's `expiresAt`. */
const FALLBACK_TTL_SECONDS = 900

type AgentLimits = { min: string; max: string; ttlSeconds: number }
type AgentDeposit = {
  id: string
  code: string
  amount: string
  expiresAt: string
  status: string
}

type View = 'loading' | 'error' | 'form' | 'code' | 'expired' | 'funded'

const rootEl = ref<HTMLElement | null>(null)
const view = ref<View>('loading')
const limits = ref<AgentLimits | null>(null)
const deposit = ref<AgentDeposit | null>(null)
const fundedAmount = ref<string | null>(null)

const amount = ref<number | null>(null)
const loadError = ref('')
const formError = ref('')
const cancelError = ref('')
const submitting = ref(false)
const cancelling = ref(false)

const minAmount = computed(() => Number(limits.value?.min ?? 0))
const maxAmount = computed(() => Number(limits.value?.max ?? 0))
const ttlSeconds = computed(() => Number(limits.value?.ttlSeconds) || FALLBACK_TTL_SECONDS)

const codeDigits = computed(() => (deposit.value?.code ?? '').split(''))
/** Screen readers run "482913" together as one number; spaced, it is read
 *  digit by digit, which is what the player has to say out loud. */
const spacedCode = computed(() => codeDigits.value.join(' '))

/**
 * The reason the server itself wrote, when it wrote one, otherwise our own
 * copy. ofetch's own message carries the method and the full URL, which is
 * not something to put in front of a player.
 */
function serverReason(e: unknown, fallback: string): string {
  const body = (e && typeof e === 'object' ? (e as { data?: unknown }).data : null) as
    | { error?: unknown; message?: unknown }
    | null
    | undefined
  if (typeof body?.error === 'string' && body.error) return body.error
  if (typeof body?.message === 'string' && body.message) return body.message
  return fallback
}

/** Money arrives as decimal strings. Trailing ".00" is noise on a number
 *  somebody is about to count out in cash. */
function formatMoney(value: string | number | null | undefined): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '0'
  return n.toLocaleString('en-ET', { maximumFractionDigits: 2 })
}

// ── Countdown ─────────────────────────────────────────────────────
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function startTimer() {
  stopTimer()
  now.value = Date.now()
  timer = setInterval(() => {
    now.value = Date.now()
    if (remainingMs.value > 0) return
    // A dead code must never keep sitting there looking live.
    stopTimer()
    if (view.value === 'code') view.value = 'expired'
  }, 1000)
}

onUnmounted(stopTimer)

const remainingMs = computed(() => {
  const at = deposit.value?.expiresAt
  if (!at) return 0
  const ms = new Date(at).getTime() - now.value
  return Number.isFinite(ms) ? Math.max(0, ms) : 0
})

const remainingClock = computed(() => {
  const total = Math.ceil(remainingMs.value / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
})

const remainingPct = computed(() => {
  const total = ttlSeconds.value * 1000
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (remainingMs.value / total) * 100))
})

// ── State transitions ─────────────────────────────────────────────
function adoptDeposit(next: AgentDeposit | null, announce = false) {
  deposit.value = next
  cancelError.value = ''
  if (!next) {
    stopTimer()
    view.value = 'form'
    return
  }
  now.value = Date.now()
  if (!(new Date(next.expiresAt).getTime() > now.value)) {
    stopTimer()
    view.value = 'expired'
    return
  }
  view.value = 'code'
  baselineBalance.value = readBalance()
  startTimer()
  if (!announce) return
  // The player may be at the counter already: open this card and bring it
  // into view rather than leaving a live code below the fold.
  emit('active')
  nextTick(() => {
    rootEl.value?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  })
}

async function load() {
  view.value = 'loading'
  loadError.value = ''
  // Settled, not all: a failed limits call still leaves a usable card, while
  // a failed active-code lookup does not.
  const [limitsRes, activeRes] = await Promise.allSettled([
    auth.apiFetch<AgentLimits>('/wallet/agent-deposit/limits'),
    auth.apiFetch<AgentDeposit | null>('/wallet/agent-deposit/active'),
  ])

  if (limitsRes.status === 'fulfilled') limits.value = limitsRes.value ?? null

  if (activeRes.status === 'fulfilled') {
    adoptDeposit(activeRes.value ?? null, true)
    return
  }
  loadError.value = serverReason(activeRes.reason, '')
  view.value = 'error'
}

onMounted(load)

function expand() {
  emit('expand')
  track('deposit_method_selected', { paymentMethod: METHOD_CODE })
}

function pick(value: number) {
  amount.value = value
  formError.value = ''
}

async function requestCode() {
  if (submitting.value) return
  const amt = Number(amount.value ?? 0)
  if (!Number.isFinite(amt) || amt <= 0) {
    formError.value = t('wallet.agent.amountRequired')
    return
  }
  // The server is the authority on the range; this only spares a round trip.
  if (limits.value && (amt < minAmount.value || amt > maxAmount.value)) {
    formError.value = t('wallet.agent.amountOutOfRange', {
      min: formatMoney(limits.value.min),
      max: formatMoney(limits.value.max),
    })
    return
  }

  submitting.value = true
  formError.value = ''
  track('deposit_amount_entered', { paymentMethod: METHOD_CODE, amountBucket: amountBucket(amt) })
  try {
    const created = await auth.apiFetch<AgentDeposit>('/wallet/agent-deposit/request', {
      method: 'POST',
      body: { amount: amt },
    })
    adoptDeposit(created)
  } catch (e) {
    // A 400 carries the reason the amount was refused, which is more useful
    // than anything this component can invent.
    formError.value = serverReason(e, t('wallet.agent.requestFailed'))
  } finally {
    submitting.value = false
  }
}

async function cancelCode() {
  if (cancelling.value) return
  cancelling.value = true
  cancelError.value = ''
  try {
    await auth.apiFetch('/wallet/agent-deposit/active', { method: 'DELETE' })
    if (deposit.value) amount.value = Number(deposit.value.amount)
    adoptDeposit(null)
  } catch (e) {
    cancelError.value = serverReason(e, t('wallet.agent.cancelFailed'))
  } finally {
    cancelling.value = false
  }
}

function startOver() {
  if (deposit.value) amount.value = Number(deposit.value.amount)
  formError.value = ''
  adoptDeposit(null)
}

/**
 * The balance arrives on the wallet socket (useSocket writes it straight into
 * the auth store), so nothing here polls for fulfilment.
 *
 * Measured against a baseline taken when the code view opens, and only counted
 * once it covers the code's amount, so neither a prize landing mid-wait nor the
 * shell's own first wallet load reads as "the agent paid you".
 */
const baselineBalance = ref<number | null>(null)

function readBalance(): number | null {
  return auth.wallet ? Number(auth.wallet.realBalance ?? 0) : null
}

watch(readBalance, (next) => {
  if (view.value !== 'code' || !deposit.value || next === null) return
  if (baselineBalance.value === null) {
    // The wallet had not loaded yet when this code view opened; its first real
    // reading is a baseline, not a credit.
    baselineBalance.value = next
    return
  }
  const expected = Number(deposit.value.amount)
  if (!Number.isFinite(expected) || next - baselineBalance.value < expected - 0.005) return
  fundedAmount.value = deposit.value.amount
  stopTimer()
  deposit.value = null
  view.value = 'funded'
})
</script>

<style scoped>
.agent-card {
  border-radius: var(--radius-md, 12px);
  overflow: hidden;
  background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 22%, transparent);
}
.agent-card--open {
  border-color: color-mix(in srgb, var(--brand-primary) 48%, transparent);
}

.agent-card__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px 0;
}
.agent-card__icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md, 12px);
  background: color-mix(in srgb, var(--brand-primary) 16%, transparent);
  color: var(--brand-primary);
}
.agent-card__icon svg {
  width: 20px;
  height: 20px;
}
.agent-card__titles {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agent-card__name {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-primary);
}
.agent-card__tagline {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.agent-card__body {
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agent-card__cta {
  width: 100%;
  justify-content: center;
  min-height: 48px;
}

.agent-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Three-step explainer ─────────────────────────────────────── */
.agent-steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.agent-steps li::marker {
  color: var(--brand-primary);
  font-weight: 700;
}

.agent-input {
  font-variant-numeric: tabular-nums;
}
.agent-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}
/* Tapped standing at a counter: the shared chip is 31px tall, which is not
   enough of a target for a thumb. */
.agent-chip {
  min-height: 44px;
  min-width: 64px;
  font-variant-numeric: tabular-nums;
}

.agent-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.agent-note--bonus {
  color: var(--brand-primary);
}

/* ── The code itself ──────────────────────────────────────────── */
.agent-code__lead {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.agent-code {
  display: flex;
  gap: 8px;
  justify-content: center;
}
.agent-code__digit {
  flex: 1 1 0;
  max-width: 56px;
  min-width: 0;
  aspect-ratio: 3 / 4;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md, 12px);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 45%, transparent);
  background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 30px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.agent-handover {
  margin: 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
}
.agent-handover__amount {
  display: block;
  margin-top: 2px;
  font-family: var(--font-ui);
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

/* ── Countdown ────────────────────────────────────────────────── */
.agent-ttl {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.agent-ttl__track {
  height: 6px;
  border-radius: var(--radius-full, 9999px);
  background: color-mix(in srgb, var(--text-secondary) 22%, transparent);
  overflow: hidden;
}
.agent-ttl__fill {
  height: 100%;
  border-radius: inherit;
  background: var(--brand-primary);
  transition: width 1s linear;
}
.agent-ttl__label {
  margin: 0;
  text-align: center;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.agent-warnings {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}
.agent-warnings li::marker {
  color: var(--status-warning);
}

.wb-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
