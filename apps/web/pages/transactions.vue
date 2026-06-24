<template>
  <div class="tx-page">
    <!-- Header -->
    <div class="page-header">
      <NuxtLink to="/profile" class="back-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </NuxtLink>
      <h1 class="page-title">Transaction History</h1>
    </div>

    <!-- Type filter pills -->
    <div class="filter-pills">
      <button
        v-for="f in filters"
        :key="f.value"
        class="pill"
        :class="{ active: selectedType === f.value }"
        @click="setFilter(f.value)"
      >
        {{ f.label }}
      </button>
    </div>

    <!-- Transaction list -->
    <div class="card">
      <div v-if="txLoading" class="loading-state">Loading transactions…</div>
      <div v-else-if="transactions.length === 0" class="empty-state">
        No transactions found.
      </div>
      <div v-else class="tx-list">
        <div v-for="tx in transactions" :key="tx.id" class="tx-row">
          <div class="tx-icon">
            <Icon :name="txIconName(tx.type)" class="tx-icon-svg" />
          </div>
          <div class="tx-info">
            <span class="tx-type">{{ txLabel(tx.type) }}</span>
            <span class="tx-date">{{ formatDate(tx.createdAt) }}</span>
          </div>
          <div class="tx-right">
            <div class="tx-amount" :class="txAmountClass(tx.type)">
              {{ txSign(tx.type) }}{{ Number(tx.amount).toFixed(2) }} ETB
            </div>
            <span class="tx-status" :class="`status-${tx.status?.toLowerCase()}`">
              {{ tx.status }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="pagination">
      <button class="page-btn" :disabled="currentPage <= 1" @click="goToPage(currentPage - 1)">
        ← Prev
      </button>
      <span class="page-info">Page {{ currentPage }} of {{ totalPages }}</span>
      <button class="page-btn" :disabled="currentPage >= totalPages" @click="goToPage(currentPage + 1)">
        Next →
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
definePageMeta({ middleware: ['auth'] as any })

const auth = useAuthStore()

const filters = [
  { label: 'All', value: '' },
  { label: 'Deposit', value: 'DEPOSIT' },
  { label: 'Withdrawal', value: 'WITHDRAWAL' },
  { label: 'Game Entry', value: 'GAME_ENTRY' },
  { label: 'Prize Won', value: 'PRIZE_WIN' },
  { label: 'Refund', value: 'REFUND' },
]

const selectedType = ref('')
const currentPage = ref(1)
const totalPages = ref(1)
const transactions = ref<any[]>([])
const txLoading = ref(false)

async function fetchTransactions() {
  txLoading.value = true
  try {
    const params = new URLSearchParams({ page: String(currentPage.value), limit: '20' })
    if (selectedType.value) params.set('type', selectedType.value)
    const data = await auth.apiFetch<{ data: any[]; pagination: any }>(`/wallet/transactions?${params}`)
    transactions.value = data?.data ?? []
    totalPages.value = data?.pagination?.totalPages ?? 1
  } catch {
    // fail silently
  } finally {
    txLoading.value = false
  }
}

function setFilter(type: string) {
  selectedType.value = type
  currentPage.value = 1
  fetchTransactions()
}

function goToPage(page: number) {
  currentPage.value = page
  fetchTransactions()
}

function txIconName(type: string): string {
  const map: Record<string, string> = {
    DEPOSIT: 'heroicons:arrow-down-tray',
    WITHDRAWAL: 'heroicons:arrow-up-tray',
    GAME_ENTRY: 'heroicons:play-circle',
    PRIZE_WIN: 'heroicons:trophy',
    REFUND: 'heroicons:arrow-uturn-left',
  }
  return map[type] ?? 'heroicons:currency-dollar'
}

function txLabel(type: string): string {
  const map: Record<string, string> = {
    DEPOSIT: 'Deposit',
    WITHDRAWAL: 'Withdrawal',
    GAME_ENTRY: 'Game Entry',
    PRIZE_WIN: 'Prize Won',
    REFUND: 'Refund',
  }
  return map[type] ?? type
}

function txSign(type: string): string {
  return ['DEPOSIT', 'PRIZE_WIN', 'REFUND'].includes(type) ? '+' : '-'
}

function txAmountClass(type: string): string {
  return ['DEPOSIT', 'PRIZE_WIN', 'REFUND'].includes(type) ? 'positive' : 'negative'
}

function formatDate(date: Date | string | undefined): string {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

onMounted(() => {
  fetchTransactions()
})
</script>

<style scoped>
.tx-page {
  max-width: 700px;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Header ─────────────────────────────────────────────────────────── */
.page-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-md, 12px);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
  text-decoration: none;
  flex-shrink: 0;
  transition: background 0.2s, color 0.2s;
}

.back-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--brand-primary);
}

.back-btn svg {
  width: 18px;
  height: 18px;
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

/* ── Filter pills ───────────────────────────────────────────────────── */
.filter-pills {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.pill {
  padding: 0.45rem 0.9rem;
  border-radius: var(--radius-full, 9999px);
  border: 1px solid var(--surface-border);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.pill:hover {
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-primary);
}

.pill.active {
  background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
  border-color: var(--brand-primary);
  color: var(--brand-primary);
}

/* ── Card ───────────────────────────────────────────────────────────── */
.card {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-lg, 16px);
  padding: 1rem;
}

/* ── Transaction list ───────────────────────────────────────────────── */
.loading-state,
.empty-state {
  text-align: center;
  color: var(--text-secondary);
  padding: 2.5rem 0;
  font-size: 0.9rem;
}

.tx-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.tx-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: var(--radius-md, 12px);
  background: rgba(255, 255, 255, 0.02);
  transition: background 0.15s;
}

.tx-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.tx-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md, 12px);
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--brand-primary);
}

.tx-icon-svg {
  width: 16px;
  height: 16px;
}

.tx-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
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
  gap: 0.25rem;
  flex-shrink: 0;
}

.tx-amount {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 14px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.tx-amount.positive {
  color: var(--status-success);
}

.tx-amount.negative {
  color: var(--status-error);
}

.tx-status {
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 0.2rem 0.5rem;
  border-radius: var(--radius-sm, 6px);
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.status-approved,
.status-completed {
  background: color-mix(in srgb, var(--status-success) 16%, transparent);
  color: var(--status-success);
}

.status-pending,
.status-pending_review {
  background: color-mix(in srgb, var(--brand-primary) 16%, transparent);
  color: var(--brand-primary);
}

.status-rejected,
.status-failed {
  background: color-mix(in srgb, var(--status-error) 16%, transparent);
  color: var(--status-error);
}

/* ── Pagination ─────────────────────────────────────────────────────── */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
}

.page-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--surface-border);
  color: var(--text-primary);
  padding: 0.6rem 1.1rem;
  border-radius: var(--radius-md, 12px);
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}

.page-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.09);
  border-color: color-mix(in srgb, var(--brand-primary) 40%, transparent);
}

.page-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.page-info {
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 600;
  letter-spacing: 0.4px;
  min-width: 100px;
  text-align: center;
}
</style>
