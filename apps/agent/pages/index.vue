<script setup lang="ts">
import type {
  AgentRefusal,
  DepositRequest,
  FulfillResult,
  LedgerRow,
} from '~/composables/useAgentApi'

const api = useAgentApi()
const {
  profile,
  pending: profilePending,
  error: profileError,
  load: loadProfile,
  applyFloat,
} = useAgentProfile()

/**
 * The fulfil card is one panel that swaps its contents, not four cards that
 * appear and disappear. The agent's eyes stay in the same place from typing the
 * code to reading the reference back to the customer.
 */
type Panel = 'entry' | 'confirm' | 'success' | 'refused'

const panel = ref<Panel>('entry')
const code = ref('')
const lookingUp = ref(false)
const confirming = ref(false)
const entryError = ref('')

const request = ref<DepositRequest | null>(null)
const receipt = ref<FulfillResult | null>(null)
const refusal = ref<AgentRefusal | null>(null)

const codeEntry = ref<{ focusFirst: () => void } | null>(null)

/**
 * The refusal flattened to plain fields. A discriminated union reads fine in
 * TypeScript but narrows badly across a template's v-if chain, and a compile
 * error in the one panel that tells an agent NOT to hand over cash is not a
 * trade worth making.
 */
const refusalView = computed(() => {
  const value = refusal.value
  if (!value) return null
  return {
    kind: value.kind,
    fulfilledAt: 'fulfilledAt' in value ? value.fulfilledAt : undefined,
    expiredAt: 'expiredAt' in value ? value.expiredAt : undefined,
    float: 'float' in value ? value.float : undefined,
    required: 'required' in value ? value.required : undefined,
    message: 'message' in value ? value.message : '',
  }
})

const canLookUp = computed(() => code.value.length === 6 && !lookingUp.value)

/** Float shown next to the deposit, so the agent sees the debit before it happens. */
const floatAfterPreview = computed(() => {
  if (!profile.value || !request.value) return null
  return subtractMoney(profile.value.float, request.value.amount)
})

const previewGoesNegative = computed(() => {
  const after = floatAfterPreview.value
  return after !== null && isNegativeAmount(after)
})

// ── Today's fulfilments ──────────────────────────────────────────────────
const todayRows = ref<LedgerRow[]>([])
const todayPending = ref(false)
const todayError = ref('')

const loadToday = async () => {
  todayPending.value = true
  todayError.value = ''
  try {
    const today = isoDay()
    const data = await api.getLedger({
      from: today,
      to: today,
      type: 'FULFILLMENT',
      page: 1,
      pageSize: 20,
    })
    todayRows.value = data.rows
  } catch (err) {
    todayError.value = apiErrorMessage(err, "Could not load today's deposits.")
  } finally {
    todayPending.value = false
  }
}

// ── Actions ──────────────────────────────────────────────────────────────
const resetToEntry = async () => {
  panel.value = 'entry'
  code.value = ''
  request.value = null
  receipt.value = null
  refusal.value = null
  entryError.value = ''
  await nextTick()
  codeEntry.value?.focusFirst()
}

const lookUp = async () => {
  if (!canLookUp.value) return
  lookingUp.value = true
  entryError.value = ''
  try {
    request.value = await api.lookupRequest(code.value)
    panel.value = 'confirm'
  } catch (err) {
    const parsed = toAgentRefusal(
      err,
      'Could not look up that code. Check the connection and try again.',
    )
    if (parsed.kind === 'UNKNOWN') {
      // A transient failure is not a refusal. Keep the code on screen so
      // the agent can press Look up again instead of retyping it.
      entryError.value = parsed.message
    } else {
      refusal.value = parsed
      panel.value = 'refused'
    }
  } finally {
    lookingUp.value = false
  }
}

