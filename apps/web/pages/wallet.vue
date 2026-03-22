<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const auth = useAuthStore()
const router = useRouter()

// Redirect unauthenticated users
onMounted(() => {
  if (!auth.isAuthenticated) {
    router.replace('/auth/login')
  }
})

const showDeposit = ref(false)
const showWithdrawal = ref(false)
const refreshing = ref(false)

const formattedBalance = computed(() => {
  const bal = Number(auth.wallet?.balance ?? 0)
  return bal.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
})

async function refreshBalance() {
  refreshing.value = true
  try {
    await auth.fetchWallet()
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <div class="wallet-page">
    <div class="wallet-inner">

      <!-- ── Header ───────────────────────────────────────────────── -->
      <div class="page-header">
        <h1 class="page-title">My Wallet</h1>
        <p class="page-sub">Manage your balance, deposits, and withdrawals</p>
      </div>

      <!-- ── Balance Card ─────────────────────────────────────────── -->
      <div class="balance-card">
        <div class="balance-card-top">
          <span class="balance-label">Available Balance</span>
          <button
            class="refresh-btn"
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
        <div class="balance-display">
          <span class="balance-amount">{{ formattedBalance }}</span>
          <span class="balance-currency">ETB</span>
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

      <!-- ── Quick Links ───────────────────────────────────────────── -->
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

    <!-- ── Modals ──────────────────────────────────────────────────── -->
    <DepositModal
      v-model="showDeposit"
      @deposited="auth.fetchWallet(); showDeposit = false"
    />
    <WithdrawalModal
      v-model="showWithdrawal"
      :balance="Number(auth.wallet?.balance ?? 0)"
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
  padding: 2rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Header ──────────────────────────────────────────────────────── */
.page-header { display: flex; flex-direction: column; gap: 0.3rem; }
.page-title {
  font-size: 1.6rem;
  font-weight: 800;
  color: #f1f5f9;
  margin: 0;
  letter-spacing: -0.02em;
}
.page-sub {
  font-size: 0.875rem;
  color: #64748b;
  margin: 0;
}

/* ── Balance Card ─────────────────────────────────────────────────── */
.balance-card {
  background: linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 50%, #2563eb 100%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  padding: 1.75rem;
  box-shadow: 0 8px 32px rgba(37, 99, 235, 0.25);
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.balance-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.balance-label {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.6);
}

.refresh-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  padding: 0.4rem;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  transition: background 0.2s, color 0.2s;
}
.refresh-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.refresh-icon { width: 16px; height: 16px; }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.balance-display {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.balance-amount {
  font-size: 2.75rem;
  font-weight: 800;
  color: #fff;
  letter-spacing: -0.03em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.balance-currency {
  font-size: 1rem;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.55);
  text-transform: uppercase;
  letter-spacing: 0.05em;
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
  padding: 0.75rem 1rem;
  border-radius: 12px;
  border: none;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.15s, opacity 0.2s;
  font-family: inherit;
}
.action-btn:hover { transform: translateY(-1px); }
.action-btn:active { transform: translateY(0); }
.action-btn svg { width: 16px; height: 16px; flex-shrink: 0; }

.action-btn--deposit {
  background: #f59e0b;
  color: #000;
}
.action-btn--deposit:hover { background: #fbbf24; }

.action-btn--withdraw {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.2);
}
.action-btn--withdraw:hover { background: rgba(255, 255, 255, 0.22); }

/* ── Quick Links ─────────────────────────────────────────────────── */
.quick-links {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.quick-link {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.125rem;
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
  width: 22px;
  height: 22px;
  color: #f59e0b;
  flex-shrink: 0;
}

.ql-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.ql-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: #e2e8f0;
}
.ql-sub {
  font-size: 0.78rem;
  color: #64748b;
}

.ql-arrow {
  width: 16px;
  height: 16px;
  color: #475569;
  flex-shrink: 0;
}
</style>
