<script setup lang="ts">
const { getStats } = useAdminApi()

const loading = ref(false)
const stats = ref<{
  approvedDepositSum: number
  approvedWithdrawalSum: number
  totalPrizesSum: number
  gamesCompleted: number
  gamesCancelled: number
  totalPrizePools: number
  activePlayers: number
  houseBalance: number
  houseCommissionEarned: number
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

const fmt = (n: number) =>
  n.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtInt = (n: number) => n.toLocaleString('en-ET')

const netFlow = computed(() =>
  (stats.value?.approvedDepositSum ?? 0) - (stats.value?.approvedWithdrawalSum ?? 0)
)

const houseIsDeficit = computed(() => (stats.value?.houseBalance ?? 0) < 0)
</script>

<template>
  <div class="dashboard">

    <!-- ── Page header ──────────────────────────────────────────────── -->
    <div class="page-header">
      <div>
        <h1 class="page-title">Dashboard</h1>
        <p class="page-sub">Platform overview — financial and operational summary</p>
      </div>
      <button class="refresh-btn" :disabled="loading" @click="refresh">
        <UIcon name="i-heroicons:arrow-path" class="w-4 h-4" :class="{ 'animate-spin': loading }" />
        Refresh
      </button>
    </div>

    <!-- ── KPI strip ────────────────────────────────────────────────── -->
    <div class="kpi-strip">
      <div class="kpi-item">
        <span class="kpi-value kpi-value--positive">{{ fmt(stats?.approvedDepositSum ?? 0) }}</span>
        <span class="kpi-label">Deposits Approved <span class="kpi-unit">ETB</span></span>
      </div>
      <div class="kpi-divider"></div>

      <div class="kpi-item">
        <span class="kpi-value kpi-value--negative">{{ fmt(stats?.approvedWithdrawalSum ?? 0) }}</span>
        <span class="kpi-label">Withdrawals Approved <span class="kpi-unit">ETB</span></span>
      </div>
      <div class="kpi-divider"></div>

      <div class="kpi-item">
        <span class="kpi-value" :class="netFlow >= 0 ? 'kpi-value--positive' : 'kpi-value--negative'">
          {{ fmt(netFlow) }}
        </span>
        <span class="kpi-label">Net Flow <span class="kpi-unit">ETB</span></span>
      </div>
      <div class="kpi-divider"></div>

      <div class="kpi-item">
        <span class="kpi-value" :class="houseIsDeficit ? 'kpi-value--negative' : 'kpi-value--brand'">
          {{ fmt(stats?.houseBalance ?? 0) }}
        </span>
        <span class="kpi-label">
          House Balance <span class="kpi-unit">ETB</span>
          <span v-if="houseIsDeficit" class="status-tag status-tag--negative kpi-badge">Deficit</span>
        </span>
      </div>
      <div class="kpi-divider"></div>

      <div class="kpi-item">
        <span class="kpi-value">{{ fmtInt(stats?.activePlayers ?? 0) }}</span>
        <span class="kpi-label">Active Players</span>
      </div>
    </div>

    <!-- ── Main content grid ─────────────────────────────────────────── -->
    <div class="content-grid">

      <!-- Left column: Financial breakdown ─────────────────────────── -->
      <div class="col-main">

        <!-- Financial summary table -->
        <div class="admin-card section-card">
          <div class="card-header">
            <h2 class="card-title">Financial Summary</h2>
          </div>
          <table class="admin-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th class="num">Amount (ETB)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Total Deposits Approved</td>
                <td class="num" style="color: var(--positive)">{{ fmt(stats?.approvedDepositSum ?? 0) }}</td>
                <td><span class="status-tag status-tag--positive">Inflow</span></td>
              </tr>
              <tr>
                <td>Total Withdrawals Approved</td>
                <td class="num" style="color: var(--negative)">{{ fmt(stats?.approvedWithdrawalSum ?? 0) }}</td>
                <td><span class="status-tag status-tag--negative">Outflow</span></td>
              </tr>
              <tr class="row-highlight">
                <td><strong>Net Flow</strong></td>
                <td class="num">
                  <strong :class="netFlow >= 0 ? 'text-positive' : 'text-negative'">{{ fmt(netFlow) }}</strong>
                </td>
                <td>
                  <span class="status-tag" :class="netFlow >= 0 ? 'status-tag--positive' : 'status-tag--negative'">
                    {{ netFlow >= 0 ? 'Surplus' : 'Deficit' }}
                  </span>
                </td>
              </tr>
              <tr>
                <td>Total Prizes Paid Out</td>
                <td class="num" style="color: var(--negative)">{{ fmt(stats?.totalPrizesSum ?? 0) }}</td>
                <td><span class="status-tag status-tag--negative">Outflow</span></td>
              </tr>
              <tr>
                <td>Total Prize Pools Generated</td>
                <td class="num" style="color: var(--brand-primary)">{{ fmt(stats?.totalPrizePools ?? 0) }}</td>
                <td><span class="status-tag status-tag--warning">Pools</span></td>
              </tr>
              <tr>
                <td>House Commission Earned</td>
                <td class="num" style="color: var(--positive)">{{ fmt(stats?.houseCommissionEarned ?? 0) }}</td>
                <td><span class="status-tag status-tag--positive">Revenue</span></td>
              </tr>
              <tr :class="houseIsDeficit ? 'row-alert' : ''">
                <td>House Wallet Balance</td>
                <td class="num" :class="houseIsDeficit ? 'text-negative' : ''" style="font-weight:700">
                  {{ fmt(stats?.houseBalance ?? 0) }}
                </td>
                <td>
                  <span class="status-tag" :class="houseIsDeficit ? 'status-tag--negative' : 'status-tag--positive'">
                    {{ houseIsDeficit ? 'Deficit' : 'Healthy' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Game performance table -->
        <div class="admin-card section-card">
          <div class="card-header">
            <h2 class="card-title">Game Performance</h2>
          </div>
          <table class="admin-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th class="num">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Games Completed</td>
                <td class="num">{{ fmtInt(stats?.gamesCompleted ?? 0) }}</td>
              </tr>
              <tr>
                <td>Games Cancelled</td>
                <td class="num" style="color: var(--negative)">{{ fmtInt(stats?.gamesCancelled ?? 0) }}</td>
              </tr>
              <tr>
                <td>Active Players</td>
                <td class="num">{{ fmtInt(stats?.activePlayers ?? 0) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

      </div>

      <!-- Right column: Provider stats ────────────────────────────── -->
      <div class="col-side">
        <div class="admin-card section-card" style="height: fit-content;">
          <div class="card-header">
            <h2 class="card-title">Provider Performance</h2>
            <span class="card-meta">House perspective</span>
          </div>

          <div v-if="!stats?.providerStats?.length" class="empty-state">
            No provider data available.
          </div>

          <table v-else class="admin-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th class="num">Gained</th>
                <th class="num">Lost</th>
                <th class="num">Net</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in stats.providerStats" :key="p.name">
                <td class="muted">{{ p.name }}</td>
                <td class="num" style="color: var(--positive)">+{{ fmt(p.gained) }}</td>
                <td class="num" style="color: var(--negative)">-{{ fmt(p.lost) }}</td>
                <td class="num" :style="{ color: p.net >= 0 ? 'var(--positive)' : 'var(--negative)' }">
                  {{ p.net >= 0 ? '+' : '' }}{{ fmt(p.net) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* ── Page header ─────────────────────────────────────────────────────── */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
  margin: 0;
  line-height: 1.2;
}

.page-sub {
  font-size: 13px;
  color: var(--text-muted);
  margin: 4px 0 0;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  transition: background 0.12s ease, color 0.12s ease;
  flex-shrink: 0;
}
.refresh-btn:hover { background: var(--surface-overlay); color: var(--text-primary); }
.refresh-btn:disabled { opacity: 0.5; cursor: default; }
.refresh-btn:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }

/* ── KPI strip ───────────────────────────────────────────────────────── */
.kpi-strip {
  display: flex;
  align-items: stretch;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.kpi-strip::-webkit-scrollbar { display: none; }

.kpi-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 18px 24px;
  flex: 1;
  min-width: 160px;
}

.kpi-value {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.kpi-value--positive { color: var(--positive); }
.kpi-value--negative { color: var(--negative); }
.kpi-value--brand    { color: var(--brand-primary); }

.kpi-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.kpi-unit {
  font-weight: 600;
  color: var(--text-muted);
}

.kpi-badge {
  font-size: 9px !important;
}

.kpi-divider {
  width: 1px;
  background: var(--surface-border);
  flex-shrink: 0;
  margin: 14px 0;
}

/* ── Content grid ────────────────────────────────────────────────────── */
.content-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

@media (min-width: 1024px) {
  .content-grid {
    grid-template-columns: 1fr 360px;
  }
}

.col-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.col-side {
  min-width: 0;
}

/* ── Section card ────────────────────────────────────────────────────── */
.section-card {
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 0;
  margin-bottom: 12px;
}

.card-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.01em;
  margin: 0;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
}

.card-meta {
  font-size: 11px;
  color: var(--text-muted);
}

/* ── Table helpers ───────────────────────────────────────────────────── */
.text-positive { color: var(--positive); }
.text-negative { color: var(--negative); }

.row-highlight { background: rgba(255,255,255,0.02); }
.row-alert { background: rgba(248,113,113,0.04); }

.empty-state {
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