const confirmFulfil = async () => {
  if (confirming.value || !request.value) return
  confirming.value = true
  try {
    const result = await api.fulfillRequest(request.value.code)
    receipt.value = result
    applyFloat(result.floatAfter)
    panel.value = 'success'
    // The counters on the right and the table below both move on a
    // fulfilment; neither is worth blocking the receipt on.
    loadProfile()
    loadToday()
  } catch (err) {
    refusal.value = toAgentRefusal(
      err,
      'The deposit could not be confirmed. Do not hand over credit. Try the code again.',
    )
    panel.value = 'refused'
  } finally {
    confirming.value = false
  }
}

const cancelConfirm = () => {
  resetToEntry()
}

onMounted(async () => {
  await Promise.all([loadProfile(), loadToday()])
  codeEntry.value?.focusFirst()
})
</script>

<template>
  <div class="counter">
    <!-- ── Left column ─────────────────────────────────────────────── -->
    <div class="counter__main">
      <section class="agent-card fulfil-card">
        <!-- Entry -->
        <template v-if="panel === 'entry'">
          <div class="agent-card__head">
            <h1 class="agent-card__title">Fulfil a deposit</h1>
          </div>
          <div class="fulfil-body">
            <CodeEntry ref="codeEntry" v-model="code" :disabled="lookingUp" @complete="lookUp" />

            <p class="helper">
              Type the 6 digit code from the player's phone. Nothing is charged at lookup: you will
              see the amount and the player before anything moves.
            </p>

            <p v-if="entryError" class="inline-error" role="alert">{{ entryError }}</p>

            <button
              type="button"
              class="btn btn--primary lookup-btn"
              :disabled="!canLookUp"
              @click="lookUp"
            >
              <span v-if="lookingUp" class="spinner" aria-hidden="true"></span>
              <span>{{ lookingUp ? 'Looking up' : 'Look up' }}</span>
            </button>
          </div>
        </template>

        <!-- Confirmation -->
        <template v-else-if="panel === 'confirm' && request">
          <div class="agent-card__head">
            <h1 class="agent-card__title">Confirm this deposit</h1>
            <p class="agent-card__hint tnum">Code {{ request.code }}</p>
          </div>
          <div class="fulfil-body">
            <p class="amount-label">Amount to take in cash</p>
            <p class="amount tnum">
              {{ formatMoney(request.amount) }} <span class="amount__unit">ETB</span>
            </p>

            <dl class="player-facts">
              <div class="fact">
                <dt>Player</dt>
                <dd>{{ request.player.name }}</dd>
              </div>
              <div class="fact">
                <dt>Phone</dt>
                <dd class="tnum">{{ request.player.phoneTail }}</dd>
              </div>
              <div class="fact">
                <dt>Player since</dt>
                <dd>{{ formatDate(request.player.since) }}</dd>
              </div>
              <div class="fact">
                <dt>Deposits so far</dt>
                <dd class="tnum">{{ request.player.depositCount }}</dd>
              </div>
              <div class="fact">
                <dt>Code expires</dt>
                <dd class="tnum">{{ formatTime(request.expiresAt) }}</dd>
              </div>
            </dl>

            <p class="warn-strip">
              Take the cash from the player first. Confirming credits their wallet straight away and
              cannot be undone from this app.
            </p>

            <div class="action-row">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="confirming"
                @click="confirmFulfil"
              >
                <span v-if="confirming" class="spinner" aria-hidden="true"></span>
                <span>{{ confirming ? 'Crediting' : 'Confirm and credit' }}</span>
              </button>
              <button
                type="button"
                class="btn btn--ghost"
                :disabled="confirming"
                @click="cancelConfirm"
              >
                Cancel
              </button>
            </div>
          </div>
        </template>

        <!-- Success -->
        <template v-else-if="panel === 'success' && receipt">
          <div class="fulfil-body success-body">
            <p class="success-badge">
              <UIcon name="i-heroicons:check-circle" class="w-5 h-5" aria-hidden="true" />
              <span>Credited</span>
            </p>
            <p class="amount amount--success tnum">
              {{ formatMoney(receipt.amount) }} <span class="amount__unit">ETB</span>
            </p>
            <p class="success-sub">Paid to {{ receipt.player.name }}</p>

            <dl class="player-facts">
              <div class="fact">
                <dt>Reference</dt>
                <dd class="tnum">{{ receipt.reference }}</dd>
              </div>
              <div class="fact">
                <dt>Code</dt>
                <dd class="tnum">{{ receipt.code }}</dd>
              </div>
              <div class="fact">
                <dt>Time</dt>
                <dd class="tnum">{{ formatDateTime(receipt.fulfilledAt) }}</dd>
              </div>
              <div class="fact">
                <dt>Float after</dt>
                <dd class="tnum">{{ formatBirr(receipt.floatAfter) }}</dd>
              </div>
            </dl>

            <button type="button" class="btn btn--primary" @click="resetToEntry">
              Fulfil another
            </button>
          </div>
        </template>

        <!-- Refusals -->
        <template v-else-if="panel === 'refused' && refusalView">
          <div class="fulfil-body refusal-body" role="alert">
            <template v-if="refusalView.kind === 'NOT_FOUND'">
              <p class="refusal-badge">No active request</p>
              <h2 class="refusal-title">
                No active request for <span class="tnum">{{ code }}</span>
              </h2>
              <p class="refusal-copy">
                Check the digits against the player's phone. A code works once and only while it is
                still live.
              </p>
            </template>

            <template v-else-if="refusalView.kind === 'ALREADY_FULFILLED'">
              <p class="refusal-badge">Already fulfilled</p>
              <h2 class="refusal-title">
                Another agent fulfilled this code at
                <span class="tnum">{{
                  formatTime(refusalView.fulfilledAt, 'an earlier time')
                }}</span>
              </h2>
              <p class="refusal-copy">
                The player has already been credited. Do not hand over credit for this code and do
                not take the cash.
              </p>
            </template>

            <template v-else-if="refusalView.kind === 'EXPIRED'">
              <p class="refusal-badge">Expired</p>
              <h2 class="refusal-title">
                This code expired at
                <span class="tnum">{{ formatTime(refusalView.expiredAt, 'an earlier time') }}</span>
              </h2>
              <p class="refusal-copy">
                Codes last 15 minutes. Ask the player to generate a new one in their app, then enter
                it here.
              </p>
            </template>

            <template v-else-if="refusalView.kind === 'INSUFFICIENT_FLOAT'">
              <p class="refusal-badge">Not enough float</p>
              <h2 class="refusal-title">Your float will not cover this deposit</h2>
              <dl class="player-facts">
                <div class="fact">
                  <dt>Your float</dt>
                  <dd class="tnum">{{ formatBirr(refusalView.float ?? profile?.float) }}</dd>
                </div>
                <div class="fact">
                  <dt>Required</dt>
                  <dd class="tnum">{{ formatBirr(refusalView.required ?? request?.amount) }}</dd>
                </div>
              </dl>
              <p class="refusal-copy">
                Float never goes below zero, so this deposit cannot be confirmed. Top up with the
                operator, then ask the player for the code again.
              </p>
            </template>

            <template v-else>
              <p class="refusal-badge">Not completed</p>
              <h2 class="refusal-title">The deposit was not completed</h2>
              <p class="refusal-copy">{{ refusalView.message }}</p>
            </template>

            <button type="button" class="btn btn--ghost" @click="resetToEntry">
              Back to code entry
            </button>
          </div>
        </template>
      </section>

      <!-- Today ───────────────────────────────────────────────────── -->
      <section class="agent-card today-card">
        <div class="agent-card__head">
          <h2 class="agent-card__title">Today</h2>
          <p class="agent-card__hint">Deposits you fulfilled today</p>
        </div>

        <p v-if="todayPending" class="state-line">Loading today's deposits</p>

        <div v-else-if="todayError" class="state-block" role="alert">
          <p class="state-line state-line--error">{{ todayError }}</p>
          <button type="button" class="btn btn--ghost btn--small" @click="loadToday">
            Try again
          </button>
        </div>

        <p v-else-if="todayRows.length === 0" class="state-line">
          No deposits fulfilled yet today. The first one will appear here.
        </p>

        <div v-else class="table-wrap">
          <table class="agent-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Code</th>
                <th scope="col">Player</th>
                <th scope="col" class="num">Amount</th>
                <th scope="col" class="num">Float after</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in todayRows" :key="row.id">
                <td class="code">{{ formatTime(row.createdAt) }}</td>
                <td class="code">{{ row.requestCode || '-' }}</td>
                <td class="muted">{{ row.playerMaskedName || '-' }}</td>
                <td class="num">{{ formatMoney(row.amount) }}</td>
                <td class="num">{{ formatMoney(row.balanceAfter) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- ── Right rail ──────────────────────────────────────────────── -->
    <aside class="counter__rail">
      <section class="agent-card rail-card">
        <p class="rail-label">Available float</p>

        <p v-if="profilePending && !profile" class="rail-loading">Loading</p>
        <template v-else-if="profileError && !profile">
          <p class="state-line state-line--error" role="alert">{{ profileError }}</p>
          <button type="button" class="btn btn--ghost btn--small" @click="loadProfile">
            Try again
          </button>
        </template>
        <template v-else>
          <p class="rail-float tnum">{{ formatMoney(profile?.float) }}</p>
          <p class="rail-unit">ETB</p>
        </template>

        <div v-if="panel === 'confirm' && request" class="float-math">
          <div class="math-row">
            <span>Float now</span>
            <span class="tnum">{{ formatMoney(profile?.float) }}</span>
          </div>
          <div class="math-row math-row--debit">
            <span>This deposit</span>
            <span class="tnum">-{{ formatMoney(request.amount) }}</span>
          </div>
          <div
            class="math-row math-row--total"
            :class="{ 'math-row--negative': previewGoesNegative }"
          >
            <span>Float after</span>
            <span class="tnum">{{ formatMoney(floatAfterPreview) }}</span>
          </div>
        </div>
      </section>

      <section class="agent-card rail-card">
        <p class="rail-label">Fulfilled today</p>
        <p class="rail-metric tnum">{{ profile?.today.count ?? '-' }}</p>
        <p class="rail-sub">
          <span class="tnum">{{ formatBirr(profile?.today.volume) }}</span> handed over
        </p>
      </section>

      <section class="agent-card rail-card">
        <p class="rail-label">Per deposit limits</p>
        <dl class="limits">
          <div class="limit-row">
            <dt>Minimum</dt>
            <dd class="tnum">{{ formatBirr(profile?.limits.min) }}</dd>
          </div>
          <div class="limit-row">
            <dt>Maximum</dt>
            <dd class="tnum">{{ formatBirr(profile?.limits.max) }}</dd>
          </div>
        </dl>
        <p class="rail-note">A code outside these limits will not be issued by the player app.</p>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.counter {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 316px;
  gap: 22px;
  align-items: start;
  max-width: 1320px;
  margin: 0 auto;
}

.counter__main {
  display: flex;
  flex-direction: column;
  gap: 22px;
  min-width: 0;
}

.counter__rail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  position: sticky;
  top: 80px;
}

@media (max-width: 1080px) {
  .counter {
    grid-template-columns: minmax(0, 1fr);
  }
  .counter__rail {
    position: static;
  }
}

/* ── Fulfil card ─────────────────────────────────────────────────────── */
.fulfil-card {
  min-height: 340px;
}

.fulfil-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 18px;
  padding: 20px;
}

