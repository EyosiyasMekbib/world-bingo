<script setup lang="ts">
import type { LedgerResponse, LedgerRow, LedgerType } from '~/composables/useAgentApi'

const api = useAgentApi()

const PAGE_SIZE = 25

const TYPE_OPTIONS: { value: LedgerType | ''; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'FULFILLMENT', label: 'Fulfilment' },
  { value: 'TOP_UP', label: 'Top up' },
  { value: 'COMMISSION', label: 'Commission' },
  { value: 'ADJUSTMENT', label: 'Adjustment' },
]

const TYPE_LABEL: Record<LedgerType, string> = {
  FULFILLMENT: 'Fulfilment',
  TOP_UP: 'Top up',
  COMMISSION: 'Commission',
  ADJUSTMENT: 'Adjustment',
}

const TYPE_TONE: Record<LedgerType, string> = {
  FULFILLMENT: 'status-tag--warning',
  TOP_UP: 'status-tag--positive',
  COMMISSION: 'status-tag--brand',
  ADJUSTMENT: 'status-tag--neutral',
}

/**
 * Which way a row moves the float. The API sends `amount` as a magnitude for
 * some row types and already signed for others, so a leading minus is trusted
 * when it is there and the row type decides otherwise. A fulfilment always
 * takes float out; a top up and a commission always put it in.
 */
const signedAmount = (row: LedgerRow): string => {
  if (row.amount.trim().startsWith('-')) return row.amount
  if (row.type === 'FULFILLMENT') return `-${row.amount.trim().replace(/^\+/, '')}`
  return row.amount
}

const today = isoDay()
const monthAgo = isoDay(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000))

const filters = reactive({
  from: monthAgo,
  to: today,
  type: '' as LedgerType | '',
})

const page = ref(1)
const data = ref<LedgerResponse | null>(null)
const pending = ref(false)
const errorMessage = ref('')

const totalPages = computed(() => {
  if (!data.value) return 1
  return Math.max(1, Math.ceil(data.value.total / PAGE_SIZE))
})

const rangeStart = computed(() => (data.value?.total ? (page.value - 1) * PAGE_SIZE + 1 : 0))
const rangeEnd = computed(() => Math.min(page.value * PAGE_SIZE, data.value?.total ?? 0))

const load = async () => {
  pending.value = true
  errorMessage.value = ''
  try {
    data.value = await api.getLedger({
      from: filters.from || undefined,
      to: filters.to || undefined,
      type: filters.type || undefined,
      page: page.value,
      pageSize: PAGE_SIZE,
    })
  } catch (err) {
    errorMessage.value = apiErrorMessage(
      err,
      'Could not load your float ledger. Check the connection and try again.',
    )
  } finally {
    pending.value = false
  }
}

const applyFilters = () => {
  page.value = 1
  load()
}

const goToPage = (next: number) => {
  if (next < 1 || next > totalPages.value || next === page.value) return
  page.value = next
  load()
}

/** The detail column: what the row is actually about, in one line. */
const rowDetail = (row: LedgerRow): string => {
  const parts: string[] = []
  if (row.playerMaskedName) parts.push(row.playerMaskedName)
  if (row.requestCode) parts.push(`Code ${row.requestCode}`)
  if (row.actorName) parts.push(`By ${row.actorName}`)
  if (row.note) parts.push(row.note)
  return parts.length ? parts.join(', ') : '-'
}

onMounted(load)
</script>

