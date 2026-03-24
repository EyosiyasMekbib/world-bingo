<template>
  <div class="profile-page">
    <h1 class="page-title">My Profile</h1>

    <!-- ── User Info Card ──────────────────────────────────────────── -->
    <div class="card user-card">
      <div class="avatar-row">
        <div class="avatar">
          <img v-if="auth.user?.photoUrl" :src="auth.user.photoUrl" class="avatar-photo" alt="Profile" />
          <span v-else>{{ (auth.user?.firstName ?? auth.user?.username ?? 'U')[0].toUpperCase() }}</span>
        </div>
        <div class="user-details">
          <h2 class="username">{{ auth.user?.firstName ?? auth.user?.username }}</h2>
          <p class="phone">{{ auth.user?.telegramUsername ? `@${auth.user.telegramUsername}` : auth.user?.phone }}</p>
          <div class="user-id-row">
            <span class="user-id">ID: #{{ formattedSerial }}</span>
            <button class="copy-btn" :title="serialCopied ? 'Copied!' : 'Copy ID'" @click="copySerial">
              <Icon :name="serialCopied ? 'heroicons:check' : 'heroicons:clipboard-document'" class="copy-icon" />
            </button>
          </div>
          <p class="member-since">
            Member since {{ formatDate(auth.user?.createdAt) }}
          </p>
        </div>
      </div>
    </div>

    <!-- ── Wallet Card ─────────────────────────────────────────────── -->
    <div class="card wallet-card">
      <div class="wallet-header">
        <h3 class="card-heading">
          <Icon name="heroicons:wallet" class="card-icon" />
          Wallet
        </h3>
        <button class="refresh-btn" :disabled="walletLoading" @click="refreshWallet">
          <Icon name="heroicons:arrow-path" class="btn-icon" :class="{ spinning: walletLoading }" />
          {{ walletLoading ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>
      <div class="balance-display">
        <span class="balance-amount">{{ formattedBalance }}</span>
        <span class="balance-currency">ETB</span>
      </div>
    </div>

    <!-- ── Game Stats Card ─────────────────────────────────────────── -->
    <div class="card stats-card">
      <h3 class="stats-title card-heading">
        <Icon name="heroicons:chart-bar" class="card-icon" />
        Game Stats
      </h3>
      <div v-if="statsLoading" class="loading-state">Loading…</div>
      <div v-else class="stats-grid">
        <div class="stat-tile">
          <span class="stat-val">{{ stats?.gamesPlayed ?? '—' }}</span>
          <span class="stat-label">Played</span>
        </div>
        <div class="stat-tile">
          <span class="stat-val">{{ stats?.gamesWon ?? '—' }}</span>
          <span class="stat-label">Won</span>
        </div>
        <div class="stat-tile">
          <span class="stat-val">{{ stats ? Number(stats.totalWagered).toFixed(0) : '—' }}</span>
          <span class="stat-label">Wagered (ETB)</span>
        </div>
        <div class="stat-tile">
          <span class="stat-val won">{{ stats ? Number(stats.totalWon).toFixed(0) : '—' }}</span>
          <span class="stat-label">Earned (ETB)</span>
        </div>
      </div>
    </div>

    <!-- ── Transaction History ─────────────────────────────────────── -->
    <div class="card">
      <div class="section-header">
        <h3 class="card-heading">
          <Icon name="heroicons:queue-list" class="card-icon" />
          Recent Transactions
        </h3>
        <NuxtLink to="/transactions" class="view-all-link">View all →</NuxtLink>
      </div>
      <div v-if="txLoading" class="loading-state">Loading transactions…</div>
      <div v-else-if="transactions.length === 0" class="empty-state">
        No transactions yet.
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
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'
import type { UserStatsDto } from '@world-bingo/shared-types'

const auth = useAuthStore()

// ── Serial ID ───────────────────────────────────────────────────────────
const serialCopied = ref(false)
const formattedSerial = computed(() =>
  String(auth.user?.serial ?? 0).padStart(5, '0')
)
function copySerial() {
  navigator.clipboard.writeText(formattedSerial.value)
  serialCopied.value = true
  setTimeout(() => { serialCopied.value = false }, 2000)
}

// ── Wallet ─────────────────────────────────────────────────────────────
const walletLoading = ref(false)
const formattedBalance = computed(() => {
  const total = Number(auth.wallet?.realBalance ?? 0) + Number(auth.wallet?.bonusBalance ?? 0)
  return total.toLocaleString('en-ET', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
})

async function refreshWallet() {
  walletLoading.value = true
  try {
    await auth.fetchWallet()
  } finally {
    walletLoading.value = false
  }
}

// ── Stats ───────────────────────────────────────────────────────────────
const stats = ref<UserStatsDto | null>(null)
const statsLoading = ref(false)
async function fetchStats() {
  statsLoading.value = true
  try { stats.value = await auth.apiFetch<UserStatsDto>('/wallet/stats') }
  catch { /* fail silently */ }
  finally { statsLoading.value = false }
}

// ── Transactions ───────────────────────────────────────────────────────
const transactions = ref<any[]>([])
const txLoading = ref(false)

async function fetchTransactions() {
  txLoading.value = true
  try {
    const data = await auth.apiFetch<{ data: any[]; pagination: any }>('/wallet/transactions?page=1&limit=5')
    transactions.value = data?.data ?? []
  } catch {
    // fail silently
  } finally {
    txLoading.value = false
  }
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

// ── Date formatting ────────────────────────────────────────────────────
function formatDate(date: Date | string | undefined): string {
  if (!date) return '—'
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ── Init ───────────────────────────────────────────────────────────────
onMounted(() => {
  if (!auth.wallet) auth.fetchWallet()
  fetchTransactions()
  fetchStats()
})
</script>

<style scoped>
.profile-page {
  max-width: 700px;
  margin: 0 auto;
  padding: 2rem 1.5rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.page-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  margin: 0;
}

/* ── Card ───────────────────────────────────────────────────────────── */
.card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  padding: 1.5rem;
}

/* ── User Card ──────────────────────────────────────────────────────── */
.avatar-row {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}

.avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: linear-gradient(135deg, #f59e0b, #d97706);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
  font-weight: 800;
  color: #000;
  flex-shrink: 0;
  overflow: hidden;
}

.avatar-photo {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.username {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  margin: 0;
}

.phone {
  color: var(--text-secondary, #94a3b8);
  font-size: 0.9rem;
  margin: 0.15rem 0 0;
}

.user-id-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.3rem;
}

.user-id {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary, #94a3b8);
  font-family: var(--font-mono, monospace);
  letter-spacing: 0.05em;
}

.copy-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.1rem 0.2rem;
  line-height: 1;
  display: flex;
  align-items: center;
  color: var(--text-secondary, #94a3b8);
  opacity: 0.7;
  transition: opacity 0.2s, color 0.2s;
}

.copy-btn:hover {
  opacity: 1;
  color: var(--text-primary, #f1f5f9);
}

.copy-icon {
  width: 14px;
  height: 14px;
}

.member-since {
  color: var(--text-disabled, #475569);
  font-size: 0.8rem;
  margin: 0.25rem 0 0;
}

/* ── Wallet Card ────────────────────────────────────────────────────── */
.wallet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.wallet-header h3 {
  margin: 0;
  font-size: 1rem;
  color: var(--text-primary, #f1f5f9);
}

.card-heading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.card-icon {
  width: 18px;
  height: 18px;
  color: #f59e0b;
  flex-shrink: 0;
}

.btn-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.refresh-btn {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: var(--text-secondary, #94a3b8);
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.2s;
}

.refresh-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary, #f1f5f9);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.balance-display {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.balance-amount {
  font-size: 2rem;
  font-weight: 800;
  color: #f59e0b;
  font-family: var(--font-game, 'Rajdhani', sans-serif);
}

.balance-currency {
  font-size: 1rem;
  color: var(--text-secondary, #94a3b8);
  font-weight: 600;
}

/* ── Stats Card ─────────────────────────────────────────────────────── */
.stats-title {
  margin: 0 0 1rem;
  font-size: 1rem;
  color: var(--text-primary, #f1f5f9);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
}

@media (max-width: 480px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.stat-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  padding: 0.85rem 0.5rem;
  text-align: center;
}

.stat-val {
  font-size: 1.5rem;
  font-weight: 800;
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-game, 'Rajdhani', sans-serif);
}

.stat-val.won {
  color: #10b981;
}

.stat-label {
  font-size: 0.7rem;
  color: var(--text-secondary, #94a3b8);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

/* ── Transactions ───────────────────────────────────────────────────── */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.section-header h3 {
  margin: 0;
  font-size: 1rem;
  color: var(--text-primary, #f1f5f9);
}

.view-all-link {
  font-size: 0.85rem;
  color: #f59e0b;
  text-decoration: none;
  font-weight: 600;
  transition: color 0.2s;
}

.view-all-link:hover {
  color: #fbbf24;
}

.loading-state,
.empty-state {
  text-align: center;
  color: var(--text-secondary, #94a3b8);
  padding: 2rem 0;
  font-size: 0.9rem;
}

.tx-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.tx-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  transition: background 0.15s;
}

.tx-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.tx-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-secondary, #94a3b8);
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
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
}

.tx-date {
  font-size: 0.75rem;
  color: var(--text-disabled, #475569);
}

.tx-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.25rem;
  flex-shrink: 0;
}

.tx-amount {
  font-weight: 700;
  font-size: 0.9rem;
  white-space: nowrap;
}

.tx-amount.positive {
  color: #10b981;
}

.tx-amount.negative {
  color: #ef4444;
}

.tx-status {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.status-approved {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.status-pending,
.status-pending_review {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.status-rejected {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}
</style>