.helper {
  margin: 0;
  max-width: 52ch;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
}

.inline-error {
  margin: 0;
  padding: 10px 13px;
  border-radius: 9px;
  background: var(--negative-bg);
  border: 1px solid var(--negative-border);
  color: #fca5a5;
  font-size: 13px;
  line-height: 1.45;
}

.lookup-btn {
  min-width: 170px;
}

/* ── Confirmation ────────────────────────────────────────────────────── */
.amount-label {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.amount {
  margin: -6px 0 0;
  font-family: var(--font-ui);
  font-size: clamp(52px, 7vw, 76px);
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.015em;
  color: var(--text-primary);
}

.amount__unit {
  font-size: 0.34em;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--text-muted);
  margin-left: 6px;
}

.amount--success {
  color: var(--positive);
}

.player-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 14px 24px;
  width: 100%;
  margin: 0;
  padding: 16px 0;
  border-top: 1px solid var(--surface-line);
  border-bottom: 1px solid var(--surface-line);
}

.fact {
  min-width: 0;
}

.fact dt {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 3px;
}

.fact dd {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-word;
}

.warn-strip {
  width: 100%;
  margin: 0;
  padding: 12px 15px;
  border-radius: 10px;
  background: var(--warning-bg);
  border: 1px solid var(--warning-border);
  border-left-width: 3px;
  color: #fde3a7;
  font-size: 13px;
  line-height: 1.5;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

/* ── Success ─────────────────────────────────────────────────────────── */
.success-body {
  gap: 14px;
}

.success-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 5px 12px 5px 9px;
  border-radius: 999px;
  background: var(--positive-bg);
  border: 1px solid var(--positive-border);
  color: var(--positive);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.success-sub {
  margin: -6px 0 0;
  font-size: 14px;
  color: var(--text-secondary);
}

/* ── Refusals ────────────────────────────────────────────────────────── */
.refusal-body {
  gap: 14px;
}

.refusal-badge {
  display: inline-block;
  margin: 0;
  padding: 4px 11px;
  border-radius: 999px;
  background: var(--negative-bg);
  border: 1px solid var(--negative-border);
  color: #fca5a5;
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.refusal-title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.005em;
}

.refusal-copy {
  margin: 0;
  max-width: 56ch;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-secondary);
}

