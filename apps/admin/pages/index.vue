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

// ── Date filter ───────────────────────────────────────────────────────────────
type Preset = 'today' | 'yesterday' | 'week' | 'lastWeek' | 'month' | 'lastMonth' | 'custom'

const presetOptions: { label: string; value: Preset }[] = [
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: 'This Week', value: 'week' },
  { label: 'Last Week', value: 'lastWeek' },
  { label: 'This Month', value: 'month' },
  { label: 'Last Month', value: 'lastMonth' },
]

// Applied (active) state
const preset = ref<Preset>('month')
const customFrom = ref('')
const customTo = ref('')

// Pending (inside modal before Apply)
const pendingPreset = ref<Preset>('month')
const pendingCustomFrom = ref('')
const pendingCustomTo = ref('')
const pendingCustomEnabled = ref(false)

const filterOpen = ref(false)

function openFilter() {
  pendingPreset.value = preset.value
  pendingCustomFrom.value = customFrom.value
  pendingCustomTo.value = customTo.value
  pendingCustomEnabled.value = preset.value === 'custom'
  filterOpen.value = true
}

function applyFilter() {
  preset.value = pendingCustomEnabled.value ? 'custom' : pendingPreset.value
  customFrom.value = pendingCustomFrom.value
  customTo.value = pendingCustomTo.value
  filterOpen.value = false
  nextTick(() => refresh())
}

function getDateRange(): { from: string; to: string } {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const today = fmt(now)

  if (preset.value === 'today') return { from: today, to: today }
  if (preset.value === 'yesterday') {
    const y = new Date(now); y.setDate(now.getDate() - 1)
    return { from: fmt(y), to: fmt(y) }
  }
  if (preset.value === 'week') {
    const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7))
    return { from: fmt(mon), to: today }
  }
  if (preset.value === 'lastWeek') {
    const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) - 7)
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    return { from: fmt(mon), to: fmt(sun) }
  }
  if (preset.value === 'month') {
    return { from: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, to: today }
  }
  if (preset.value === 'lastMonth') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const last = new Date(now.getFullYear(), now.getMonth(), 0)
    return { from: fmt(first), to: fmt(last) }
  }
  return { from: customFrom.value, to: customTo.value }
}

const activeLabel = computed(() => {
  if (preset.value === 'custom') {
    const fmtD = (s: string) => {
      const d = new Date(s)
      return `${String(d.getDate()).padStart(2,'0')}/${d.toLocaleString('en',{month:'short'})}`
    }
    if (customFrom.value && customTo.value) return `${fmtD(customFrom.value)}–${fmtD(customTo.value)}`
    return 'Custom'
  }
  return presetOptions.find(o => o.value === preset.value)?.label ?? 'Today'
})

const dateLabel = computed(() => {
  const { from, to } = getDateRange()
  if (!from) return '—'
  const fmtDisplay = (s: string) => {
    const d = new Date(s); return `${String(d.getDate()).padStart(2,'0')}/${d.toLocaleString('en',{month:'short'})}`
  }
  return from === to ? fmtDisplay(from) : `${fmtDisplay(from)}–${fmtDisplay(to)}`
})

// ── Real-time polling ─────────────────────────────────────────────────────────
let pollTimer: ReturnType<typeof setInterval> | null = null
const manualLoading = ref(false)
const lastUpdated = ref<Date | null>(null)
const fetchError = ref<string | null>(null)

const lastUpdatedLabel = computed(() => {
  if (!lastUpdated.value) return ''
  const diff = Math.round((Date.now() - lastUpdated.value.getTime()) / 1000)
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  return `${Math.round(diff / 60)}m ago`
})

// Background silent refresh (polling)
const silentRefresh = async () => {
  try {
    const { from, to } = getDateRange()
    const toEndOfDay = to ? `${to}T23:59:59.999Z` : undefined
    const fromStartOfDay = from ? `${from}T00:00:00.000Z` : undefined
    stats.value = await getStats({ from: fromStartOfDay, to: toEndOfDay }) as any
    lastUpdated.value = new Date()
    fetchError.value = null
  } catch (e: any) {
    console.error('Failed to fetch stats', e)
    fetchError.value = e?.data?.error ?? e?.message ?? 'Failed to load stats'
  }
}

// Manual refresh (shows spinner on button)
const refresh = async () => {
  manualLoading.value = true
  loading.value = true
  await silentRefresh()
  loading.value = false
  manualLoading.value = false
}

