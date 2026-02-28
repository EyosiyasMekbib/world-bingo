<template>
  <div class="profile-page">
    <h1 class="page-title">My Profile</h1>

    <!-- ── User Info Card ──────────────────────────────────────────── -->
    <div class="card user-card">
      <div class="avatar-row">
        <div class="avatar">
          {{ (auth.user?.username ?? 'U')[0].toUpperCase() }}
        </div>
        <div class="user-details">
          <h2 class="username">{{ auth.user?.username }}</h2>
          <p class="phone">{{ auth.user?.phone }}</p>
          <p class="member-since">
            Member since {{ formatDate(auth.user?.createdAt) }}
          </p>
        </div>
      </div>
    </div>

    <!-- ── Wallet Card ─────────────────────────────────────────────── -->
    <div class="card wallet-card">
      <div class="wallet-header">
        <h3>💰 Wallet</h3>
        <button class="refresh-btn" @click="refreshWallet" :disabled="walletLoading">
          {{ walletLoading ? 'Refreshing…' : '🔄 Refresh' }}
        </button>
      </div>
      <div class="balance-display">
        <span class="balance-amount">{{ formattedBalance }}</span>
        <span class="balance-currency">ETB</span>
      </div>
    </div>

    <!-- ── Transaction History ─────────────────────────────────────── -->
    <div class="card">
      <div class="section-header">
        <h3>📋 Recent Transactions</h3>
      </div>
      <div v-if="txLoading" class="loading-state">Loading transactions…</div>
      <div v-else-if="transactions.length === 0" class="empty-state">
        No transactions yet.
      </div>
      <div v-else class="tx-list">
        <div v-for="tx in transactions" :key="tx.id" class="tx-row">
          <div class="tx-icon">{{ txIcon(tx.type) }}</div>
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

    <!-- ── Change Password (collapsible) ───────────────────────────── -->
    <div class="card">
      <button class="section-toggle" @click="showPasswordForm = !showPasswordForm">
        <h3 class="section-title">🔒 Change Password</h3>
        <span class="toggle-chevron" :class="{ open: showPasswordForm }">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </button>
      <Transition name="slide-fade">
        <form v-if="showPasswordForm" class="password-form" @submit.prevent="handleChangePassword">
        <div class="field">
          <label>Current Password</label>
          <input
            v-model="passwordForm.currentPassword"
            type="password"
            placeholder="Enter current password"
            required
            class="input"
          />
        </div>
        <div class="field">
          <label>New Password</label>
          <input
            v-model="passwordForm.newPassword"
            type="password"
            placeholder="Min 6 characters"
            required
            minlength="6"
            class="input"
          />
        </div>
        <div class="field">
          <label>Confirm New Password</label>
          <input
            v-model="passwordForm.confirmPassword"
            type="password"
            placeholder="Re-enter new password"
            required
            minlength="6"
            class="input"
          />
        </div>
        <p v-if="pwError" class="msg error">{{ pwError }}</p>
        <p v-if="pwSuccess" class="msg success">✅ Password changed successfully!</p>
        <button type="submit" class="btn-primary" :disabled="pwLoading">
          {{ pwLoading ? 'Changing…' : 'Change Password' }}
        </button>
      </form>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const auth = useAuthStore()
const config = useRuntimeConfig()

// ── Wallet ─────────────────────────────────────────────────────────────
const walletLoading = ref(false)
const showPasswordForm = ref(false)
const formattedBalance = computed(() => {
  const bal = Number(auth.wallet?.balance ?? 0)
  return bal.toLocaleString('en-ET', {
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

// ── Transactions ───────────────────────────────────────────────────────
const transactions = ref<any[]>([])
const txLoading = ref(false)

async function fetchTransactions() {
  txLoading.value = true
  try {
    const data = await auth.apiFetch<any[]>('/wallet/transactions')
    transactions.value = data ?? []
  } catch {
    // fail silently
  } finally {
    txLoading.value = false
  }
}

function txIcon(type: string): string {
  const map: Record<string, string> = {
    DEPOSIT: '💰',
    WITHDRAWAL: '💸',
    GAME_ENTRY: '🎮',
    PRIZE_WIN: '🏆',
    REFUND: '↩️',
  }
  return map[type] ?? '💲'
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

// ── Change Password ────────────────────────────────────────────────────
const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const pwError = ref('')
const pwSuccess = ref(false)
const pwLoading = ref(false)

async function handleChangePassword() {
  pwError.value = ''
  pwSuccess.value = false

  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    pwError.value = 'New passwords do not match.'
    return
  }
  if (passwordForm.newPassword.length < 6) {
    pwError.value = 'New password must be at least 6 characters.'
    return
  }

  pwLoading.value = true
  try {
    await auth.apiFetch('/auth/change-password', {
      method: 'POST',
      body: {
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
      },
    })
    pwSuccess.value = true
    passwordForm.currentPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
  } catch (e: any) {
    pwError.value =
      e?.data?.message ?? e?.message ?? 'Failed to change password.'
  } finally {
    pwLoading.value = false
  }
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
  font-size: 1.25rem;
  flex-shrink: 0;
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

/* ── Change Password Toggle ─────────────────────────────────────────── */
.section-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
}

.section-toggle:hover .section-title {
  color: #f59e0b;
}

.toggle-chevron {
  display: flex;
  align-items: center;
  color: var(--text-secondary, #94a3b8);
  transition: transform 0.25s ease;
}

.toggle-chevron.open {
  transform: rotate(180deg);
}

/* Slide-fade transition for password form */
.slide-fade-enter-active {
  transition: all 0.25s ease;
}
.slide-fade-leave-active {
  transition: all 0.2s ease;
}
.slide-fade-enter-from {
  opacity: 0;
  transform: translateY(-10px);
}
.slide-fade-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

/* ── Change Password ────────────────────────────────────────────────── */
.section-title {
  margin: 0;
  font-size: 1rem;
  color: var(--text-primary, #f1f5f9);
  transition: color 0.2s;
}

.password-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-top: 1.25rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.input {
  width: 100%;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 0.7rem 1rem;
  font-size: 0.95rem;
  font-family: inherit;
  color: var(--text-primary, #f1f5f9);
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.input:focus {
  border-color: var(--brand-primary, #f59e0b);
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15);
}

.input::placeholder {
  color: var(--text-disabled, #475569);
}

.btn-primary {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #000;
  border: none;
  border-radius: 10px;
  padding: 0.75rem 1.5rem;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s;
  margin-top: 0.25rem;
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(245, 158, 11, 0.3);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.msg {
  font-size: 0.85rem;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  margin: 0;
}

.msg.error {
  color: #f87171;
  background: rgba(239, 68, 68, 0.1);
}

.msg.success {
  color: #10b981;
  background: rgba(16, 185, 129, 0.1);
}
</style>
