<script setup lang="ts">
const { getStats } = useAdminApi()

const loading = ref(false)
const stats = ref<{
  approvedDepositSum: number
  approvedWithdrawalSum: number
  depositCount: number
  withdrawalCount: number
  avgDeposit: number
  avgWithdrawal: number
  netValuePct: number
  withdrawalRatePct: number
  totalPrizesSum: number
  gamesCompleted: number
  gamesCancelled: number
  totalPrizePools: number
  activePlayers: number
  registeredPlayers: number
  inactivePlayers: number
  houseBalance: number
  houseCommissionEarned: number
  totalProviderProfit: number
  totalProfit: number
  providerStats: Array<{ name: string; gained: number; lost: number; net: number }>
} | null>(null)

const refresh = async () => {
  loading.value = true
  try {
    stats.value = await getStats() as any
  } catch (e) {
    console.error('Failed to fetch stats', e)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

const fmt = (n: number) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return n.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const fmtFull = (n: number) =>
  n.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtInt = (n: number) => n.toLocaleString('en-ET')

const fmtK = (n: number) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M ETB'
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K ETB'
  return n.toFixed(2) + ' ETB'
}

const netFlow = computed(() =>
  (stats.value?.approvedDepositSum ?? 0) - (stats.value?.approvedWithdrawalSum ?? 0)
)

// Players bar: registered vs active proportion
const playerBarRegisteredPct = computed(() => {
  const reg = stats.value?.registeredPlayers ?? 0
  const active = stats.value?.activePlayers ?? 0
  if (reg === 0) return 50
  return Math.round((reg / (reg + active)) * 100)
})

// Deposit/withdrawal ring: withdrawal rate vs deposit
const depositRatePct = computed(() => Math.min(100, Math.max(0, 100 - (stats.value?.withdrawalRatePct ?? 0))))

// Financial bar: prize pools vs prizes paid
const betPct = computed(() => {
  const bet = stats.value?.totalPrizePools ?? 0
  const win = stats.value?.totalPrizesSum ?? 0
  if (bet + win === 0) return 50
  return Math.round((bet / (bet + win)) * 100)
})

const ggrPct = computed(() => {
  const pools = stats.value?.totalPrizePools ?? 0
  if (pools === 0) return 0
  const ggr = pools - (stats.value?.totalPrizesSum ?? 0)
  return ((ggr / pools) * 100)
})
</script>

<template>
  <div class="dashboard">

    <!-- Header -->
    <div class="db-header">
      <h1 class="db-title">Dashboard</h1>
      <button class="db-refresh" :disabled="loading" @click="refresh">
        <UIcon name="i-heroicons:arrow-path" class="w-4 h-4" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- Players card -->
    <div class="db-card">
      <div class="db-card-head">
        <div class="db-card-label">
          <UIcon name="i-heroicons:users" class="w-4 h-4" />
          Players
        </div>
        <NuxtLink to="/players" class="db-see-link">
          See Players
          <UIcon name="i-heroicons:arrow-top-right-on-square" class="w-3.5 h-3.5" />
        </NuxtLink>
      </div>

      <!-- Stacked bar -->
      <div class="db-bar-track">
        <div class="db-bar-seg db-bar-seg--blue" :style="{ width: playerBarRegisteredPct + '%' }" />
        <div class="db-bar-seg db-bar-seg--green" :style="{ width: (100 - playerBarRegisteredPct) + '%' }" />
      </div>

      <div class="db-stat-row">
        <span class="db-dot db-dot--blue"></span>
        <span class="db-stat-label">Registered Players</span>
        <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
      </div>
      <div class="db-stat-value">{{ fmtInt(stats?.registeredPlayers ?? 0) }}</div>

      <div class="db-stat-row mt-3">
        <span class="db-dot db-dot--green"></span>
        <span class="db-stat-label">Total Active Players</span>
        <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
      </div>
      <div class="db-stat-value">{{ fmtInt(stats?.activePlayers ?? 0) }}</div>

      <div class="db-stat-row mt-3">
        <span class="db-dot db-dot--orange"></span>
        <span class="db-stat-label">Inactive Players</span>
        <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
      </div>
      <div class="db-stat-value">{{ fmtInt(stats?.inactivePlayers ?? 0) }}</div>
    </div>

    <!-- Deposits / Withdrawals card -->
    <div class="db-card">
      <!-- Ring + averages -->
      <div class="db-ring-row">
        <div class="db-ring-wrap">
          <svg viewBox="0 0 100 100" class="db-ring-svg">
            <circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="10" />
            <!-- green arc: deposit portion -->
            <circle
              cx="50" cy="50" r="38"
              fill="none"
              stroke="#22c55e"
              stroke-width="10"
              stroke-dasharray="238.76"
              :stroke-dashoffset="238.76 * (1 - depositRatePct / 100)"
              stroke-linecap="round"
              transform="rotate(-90 50 50)"
            />
            <!-- red arc: withdrawal portion -->
            <circle
              cx="50" cy="50" r="38"
              fill="none"
              stroke="#ef4444"
              stroke-width="10"
              stroke-dasharray="238.76"
              :stroke-dashoffset="238.76 * depositRatePct / 100"
              stroke-linecap="round"
              transform="rotate(-90 50 50) scale(-1,1) translate(-100,0)"
            />
            <text x="50" y="44" text-anchor="middle" class="db-ring-label-sm" fill="rgba(255,255,255,0.6)" font-size="8">Rate</text>
            <text x="50" y="58" text-anchor="middle" class="db-ring-label-lg" fill="white" font-size="11" font-weight="700">{{ (stats?.withdrawalRatePct ?? 0).toFixed(2) }}%</text>
          </svg>
        </div>
        <div class="db-avg-col">
          <div class="db-avg-label">Average deposit</div>
          <div class="db-avg-value">{{ fmtK(stats?.avgDeposit ?? 0) }}</div>
          <div class="db-avg-label mt-3">Average withdraw</div>
          <div class="db-avg-value">{{ fmtK(stats?.avgWithdrawal ?? 0) }}</div>
        </div>
      </div>

      <div class="db-stat-row mt-4">
        <span class="db-dot db-dot--green"></span>
        <span class="db-stat-label">Total Deposit Amount / Count</span>
        <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
      </div>
      <div class="db-stat-value">{{ fmtFull(stats?.approvedDepositSum ?? 0) }} ETB / {{ fmtInt(stats?.depositCount ?? 0) }}</div>

      <div class="db-stat-row mt-3">
        <span class="db-dot db-dot--red"></span>
        <span class="db-stat-label">Total Withdrawal Amount / Count</span>
        <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
      </div>
      <div class="db-stat-value">{{ fmtFull(stats?.approvedWithdrawalSum ?? 0) }} ETB / {{ fmtInt(stats?.withdrawalCount ?? 0) }}</div>

      <div class="db-highlight-box mt-4">
        <div class="db-highlight-title">
          Net Value
          <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
          <span class="db-highlight-pct">{{ (stats?.netValuePct ?? 0).toFixed(2) }} %</span>
        </div>
        <div class="db-highlight-amount">{{ fmtFull(netFlow) }} ETB</div>
      </div>
    </div>

    <!-- Financial Summary card -->
    <div class="db-card">
      <div class="db-card-head">
        <div class="db-card-label">
          <UIcon name="i-heroicons:arrow-trending-up" class="w-4 h-4" />
          Financial Summary
        </div>
      </div>

      <!-- Comparative bars -->
      <div class="db-compare-bars">
        <div class="db-compare-bar-track">
          <div
            class="db-compare-bar db-compare-bar--green"
            :style="{ width: betPct + '%' }"
          />
        </div>
        <div class="db-compare-bar-track">
          <div
            class="db-compare-bar db-compare-bar--red"
            :style="{ width: (100 - betPct) + '%' }"
          />
        </div>
      </div>

      <div class="db-stat-row mt-3">
        <span class="db-dot db-dot--green"></span>
        <span class="db-stat-label">Bet Amount</span>
        <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
      </div>
      <div class="db-stat-value">{{ fmtFull(stats?.totalPrizePools ?? 0) }} ETB</div>

      <div class="db-stat-row mt-3">
        <span class="db-dot db-dot--red"></span>
        <span class="db-stat-label">Win Amount</span>
        <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
      </div>
      <div class="db-stat-value">{{ fmtFull(stats?.totalPrizesSum ?? 0) }} ETB</div>

      <div class="db-highlight-box mt-4">
        <div class="db-highlight-title">
          GGR
          <UIcon name="i-heroicons:information-circle" class="db-info-icon" />
          <span class="db-highlight-pct">{{ ggrPct.toFixed(2) }} %</span>
        </div>
        <div class="db-highlight-amount">{{ fmtFull((stats?.totalPrizePools ?? 0) - (stats?.totalPrizesSum ?? 0)) }} ETB</div>
      </div>
    </div>

    <!-- House & Games card -->
    <div class="db-card">
      <div class="db-card-head">
        <div class="db-card-label">
          <UIcon name="i-heroicons:building-library" class="w-4 h-4" />
          House & Games
        </div>
      </div>

      <div class="db-grid-2">
        <div>
          <div class="db-stat-label">House Balance</div>
          <div class="db-stat-value" :class="(stats?.houseBalance ?? 0) < 0 ? 'db-stat-value--red' : 'db-stat-value--brand'">
            {{ fmtFull(stats?.houseBalance ?? 0) }} ETB
          </div>
        </div>
        <div>
          <div class="db-stat-label">Total Profit</div>
          <div class="db-stat-value db-stat-value--brand">{{ fmtFull(stats?.totalProfit ?? 0) }} ETB</div>
        </div>
        <div>
          <div class="db-stat-label">Games Completed</div>
          <div class="db-stat-value">{{ fmtInt(stats?.gamesCompleted ?? 0) }}</div>
        </div>
        <div>
          <div class="db-stat-label">Games Cancelled</div>
          <div class="db-stat-value db-stat-value--red">{{ fmtInt(stats?.gamesCancelled ?? 0) }}</div>
        </div>
      </div>
    </div>

    <!-- Provider Performance card -->
    <div v-if="stats?.providerStats?.length" class="db-card">
      <div class="db-card-head">
        <div class="db-card-label">
          <UIcon name="i-heroicons:server-stack" class="w-4 h-4" />
          Provider Performance
        </div>
      </div>
      <div v-for="p in stats.providerStats" :key="p.name" class="db-provider-row">
        <span class="db-provider-name">{{ p.name }}</span>
        <div class="db-provider-nums">
          <span class="db-provider-num db-provider-num--green">+{{ fmtFull(p.gained) }}</span>
          <span class="db-provider-num db-provider-num--red">-{{ fmtFull(p.lost) }}</span>
          <span class="db-provider-num" :class="p.net >= 0 ? 'db-provider-num--green' : 'db-provider-num--red'">
            {{ p.net >= 0 ? '+' : '' }}{{ fmtFull(p.net) }}
          </span>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 80px;
}

