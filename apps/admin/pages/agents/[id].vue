<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const { apiFetch } = useAdminAuth()
const toast = useToast()

const agentId = computed(() => route.params.id as string)

interface AgentDetail {
  id: string
  userId: string
  username: string
  shopName: string
  float: string
  accountStatus: string
  createdAt: string
}

interface AgentStats {
  sold30d: string
  commission30d: string
  fulfilledCount30d: number
}

interface LedgerEntry {
  id: string
  type: string
  amount: string
  balanceAfter: string
  note: string | null
  actorName: string | null
  requestCode: string | null
  playerMaskedName: string | null
  createdAt: string
}

// ── Money helpers ────────────────────────────────────────────────────────
// Every figure on this page is a decimal string from the API. Parsing them
// into integer minor units and doing the commission arithmetic on bigints
// keeps the preview exact: a chain of parseFloat calls would quietly hand the
// operator a total that is a cent away from what the server will store.
const RATE_DECIMALS = 4

/** Decimal string to integer units at `decimals` places, rounding half up. */
function toScaled(value: string | number | null | undefined, decimals: number): bigint | null {
  if (value === null || value === undefined) return null
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(String(value).trim())
  if (!match) return null
  const [, sign, whole = '', fraction = ''] = match
  if (!whole && !fraction) return null
  const padded = (fraction + '0'.repeat(decimals + 1)).slice(0, decimals + 1)
  const base =
    BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded.slice(0, decimals) || '0')
  const rounded = Number(padded.slice(decimals)) >= 5 ? base + 1n : base
  return sign === '-' ? -rounded : rounded
}