onMounted(() => {
  refresh()
  pollTimer = setInterval(silentRefresh, 30_000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

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
      <div>
        <h1 class="db-title">Dashboard</h1>
        <span v-if="lastUpdated" class="db-live-label">
          <span class="db-live-dot" />
          Live · {{ lastUpdatedLabel }}
        </span>
      </div>
      <button class="db-refresh" :class="{ 'db-refresh--spinning': manualLoading }" @click="refresh">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" :class="{ 'spin-anim': manualLoading }">
          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
        </svg>
      </button>
    </div>

    <!-- Filter trigger row -->
    <div class="db-filter-trigger-row">
      <button class="db-filter-btn" @click="openFilter">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        {{ activeLabel }}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:2px">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="db-date-range-pill">{{ dateLabel }}</div>
    </div>

    <!-- Interval bottom-sheet modal -->
    <ClientOnly><Teleport to="body">
      <Transition name="sheet-backdrop">
        <div v-if="filterOpen" class="sheet-backdrop" @click.self="filterOpen = false" />
      </Transition>
      <Transition name="sheet">
        <div v-if="filterOpen" class="interval-sheet">
          <div class="sheet-header">
            <span class="sheet-title">Interval</span>
            <button class="sheet-close" @click="filterOpen = false">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="sheet-options">
            <label
              v-for="opt in presetOptions"
              :key="opt.value"
              class="sheet-option"
              :class="{ 'sheet-option--active': !pendingCustomEnabled && pendingPreset === opt.value }"
              @click="pendingPreset = opt.value; pendingCustomEnabled = false; applyFilter()"
            >
              <span class="sheet-option-label">{{ opt.label }}</span>
              <span class="sheet-radio" :class="{ 'sheet-radio--checked': !pendingCustomEnabled && pendingPreset === opt.value }" />
            </label>
          </div>

          <div class="sheet-divider" />

          <div class="sheet-custom-row">
            <span class="sheet-option-label">Custom Date</span>
            <button
              class="sheet-toggle"
              :class="{ 'sheet-toggle--on': pendingCustomEnabled }"
              @click="pendingCustomEnabled = !pendingCustomEnabled"
            >
              <span class="sheet-toggle-knob" />
            </button>
          </div>

          <div v-if="pendingCustomEnabled" class="sheet-date-inputs">
            <input v-model="pendingCustomFrom" type="date" class="sheet-date-input" placeholder="From" />
            <span class="sheet-date-sep">–</span>
            <input v-model="pendingCustomTo" type="date" class="sheet-date-input" placeholder="To" />
          </div>

          <button class="sheet-apply" @click="applyFilter">Apply</button>
        </div>
      </Transition>
    </Teleport></ClientOnly>

    <!-- Error banner -->
    <div v-if="fetchError" class="db-error-banner">
      <UIcon name="i-heroicons:exclamation-triangle" class="w-4 h-4" />
      {{ fetchError }}
      <button class="db-error-retry" @click="refresh">Retry</button>
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
  align-items: flex-start;
  justify-content: space-between;
}
.db-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 2px;
}
.db-live-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary);
  opacity: 0.7;
}
.db-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  animation: live-pulse 2s ease-in-out infinite;
}
@keyframes live-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
.spin-anim {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
.db-refresh--spinning { color: var(--brand-primary); }

/* Filter trigger row */
.db-filter-trigger-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.db-filter-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border-radius: 10px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.12s;
}
.db-filter-btn:hover { background: var(--surface-overlay); }
.db-date-range-pill {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* Bottom sheet */
.sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  z-index: 9998;
}
.interval-sheet {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  background: #1a2235;
  border-radius: 20px 20px 0 0;
  padding: 0 0 env(safe-area-inset-bottom, 16px);
  display: flex;
  flex-direction: column;
}
.sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 14px;
}
.sheet-title {
  font-size: 17px;
  font-weight: 700;
  color: #fff;
}
.sheet-close {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(255,255,255,0.1);
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
}
.sheet-close:hover { background: rgba(255,255,255,0.18); }
.sheet-options {
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgba(255,255,255,0.08);
}
.sheet-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  transition: background 0.1s;
}
.sheet-option:hover, .sheet-option--active { background: rgba(255,255,255,0.04); }
.sheet-option-label {
  font-size: 16px;
  font-weight: 500;
  color: rgba(255,255,255,0.9);
}
.sheet-radio {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s;
  flex-shrink: 0;
}
.sheet-radio--checked {
  border-color: #3b82f6;
  background: #3b82f6;
  box-shadow: inset 0 0 0 4px #1a2235;
}
.sheet-divider {
  height: 1px;
  background: rgba(255,255,255,0.08);
  margin: 4px 0;
}
.sheet-custom-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
}
.sheet-toggle {
  width: 50px;
  height: 28px;
  border-radius: 14px;
  border: none;
  background: rgba(255,255,255,0.2);
  cursor: pointer;
  position: relative;
  transition: background 0.2s;
  padding: 0;
  flex-shrink: 0;
}
.sheet-toggle--on { background: #3b82f6; }
.sheet-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
  display: block;
}
.sheet-toggle--on .sheet-toggle-knob { transform: translateX(22px); }
.sheet-date-inputs {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 20px 12px;
}
.sheet-date-input {
  flex: 1;
  height: 38px;
  border-radius: 10px;
  background: rgba(255,255,255,0.07);
  border: 1px solid rgba(255,255,255,0.12);
  color: #fff;
  font-size: 13px;
  font-family: inherit;
  padding: 0 12px;
}
.sheet-date-input:focus { outline: 2px solid #3b82f6; outline-offset: 2px; }
.sheet-date-sep { color: rgba(255,255,255,0.4); font-size: 14px; }
.sheet-apply {
  margin: 12px 16px 16px;
  height: 52px;
  border-radius: 14px;
  background: rgba(255,255,255,0.12);
  border: none;
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}
.sheet-apply:hover { background: rgba(255,255,255,0.18); }

/* Sheet transitions */
.sheet-backdrop-enter-active, .sheet-backdrop-leave-active { transition: opacity 0.25s; }
.sheet-backdrop-enter-from, .sheet-backdrop-leave-to { opacity: 0; }
.sheet-enter-active, .sheet-leave-active { transition: transform 0.3s cubic-bezier(0.32,0.72,0,1); }
.sheet-enter-from, .sheet-leave-to { transform: translateY(100%); }

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

/* Error banner */
.db-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #fca5a5;
  font-size: 13px;
}
.db-error-retry {
  margin-left: auto;
  padding: 4px 12px;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.db-error-retry:hover { background: rgba(239, 68, 68, 0.3); }
</style>