<template>
  <div class="history">
    <header class="history-head">
      <h1 class="history-title">Float ledger</h1>
      <p class="history-sub">Every movement in and out of your shop's float.</p>
    </header>

    <!-- ── Filters ─────────────────────────────────────────────────── -->
    <form class="agent-card filters" @submit.prevent="applyFilters">
      <div class="filter">
        <label class="field-label" for="filter-from">From</label>
        <input
          id="filter-from"
          v-model="filters.from"
          type="date"
          class="field-input"
          :max="filters.to"
        />
      </div>

      <div class="filter">
        <label class="field-label" for="filter-to">To</label>
        <input
          id="filter-to"
          v-model="filters.to"
          type="date"
          class="field-input"
          :min="filters.from"
        />
      </div>

      <div class="filter">
        <label class="field-label" for="filter-type">Type</label>
        <select id="filter-type" v-model="filters.type" class="field-input">
          <option v-for="option in TYPE_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>

      <button type="submit" class="btn btn--primary filter-submit" :disabled="pending">
        <span v-if="pending" class="spinner" aria-hidden="true"></span>
        <span>{{ pending ? 'Loading' : 'Apply' }}</span>
      </button>
    </form>

    <!-- ── Summary ─────────────────────────────────────────────────── -->
    <div class="tiles">
      <section class="agent-card tile">
        <p class="tile-label">Fulfilled, last 7 days</p>
        <p class="tile-value tnum">{{ formatMoney(data?.summary.fulfilled7d) }}</p>
        <p class="tile-unit">ETB</p>
      </section>
      <section class="agent-card tile">
        <p class="tile-label">Deposits, last 7 days</p>
        <p class="tile-value tnum">{{ formatCount(data?.summary.deposits7d) }}</p>
        <p class="tile-unit">Deposits</p>
      </section>
      <section class="agent-card tile">
        <p class="tile-label">Topped up, last 7 days</p>
        <p class="tile-value tnum">{{ formatMoney(data?.summary.toppedUp7d) }}</p>
        <p class="tile-unit">ETB</p>
      </section>
      <section class="agent-card tile tile--float">
        <p class="tile-label">Float now</p>
        <p class="tile-value tile-value--brand tnum">{{ formatMoney(data?.summary.float) }}</p>
        <p class="tile-unit">ETB</p>
      </section>
    </div>

    <!-- ── Rows ────────────────────────────────────────────────────── -->
    <section class="agent-card rows-card">
      <p v-if="pending && !data" class="state-line">Loading your ledger</p>

      <div v-else-if="errorMessage" class="state-block" role="alert">
        <p class="state-line state-line--error">{{ errorMessage }}</p>
        <button type="button" class="btn btn--ghost btn--small" @click="load">Try again</button>
      </div>

      <p v-else-if="!data || data.rows.length === 0" class="state-line">
        No float movements in this range. Widen the dates or clear the type filter.
      </p>

      <template v-else>
        <div class="table-wrap">
          <table class="agent-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Type</th>
                <th scope="col">Detail</th>
                <th scope="col" class="num">Amount</th>
                <th scope="col" class="num">Float after</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in data.rows" :key="row.id">
                <td class="code">{{ formatDateTime(row.createdAt) }}</td>
                <td>
                  <span class="status-tag" :class="TYPE_TONE[row.type]">
                    {{ TYPE_LABEL[row.type] ?? row.type }}
                  </span>
                </td>
                <td class="muted">{{ rowDetail(row) }}</td>
                <td
                  class="num"
                  :class="isNegativeAmount(signedAmount(row)) ? 'amount--out' : 'amount--in'"
                >
                  {{ formatSigned(signedAmount(row)) }}
                </td>
                <td class="num">{{ formatMoney(row.balanceAfter) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <nav class="pager" aria-label="Ledger pages">
          <p class="pager-count">
            Showing <span class="tnum">{{ rangeStart }}</span> to
            <span class="tnum">{{ rangeEnd }}</span> of
            <span class="tnum">{{ data.total }}</span>
          </p>
          <div class="pager-controls">
            <button
              type="button"
              class="btn btn--ghost btn--small"
              :disabled="page <= 1 || pending"
              @click="goToPage(page - 1)"
            >
              Previous
            </button>
            <span class="pager-page tnum">Page {{ page }} of {{ totalPages }}</span>
            <button
              type="button"
              class="btn btn--ghost btn--small"
              :disabled="page >= totalPages || pending"
              @click="goToPage(page + 1)"
            >
              Next
            </button>
          </div>
        </nav>
      </template>
    </section>
  </div>
</template>

<style scoped>
.history {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1320px;
  margin: 0 auto;
}

.history-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.history-title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.005em;
  line-height: 1.1;
}

.history-sub {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

/* ── Filters ─────────────────────────────────────────────────────────── */
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 14px;
  padding: 18px 20px;
}

.filter {
  display: flex;
  flex-direction: column;
  min-width: 168px;
}

.filter-submit {
  min-width: 128px;
}

/* ── Tiles ───────────────────────────────────────────────────────────── */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
  gap: 14px;
}

.tile {
  padding: 16px 18px;
}

.tile--float {
  border-color: color-mix(in srgb, var(--brand-primary) 26%, transparent);
}

.tile-label {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.tile-value {
  margin: 8px 0 0;
  font-family: var(--font-ui);
  font-size: 30px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.01em;
}

.tile-value--brand {
  color: var(--brand-primary);
}

.tile-unit {
  margin: 4px 0 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  color: var(--text-muted);
}

/* ── Rows ────────────────────────────────────────────────────────────── */
.rows-card {
  padding-bottom: 6px;
}

.table-wrap {
  overflow-x: auto;
}

.amount--in {
  color: var(--positive);
}
.amount--out {
  color: var(--warning);
}

.state-line {
  margin: 0;
  padding: 22px 20px;
  font-size: 13px;
  color: var(--text-muted);
}

.state-line--error {
  color: #fca5a5;
  padding-bottom: 8px;
}

.state-block {
  padding: 0 20px 18px;
}

.btn--small {
  height: 34px;
  padding: 0 14px;
  font-size: 12px;
}

/* ── Pager ───────────────────────────────────────────────────────────── */
.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px 16px;
  border-top: 1px solid var(--surface-line);
}

.pager-count {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.pager-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pager-page {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
</style>