/** Integer cents back to the plain decimal string the API expects. */
function fromMinor(minor: bigint): string {
  const negative = minor < 0n
  const abs = negative ? -minor : minor
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

/** Group a decimal string for display without a Number() round trip. */
function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0.00'
  const raw = String(value).trim()
  const sign = raw.startsWith('-') ? '-' : ''
  const [whole = '0', fraction = ''] = raw.replace(/^[+-]/, '').split('.')
  const grouped = (whole || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}.${(fraction + '00').slice(0, 2)}`
}

function formatMinor(minor: bigint | null): string {
  return minor === null ? '0.00' : formatMoney(fromMinor(minor))
}

/** commission = cash * rate / 100, rounded half up, all in integer units. */
function computeCommission(cash: bigint, rate: bigint): bigint {
  const denominator = 100n * 10n ** BigInt(RATE_DECIMALS)
  const numerator = cash * rate
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  return remainder * 2n >= denominator ? quotient + 1n : quotient
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString()
}

function formatType(type: string | null | undefined): string {
  const words = String(type ?? '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Entry'
}

/**
 * The API may sign a debit in the amount itself or only in the type, so read
 * the sign first and fall back to the entry type.
 */
function isNegativeEntry(entry: LedgerEntry): boolean {
  if (
    String(entry.amount ?? '')
      .trim()
      .startsWith('-')
  )
    return true
  return /DEBIT|FULFIL|SOLD|SALE/i.test(String(entry.type ?? ''))
}

/** Player, request code and note collapsed into one muted line. */
function entryDetail(entry: LedgerEntry): string {
  return [entry.playerMaskedName, entry.requestCode, entry.note].filter(Boolean).join(', ')
}

function signedAmount(entry: LedgerEntry): string {
  const minor = toScaled(entry.amount, 2)
  if (minor === null) return String(entry.amount ?? '')
  const abs = minor < 0n ? -minor : minor
  return `${isNegativeEntry(entry) ? '-' : '+'}${formatMinor(abs)}`
}

// ── Load ─────────────────────────────────────────────────────────────────
const agent = ref<AgentDetail | null>(null)
const stats = ref<AgentStats | null>(null)
const ledger = ref<LedgerEntry[]>([])
const loading = ref(true)
const loadError = ref('')

async function fetchAgent() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await apiFetch<{ agent: AgentDetail; stats: AgentStats; ledger: LedgerEntry[] }>(
      `/admin/agents/${agentId.value}`,
    )
    agent.value = data.agent ?? null
    stats.value = data.stats ?? null
    ledger.value = data.ledger ?? []
  } catch (err: any) {
    loadError.value = err?.data?.error ?? 'Could not load this agent'
    agent.value = null
    stats.value = null
    ledger.value = []
  } finally {
    loading.value = false
  }
}

// ── Settings (commission rate prefill) ───────────────────────────────────
const settingsError = ref('')

async function fetchSettings() {
  settingsError.value = ''
  try {
    // The API returns commissionRate as a number and the limits as decimal
    // strings, so this is deliberately widened and coerced below.
    const data = await apiFetch<{ commissionRate: string | number }>('/admin/agents/settings')
    rateInput.value = String(data?.commissionRate ?? '')
    syncCommission()
  } catch {
    // The form still works: the operator types the rate, or the commission,
    // by hand. Say so rather than leaving an empty field unexplained.
    settingsError.value = 'Could not load the default rate. Enter it by hand.'
  }
}

// ── Issue float ──────────────────────────────────────────────────────────
const direction = ref<'CREDIT' | 'DEBIT'>('CREDIT')
const cashInput = ref('')
const rateInput = ref('')
const commissionInput = ref('')
const noteInput = ref('')
const issuing = ref(false)
const issueError = ref('')

const cashMinor = computed(() => toScaled(cashInput.value, 2))
const rateScaled = computed(() => toScaled(rateInput.value, RATE_DECIMALS))
const cashInvalid = computed(() => cashInput.value.trim() !== '' && cashMinor.value === null)
const commissionInvalid = computed(
  () => commissionInput.value.trim() !== '' && toScaled(commissionInput.value, 2) === null,
)

/** What the rate alone would give, before any manual override. */
const suggestedCommissionMinor = computed(() => {
  const cash = cashMinor.value
  const rate = rateScaled.value
  if (cash === null || cash <= 0n || rate === null || rate < 0n) return null
  return computeCommission(cash, rate)
})

/** The figure actually submitted: whatever the commission field shows. */
const commissionMinor = computed(() => {
  if (direction.value === 'DEBIT') return 0n
  return toScaled(commissionInput.value, 2) ?? 0n
})

const totalMinor = computed(() => (cashMinor.value ?? 0n) + commissionMinor.value)

const isOverride = computed(
  () =>
    direction.value === 'CREDIT' &&
    suggestedCommissionMinor.value !== null &&
    commissionMinor.value !== suggestedCommissionMinor.value,
)

function syncCommission() {
  if (direction.value === 'DEBIT') return
  const suggested = suggestedCommissionMinor.value
  commissionInput.value = suggested === null ? '' : fromMinor(suggested)
}

// The commission follows the cash and the rate, but the operator can type over
// it afterwards for a one-off deal; the next cash or rate edit recomputes it.
watch([cashInput, rateInput, direction], syncCommission)

const canSubmit = computed(() => {
  if (issuing.value) return false
  if (cashMinor.value === null || cashMinor.value <= 0n) return false
  if (direction.value === 'CREDIT' && (commissionInvalid.value || commissionMinor.value < 0n))
    return false
  return true
})

const submitLabel = computed(() => {
  if (issuing.value) return direction.value === 'CREDIT' ? 'Crediting float' : 'Debiting float'
  if (direction.value === 'DEBIT') return `Debit ${formatMinor(cashMinor.value ?? 0n)} float`
  return `Credit ${formatMinor(totalMinor.value)} float`
})

async function submitFloat() {
  if (!canSubmit.value || cashMinor.value === null) return
  issueError.value = ''
  issuing.value = true
  try {
    const body: Record<string, unknown> = {
      direction: direction.value,
      cashReceived: fromMinor(cashMinor.value),
    }
    if (direction.value === 'CREDIT') body.commissionAmount = fromMinor(commissionMinor.value)
    if (noteInput.value.trim()) body.note = noteInput.value.trim()

    await apiFetch(`/admin/agents/${agentId.value}/float`, { method: 'POST', body })
    toast.add({
      title: direction.value === 'CREDIT' ? 'Float credited' : 'Float debited',
      color: 'success',
    })
    cashInput.value = ''
    noteInput.value = ''
    syncCommission()
    await fetchAgent()
  } catch (err: any) {
    issueError.value = err?.data?.error ?? 'The float movement was not recorded'
  } finally {
    issuing.value = false
  }
}

// ── Status ───────────────────────────────────────────────────────────────
const showStatus = ref(false)
const savingStatus = ref(false)
const statusError = ref('')
const statusReason = ref('')

const isActive = computed(() => agent.value?.accountStatus === 'ACTIVE')
const statusTarget = computed<'ACTIVE' | 'SUSPENDED'>(() =>
  isActive.value ? 'SUSPENDED' : 'ACTIVE',
)

function openStatus() {
  statusReason.value = ''
  statusError.value = ''
  showStatus.value = true
}

async function submitStatus() {
  const reason = statusReason.value.trim()
  if (reason.length < 3) {
    statusError.value = 'Give a reason of at least 3 characters.'
    return
  }
  savingStatus.value = true
  statusError.value = ''
  try {
    await apiFetch(`/admin/agents/${agentId.value}/status`, {
      method: 'POST',
      body: { status: statusTarget.value, reason },
    })
    showStatus.value = false
    toast.add({
      title: statusTarget.value === 'ACTIVE' ? 'Agent reactivated' : 'Agent suspended',
      color: 'success',
    })
    await fetchAgent()
  } catch (err: any) {
    statusError.value = err?.data?.error ?? 'Could not change the status'
  } finally {
    savingStatus.value = false
  }
}

// ── Rename ───────────────────────────────────────────────────────────────
const editingShop = ref(false)
const shopDraft = ref('')
const savingShop = ref(false)
const shopError = ref('')

function openShopEdit() {
  shopDraft.value = agent.value?.shopName ?? ''
  shopError.value = ''
  editingShop.value = true
}

async function saveShopName() {
  const shopName = shopDraft.value.trim()
  if (!shopName) {
    shopError.value = 'The shop name cannot be empty.'
    return
  }
  savingShop.value = true
  shopError.value = ''
  try {
    await apiFetch(`/admin/agents/${agentId.value}`, { method: 'PATCH', body: { shopName } })
    editingShop.value = false
    await fetchAgent()
  } catch (err: any) {
    shopError.value = err?.data?.error ?? 'Could not save the shop name'
  } finally {
    savingShop.value = false
  }
}

onMounted(async () => {
  await fetchAgent()
  await fetchSettings()
})
</script>

<template>
  <div>
    <NuxtLink to="/agents" class="back-link">
      <UIcon name="i-heroicons:arrow-left" class="w-3.5 h-3.5" />
      All agents
    </NuxtLink>

    <div v-if="loading" class="admin-card state-panel">
      <p class="state-text">Loading agent</p>
    </div>

    <div v-else-if="loadError" class="admin-card state-panel">
      <UIcon name="i-heroicons:exclamation-triangle" class="w-5 h-5 state-icon" />
      <p class="state-text">{{ loadError }}</p>
      <button class="btn-ghost" @click="fetchAgent">Try again</button>
    </div>

    <template v-else-if="agent">
      <!-- ── Header ──────────────────────────────────────────────────── -->
      <div class="page-header">
        <div class="header-main">
          <div class="title-row">
            <h1 class="page-title">{{ agent.shopName || agent.username }}</h1>
            <span
              class="status-tag"
              :class="isActive ? 'status-tag--positive' : 'status-tag--negative'"
            >
              {{ isActive ? 'Active' : 'Suspended' }}
            </span>
          </div>

          <div v-if="!editingShop" class="meta-row">
            <span class="meta">
              Shop {{ agent.shopName }}
              <button class="icon-btn" aria-label="Edit shop name" @click="openShopEdit">
                <UIcon name="i-heroicons:pencil-square" class="w-3.5 h-3.5" />
              </button>
            </span>
            <span class="meta-dot" aria-hidden="true"></span>
            <span class="meta">{{ agent.username }}</span>
            <span class="meta-dot" aria-hidden="true"></span>
            <span class="meta">Joined {{ formatDate(agent.createdAt) }}</span>
          </div>

          <form v-else class="shop-edit" @submit.prevent="saveShopName">
            <label class="sr-only" for="shop-name">Shop name</label>
            <input id="shop-name" v-model="shopDraft" type="text" maxlength="64" />
            <button type="submit" class="btn-primary btn-sm" :disabled="savingShop">
              {{ savingShop ? 'Saving' : 'Save' }}
            </button>
            <button type="button" class="btn-ghost btn-sm" @click="editingShop = false">
              Cancel
            </button>
            <p v-if="shopError" class="form-error">{{ shopError }}</p>
          </form>
        </div>

        <button class="btn-ghost" :class="isActive ? 'btn-ghost--danger' : ''" @click="openStatus">
          {{ isActive ? 'Suspend agent' : 'Reactivate agent' }}
        </button>
      </div>

      <div class="columns">
        <!-- ── Issue float ───────────────────────────────────────────── -->
        <form class="admin-card issue-card" @submit.prevent="submitFloat">
          <h2 class="card-title">Issue float</h2>
          <p class="card-sub">
            The agent pays cash up front. Debit is the correction path, because nothing here
            reverses on its own.
          </p>

          <div class="segmented" role="radiogroup" aria-label="Float direction">
            <label class="segment" :class="{ 'segment--active': direction === 'CREDIT' }">
              <input
                v-model="direction"
                class="segment-input"
                type="radio"
                name="direction"
                value="CREDIT"
              />
              <span>Credit</span>
            </label>
            <label
              class="segment"
              :class="{
                'segment--active': direction === 'DEBIT',
                'segment--danger': direction === 'DEBIT',
              }"
            >
              <input
                v-model="direction"
                class="segment-input"
                type="radio"
                name="direction"
                value="DEBIT"
              />
              <span>Debit</span>
            </label>
          </div>

          <div class="field">
            <label for="cash-received">
              {{ direction === 'CREDIT' ? 'Cash received (ETB)' : 'Amount to debit (ETB)' }}
            </label>
            <input
              id="cash-received"
              v-model="cashInput"
              class="input-lg money"
              type="text"
              inputmode="decimal"
              placeholder="0.00"
              autocomplete="off"
            />
            <p v-if="cashInvalid" class="field-error">Enter an amount like 50000 or 50000.50</p>
          </div>

          <template v-if="direction === 'CREDIT'">
            <div class="field-pair">
              <div class="field">
                <label for="commission-rate">Rate (%)</label>
                <input
                  id="commission-rate"
                  v-model="rateInput"
                  class="money"
                  type="text"
                  inputmode="decimal"
                  placeholder="0"
                  autocomplete="off"
                />
              </div>
              <div class="field">
                <label for="commission-amount">Commission float (ETB)</label>
                <input
                  id="commission-amount"
                  v-model="commissionInput"
                  class="money"
                  type="text"
                  inputmode="decimal"
                  placeholder="0.00"
                  autocomplete="off"
                />
              </div>
            </div>

            <p v-if="settingsError" class="field-error">{{ settingsError }}</p>
            <p v-else-if="commissionInvalid" class="field-error">
              Enter a commission like 2500 or 2500.50
            </p>
            <p v-else-if="isOverride" class="field-hint field-hint--warn">
              Manual override. This exact figure is sent. The rate would give
              {{ formatMinor(suggestedCommissionMinor) }}.
              <button type="button" class="link-btn" @click="syncCommission">
                Use the rate figure
              </button>
            </p>
            <p v-else class="field-hint">The figure shown above is the one that gets sent.</p>

            <div class="total-box">
              <p class="total-label">Float credited</p>
              <p class="total-value money">
                {{ formatMinor(totalMinor) }}<span class="total-unit">ETB</span>
              </p>
              <p class="total-sub">
                {{ formatMinor(cashMinor ?? 0n) }} cash plus
                {{ formatMinor(commissionMinor) }} commission
              </p>
            </div>
          </template>

          <div class="field">
            <label for="float-note">Note</label>
            <input
              id="float-note"
              v-model="noteInput"
              type="text"
              maxlength="140"
              placeholder="Optional, e.g. cash handed over at the office"
              autocomplete="off"
            />
          </div>

          <p v-if="issueError" class="form-error">{{ issueError }}</p>

          <button
            type="submit"
            class="btn-submit"
            :class="direction === 'DEBIT' ? 'btn-submit--danger' : ''"
            :disabled="!canSubmit"
          >
            {{ submitLabel }}
          </button>
        </form>

        <!-- ── Stats and ledger ──────────────────────────────────────── -->
        <div class="right-column">
          <div class="tile-grid">
            <div class="admin-card tile">
              <p class="tile-label">Float now</p>
              <p class="tile-value tile-value--amber money">
                {{ formatMoney(agent.float) }}<span class="tile-unit">ETB</span>
              </p>
            </div>
            <div class="admin-card tile">
              <p class="tile-label">Sold 30 days</p>
              <p class="tile-value money">
                {{ formatMoney(stats?.sold30d) }}<span class="tile-unit">ETB</span>
              </p>
              <p class="tile-sub">{{ stats?.fulfilledCount30d ?? 0 }} deposits</p>
            </div>
            <div class="admin-card tile">
              <p class="tile-label">Commission given</p>
              <p class="tile-value tile-value--positive money">
                {{ formatMoney(stats?.commission30d) }}<span class="tile-unit">ETB</span>
              </p>
              <p class="tile-sub">last 30 days</p>
            </div>
          </div>

          <div class="admin-card ledger-card">
            <h2 class="card-title card-title--inset">Float ledger</h2>

            <p v-if="ledger.length === 0" class="state-text state-text--inset">
              No float movements yet.
            </p>

            <div v-else class="table-wrap">
              <table class="admin-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th class="num">Amount</th>
                    <th class="num">Balance after</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="entry in ledger" :key="entry.id">
                    <td class="muted nowrap">{{ formatDateTime(entry.createdAt) }}</td>
                    <td>
                      <span class="entry-type">{{ formatType(entry.type) }}</span>
                      <span v-if="entryDetail(entry)" class="entry-detail">{{
                        entryDetail(entry)
                      }}</span>
                    </td>
                    <td
                      class="num money"
                      :class="isNegativeEntry(entry) ? 'amount-out' : 'amount-in'"
                    >
                      {{ signedAmount(entry) }}
                    </td>
                    <td class="num money muted">{{ formatMoney(entry.balanceAfter) }}</td>
                    <td class="muted">{{ entry.actorName || 'System' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Status modal ────────────────────────────────────────────────── -->
    <Teleport to="body">
      <div v-if="showStatus" class="modal-backdrop" @click.self="showStatus = false">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="status-title">
          <div class="modal-header">
            <h2 id="status-title">
              {{ statusTarget === 'ACTIVE' ? 'Reactivate agent' : 'Suspend agent' }}
            </h2>
            <button class="modal-close" aria-label="Close" @click="showStatus = false">
              <UIcon name="i-heroicons:x-mark" class="w-5 h-5" />
            </button>
          </div>
          <form class="modal-body" @submit.prevent="submitStatus">
            <p class="confirm-text">
              <template v-if="statusTarget === 'SUSPENDED'">
                A suspended agent keeps its float but cannot credit any more players.
              </template>
              <template v-else>
                The agent will be able to credit players again straight away.
              </template>
            </p>
            <div class="field">
              <label for="status-reason">Reason</label>
              <textarea
                id="status-reason"
                v-model="statusReason"
                rows="3"
                required
                minlength="3"
              ></textarea>
            </div>
            <p v-if="statusError" class="form-error">{{ statusError }}</p>
            <div class="modal-actions">
              <button type="button" class="btn-ghost" @click="showStatus = false">Cancel</button>
              <button
                type="submit"
                class="btn-primary"
                :class="statusTarget === 'SUSPENDED' ? 'btn-primary--danger' : ''"
                :disabled="savingStatus"
              >
                {{ savingStatus ? 'Saving' : statusTarget === 'ACTIVE' ? 'Reactivate' : 'Suspend' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 16px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-decoration: none;
}
.back-link:hover {
  color: var(--text-primary);
}

/* ── Header ────────────────────────────────────────────────────────────── */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}
.header-main {
  min-width: 0;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.page-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.meta-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-muted);
  opacity: 0.6;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}
.shop-edit {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.shop-edit input {
  height: 32px;
  padding: 0 10px;
  border-radius: 7px;
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
}
.shop-edit input:focus {
  outline: none;
  border-color: var(--brand-primary);
}

/* ── Columns ───────────────────────────────────────────────────────────── */
.columns {
  display: grid;
  grid-template-columns: minmax(0, 380px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
@media (max-width: 1080px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
}
.right-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* ── Issue float card ──────────────────────────────────────────────────── */
.issue-card {
  padding: 20px;
}
.card-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}
.card-title--inset {
  padding: 16px 16px 10px;
  margin: 0;
}
.card-sub {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--text-muted);
}
.segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 4px;
  margin-bottom: 18px;
  border-radius: 9px;
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
}
.segment {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}
.segment:hover {
  color: var(--text-primary);
}
.segment-input {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  margin: 0;
}
.segment--active {
  background: var(--brand-primary);
  color: #000;
}
.segment--active.segment--danger {
  background: var(--negative);
  color: #fff;
}
.segment:focus-within {
  outline: 2px solid var(--brand-primary);
  outline-offset: 1px;
}

.field {
  margin-bottom: 14px;
}
.field label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-secondary);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.field input,
.field textarea {
  width: 100%;
  padding: 0 12px;
  height: 38px;
  border-radius: 7px;
  background: var(--surface-base);
  border: 1px solid var(--surface-border);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  box-sizing: border-box;
  transition: border-color 0.12s;
}
.field textarea {
  height: auto;
  padding: 10px 12px;
  resize: vertical;
}
.field input:focus,
.field textarea:focus {
  outline: none;
  border-color: var(--brand-primary);
}
.field .input-lg {
  height: 52px;
  font-size: 24px;
  font-weight: 700;
}
.field-pair {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 10px;
}
.field-hint {
  margin: 0 0 14px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}
.field-hint--warn {
  color: #fbbf24;
}
.field-error {
  margin: 6px 0 12px;
  font-size: 11px;
  color: var(--negative);
}
.link-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--brand-primary);
  cursor: pointer;
  text-decoration: underline;
}
.total-box {
  padding: 14px 16px;
  margin-bottom: 16px;
  border-radius: 10px;
  background: var(--brand-glow);
  border: 1px solid rgba(245, 166, 35, 0.22);
}
.total-label {
  margin: 0 0 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.total-value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 30px;
  font-weight: 800;
  color: var(--brand-primary);
  line-height: 1.1;
}
.total-unit {
  font-size: 13px;
  font-weight: 700;
  opacity: 0.6;
}
.total-sub {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.btn-submit {
  width: 100%;
  height: 44px;
  border-radius: 8px;
  border: none;
  background: var(--brand-primary);
  color: #000;
  font-size: 14px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: opacity 0.12s;
}
.btn-submit:hover {
  opacity: 0.88;
}
.btn-submit:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn-submit--danger {
  background: var(--negative);
  color: #fff;
}

/* ── Tiles ─────────────────────────────────────────────────────────────── */
.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
}
.tile {
  padding: 16px 18px;
}
.tile-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin: 0 0 8px;
}
.tile-value {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.1;
}
.tile-value--amber {
  color: var(--brand-primary);
}
.tile-value--positive {
  color: var(--positive);
}
.tile-unit {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}
.tile-sub {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

/* ── Ledger ────────────────────────────────────────────────────────────── */
.ledger-card {
  overflow: hidden;
}
.table-wrap {
  overflow-x: auto;
}
.entry-type {
  display: block;
  font-size: 13px;
}
.entry-detail {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted);
}
.nowrap {
  white-space: nowrap;
}
.money {
  font-variant-numeric: tabular-nums;
}
.amount-in {
  color: var(--positive);
}
.amount-out {
  color: var(--negative);
}

/* ── States ────────────────────────────────────────────────────────────── */
.state-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 44px 24px;
  text-align: center;
}
.state-icon {
  color: var(--negative);
}
.state-text {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}
.state-text--inset {
  padding: 0 16px 20px;
  text-align: left;
}

/* ── Buttons ───────────────────────────────────────────────────────────── */
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 16px;
  border-radius: 7px;
  background: var(--brand-primary);
  color: #000;
  font-size: 13px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: opacity 0.12s;
}
.btn-primary:hover {
  opacity: 0.88;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-primary--danger {
  background: var(--negative);
  color: #fff;
}
.btn-ghost {
  height: 36px;
  padding: 0 16px;
  border-radius: 7px;
  background: none;
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition:
    background 0.12s,
    color 0.12s;
}
.btn-ghost:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}
.btn-ghost--danger {
  color: var(--negative);
  border-color: var(--negative-border);
}
.btn-ghost--danger:hover {
  background: var(--negative-bg);
  color: var(--negative);
}
.btn-sm {
  height: 32px;
  padding: 0 12px;
  font-size: 12px;
}

/* ── Modal ─────────────────────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.modal {
  width: 100%;
  max-width: 420px;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-border);
  border-radius: 12px;
  overflow: hidden;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--surface-border);
}
.modal-header h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}
.modal-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}
.modal-body {
  padding: 20px;
}
.confirm-text {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-secondary);
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
.form-error {
  font-size: 12px;
  color: var(--negative);
  margin: 0 0 12px;
}
.sr-only {
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

@media (max-width: 640px) {
  .page-header {
    flex-direction: column;
  }
}
</style>