/* ── Today ───────────────────────────────────────────────────────────── */
.today-card {
  padding-bottom: 6px;
}

.table-wrap {
  margin-top: 12px;
  overflow-x: auto;
}

.state-line {
  margin: 0;
  padding: 20px;
  font-size: 13px;
  color: var(--text-muted);
}

.state-line--error {
  color: #fca5a5;
  padding-bottom: 8px;
}

.state-block {
  padding-bottom: 18px;
  padding-left: 20px;
}

.btn--small {
  height: 34px;
  padding: 0 14px;
  font-size: 12px;
}

/* ── Rail ────────────────────────────────────────────────────────────── */
.rail-card {
  padding: 18px 20px;
}

.rail-label {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.rail-loading {
  margin: 10px 0 0;
  font-size: 14px;
  color: var(--text-muted);
}

.rail-float {
  margin: 8px 0 0;
  font-family: var(--font-ui);
  font-size: 40px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.01em;
  color: var(--brand-primary);
}

.rail-unit {
  margin: 4px 0 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  color: var(--text-muted);
}

.rail-metric {
  margin: 8px 0 0;
  font-family: var(--font-ui);
  font-size: 32px;
  font-weight: 700;
  line-height: 1;
}

.rail-sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.rail-note {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}

.float-math {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--surface-line);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.math-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.math-row--debit {
  color: var(--warning);
}

.math-row--total {
  padding-top: 9px;
  border-top: 1px solid var(--surface-line);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

.math-row--negative {
  color: var(--negative);
}

.limits {
  margin: 10px 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.limit-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.limit-row dt {
  font-size: 13px;
  color: var(--text-secondary);
}

.limit-row dd {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
</style>