/* Header */
.db-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.db-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}
.db-refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.12s;
}
.db-refresh:hover { background: var(--surface-overlay); }
.db-refresh:disabled { opacity: 0.4; cursor: default; }

/* Card */
.db-card {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 16px;
  padding: 18px 16px;
}

.db-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.db-card-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}
.db-see-link {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #60a5fa;
  text-decoration: none;
}
.db-see-link:hover { text-decoration: underline; }

/* Stacked bar */
.db-bar-track {
  display: flex;
  height: 36px;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 16px;
  gap: 2px;
}
.db-bar-seg {
  height: 100%;
  transition: width 0.4s ease;
}
.db-bar-seg--blue  { background: #3b82f6; }
.db-bar-seg--green { background: #22c55e; }

/* Stat rows */
.db-stat-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}
.db-dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex-shrink: 0;
}
.db-dot--blue   { background: #3b82f6; }
.db-dot--green  { background: #22c55e; }
.db-dot--red    { background: #ef4444; }
.db-dot--orange { background: #f97316; }
.db-stat-label {
  font-size: 13px;
  color: var(--text-secondary);
  flex: 1;
}
.db-info-icon {
  width: 14px;
  height: 14px;
  color: var(--text-muted);
  opacity: 0.5;
  flex-shrink: 0;
}
.db-stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
  line-height: 1.2;
  margin-bottom: 2px;
}
.db-stat-value--brand { color: var(--brand-primary); }
.db-stat-value--red   { color: #ef4444; }

/* Highlight box */
.db-highlight-box {
  background: rgba(0,0,0,0.3);
  border-radius: 10px;
  padding: 12px 14px;
}
.db-highlight-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.db-highlight-pct {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
}
.db-highlight-amount {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

/* Ring chart */
.db-ring-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 4px;
}
.db-ring-wrap {
  width: 100px;
  height: 100px;
  flex-shrink: 0;
}
.db-ring-svg {
  width: 100%;
  height: 100%;
}
.db-avg-col {
  flex: 1;
}
.db-avg-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 1px;
}
.db-avg-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

/* Compare bars */
.db-compare-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 4px;
}
.db-compare-bar-track {
  height: 20px;
  background: rgba(255,255,255,0.05);
  border-radius: 4px;
  overflow: hidden;
}
.db-compare-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease;
}
.db-compare-bar--green { background: #22c55e; }
.db-compare-bar--red   { background: #ef4444; }

/* Grid 2 col */
.db-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

/* Provider rows */
.db-provider-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-top: 1px solid var(--surface-border);
  gap: 8px;
}
.db-provider-name {
  font-size: 13px;
  color: var(--text-secondary);
  flex: 1;
}
.db-provider-nums {
  display: flex;
  gap: 12px;
}
.db-provider-num {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}
.db-provider-num--green { color: #22c55e; }
.db-provider-num--red   { color: #ef4444; }

.mt-3 { margin-top: 12px; }
.mt-4 { margin-top: 16px; }
</style>
