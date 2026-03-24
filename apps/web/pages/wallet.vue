<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const auth = useAuthStore()
const router = useRouter()

// Redirect unauthenticated users
onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.replace('/auth/login')
    return
  }
  await Promise.all([refreshBalance(), fetchRecentTx()])
})

const showDeposit = ref(false)
const showWithdrawal = ref(false)
const refreshing = ref(false)
const txLoading = ref(false)
const recentTx = ref<any[]>([])

const formattedRealBalance = computed(() => {
  const bal = Number(auth.wallet?.realBalance ?? 0)
  return bal.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
})

const formattedBonusBalance = computed(() => {
  const bal = Number(auth.wallet?.bonusBalance ?? 0)
  return bal.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
})

const formattedTotalBalance = computed(() => {
  const total = Number(auth.wallet?.realBalance ?? 0) + Number(auth.wallet?.bonusBalance ?? 0)
  return total.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
})

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
    ADMIN_REAL_ADJUSTMENT: 'Adjustment',
    ADMIN_BONUS_ADJUSTMENT: 'Bonus Adjustment',
  }
  return map[type] ?? type
}

function txSign(type: string): string {
  return ['DEPOSIT', 'PRIZE_WIN', 'REFUND', 'FIRST_DEPOSIT_BONUS', 'CASHBACK_BONUS', 'ADMIN_REAL_ADJUSTMENT', 'ADMIN_BONUS_ADJUSTMENT'].includes(type) ? '+' : '-'
}

function txAmountClass(type: string): string {
  return ['DEPOSIT', 'PRIZE_WIN', 'REFUND', 'FIRST_DEPOSIT_BONUS', 'CASHBACK_BONUS', 'ADMIN_REAL_ADJUSTMENT', 'ADMIN_BONUS_ADJUSTMENT'].includes(type) ? 'amount-positive' : 'amount-negative'
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
                <span class="tx-amount" :class="txAmountClass(tx.type)">
                  {{ txSign(tx.type) }}{{ Number(tx.amount).toFixed(2) }} ETB
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
  background: #000A38;
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
  font-size: 1.5rem;
  font-weight: 800;
  color: #f1f5f9;
  margin: 0;
  letter-spacing: -0.02em;
}
.refresh-btn-header {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 0.4rem;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.5);
  display: flex;
  align-items: center;
  transition: background 0.2s, color 0.2s;
}
.refresh-btn-header:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.refresh-btn-header:disabled { opacity: 0.4; cursor: not-allowed; }
.refresh-icon { width: 16px; height: 16px; }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Balance Card ─────────────────────────────────────────────────── */
.balance-card {
  background: linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 50%, #2563eb 100%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  padding: 1.5rem 1.75rem;
  box-shadow: 0 8px 32px rgba(37, 99, 235, 0.25);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.balance-label-row { display: flex; align-items: center; }
.balance-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.55);
}

.balance-display {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.balance-amount {
  font-size: 2.5rem;
  font-weight: 800;
  color: #fff;
  letter-spacing: -0.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.balance-currency {
  font-size: 1rem;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.5);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* ── Balance Breakdown ───────────────────────────────────────────── */
.balance-breakdown {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.balance-part {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.balance-part-label {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.4);
}
.balance-part-value {
  font-size: 1rem;
  font-weight: 700;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.balance-part-value--bonus {
  color: #67e8f9;
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
  padding: 0.7rem 1rem;
  border-radius: 12px;
  border: none;
  font-size: 0.9rem;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.15s, opacity 0.2s;
  font-family: inherit;
}
.action-btn:hover { transform: translateY(-1px); }
.action-btn:active { transform: translateY(0); }
.action-btn svg { width: 15px; height: 15px; flex-shrink: 0; }

.action-btn--deposit {
  background: #f59e0b;
  color: #000;
}
.action-btn--deposit:hover { background: #fbbf24; }

.action-btn--withdraw {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.2);
}
.action-btn--withdraw:hover { background: rgba(255, 255, 255, 0.2); }

/* ── Section ─────────────────────────────────────────────────────── */
.section { display: flex; flex-direction: column; gap: 0.6rem; }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-title {
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: rgba(255, 255, 255, 0.4);
}
.section-link {
  font-size: 0.8rem;
  font-weight: 600;
  color: #f59e0b;
  text-decoration: none;
  transition: opacity 0.2s;
}
.section-link:hover { opacity: 0.75; }

/* ── Transaction Card ─────────────────────────────────────────────── */
.tx-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 16px;
  overflow: hidden;
}

.tx-loading,
.tx-empty {
  padding: 1.5rem;
  text-align: center;
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.35);
}

.tx-list { display: flex; flex-direction: column; }

.tx-row {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.875rem 1rem;
}
.tx-row--bordered {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.tx-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tx-icon svg { width: 16px; height: 16px; }

.tx-icon--deposit    { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
.tx-icon--withdrawal { background: rgba(239, 68, 68, 0.15); color: #f87171; }
.tx-icon--prize_win  { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
.tx-icon--refund     { background: rgba(99, 102, 241, 0.15); color: #a5b4fc; }
.tx-icon--game_entry { background: rgba(14, 165, 233, 0.15); color: #38bdf8; }

.tx-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.tx-type {
  font-size: 0.875rem;
  font-weight: 600;
  color: #e2e8f0;
}
.tx-date {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.35);
}

.tx-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.2rem;
  flex-shrink: 0;
}
.tx-amount {
  font-size: 0.875rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.amount-positive { color: #4ade80; }
.amount-negative { color: #f87171; }

.tx-status {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.1rem 0.45rem;
  border-radius: 9999px;
}
.status-approved { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
.status-rejected { background: rgba(239, 68, 68, 0.15); color: #f87171; }
.status-pending  { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }

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
  padding: 0.875rem 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 14px;
  text-decoration: none;
  transition: background 0.2s, border-color 0.2s;
}
.quick-link:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(255, 255, 255, 0.12);
}

.ql-icon {
  width: 20px;
  height: 20px;
  color: #f59e0b;
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
  font-size: 0.875rem;
  font-weight: 600;
  color: #e2e8f0;
}
.ql-sub {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.35);
}

.ql-arrow {
  width: 15px;
  height: 15px;
  color: #475569;
  flex-shrink: 0;
}
</style>
