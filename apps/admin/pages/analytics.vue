<script setup lang="ts">
import { Line, Bar } from 'vue-chartjs'
import {
  Chart, CategoryScale, LinearScale, PointElement, LineElement, BarElement,
  Tooltip, Legend, Filler,
} from 'chart.js'

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler)

const api = useAdminApi()

const rangeDays = ref(30)
const rangeOptions = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
]

const loading = ref(true)
const error = ref<string | null>(null)
const funnel = ref<Awaited<ReturnType<typeof api.getAnalyticsFunnel>> | null>(null)
const retention = ref<Awaited<ReturnType<typeof api.getAnalyticsRetention>> | null>(null)
const gamesHealth = ref<Awaited<ReturnType<typeof api.getAnalyticsGamesHealth>> | null>(null)
const engagement = ref<Awaited<ReturnType<typeof api.getAnalyticsEngagement>> | null>(null)
const browseFunnel = ref<Awaited<ReturnType<typeof api.getAnalyticsBrowseFunnel>> | null>(null)
const depositFunnel = ref<Awaited<ReturnType<typeof api.getAnalyticsDepositFunnel>> | null>(null)
const conversionKpis = ref<Awaited<ReturnType<typeof api.getAnalyticsConversionKpis>> | null>(null)
const gameRetention = ref<Awaited<ReturnType<typeof api.getGameRetentionScorecard>> | null>(null)
const providerFunnel = ref<Awaited<ReturnType<typeof api.getProviderBrowseFunnel>> | null>(null)
const gamePnl = ref<Awaited<ReturnType<typeof api.getAnalyticsGamePnl>> | null>(null)
const pnlSortKey = ref<'netPnl' | 'shortfall' | 'grossRevenue' | 'totalPrizes' | 'playerCount'>('netPnl')
const pnlSortDir = ref<'asc' | 'desc'>('asc')
const retentionSortKey = ref<'lift' | 'firstGameCohort' | 'returnRate7d' | 'replayRate'>('lift')
const retentionSortDir = ref<'asc' | 'desc'>('desc')

async function load() {
  loading.value = true
  error.value = null
  const from = new Date(Date.now() - rangeDays.value * 24 * 3600 * 1000).toISOString()
  try {
    const [f, r, g, e, bf, df, ck, gr, pf, gp] = await Promise.all([
      api.getAnalyticsFunnel({ from }),
      api.getAnalyticsRetention(8),
      api.getAnalyticsGamesHealth({ from }),
      api.getAnalyticsEngagement(),
      api.getAnalyticsBrowseFunnel({ from }),
      api.getAnalyticsDepositFunnel({ from }),
      api.getAnalyticsConversionKpis({ from }),
      api.getGameRetentionScorecard({ from }),
      api.getProviderBrowseFunnel({ from }),
      api.getAnalyticsGamePnl({ from }),
    ])
    funnel.value = f
    retention.value = r
    gamesHealth.value = g
    engagement.value = e
    browseFunnel.value = bf
    depositFunnel.value = df
    conversionKpis.value = ck
    gameRetention.value = gr
    providerFunnel.value = pf
    gamePnl.value = gp
  } catch (err: any) {
    error.value = err?.data?.error ?? err?.message ?? 'Failed to load analytics'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(rangeDays, load)

const funnelStages = computed(() => {
  if (!funnel.value) return []
  const f = funnel.value
  const max = Math.max(f.signups, 1)
  return [
    { label: 'Signed up', count: f.signups, pct: 100, width: 100 },
    { label: 'Deposited', count: f.depositors, pct: f.rates.signupToDeposit, width: (f.depositors / max) * 100 },
    { label: 'Played a game', count: f.players, pct: f.rates.depositToPlay, width: (f.players / max) * 100 },
    { label: 'Played again', count: f.repeatPlayers, pct: f.rates.playToRepeat, width: (f.repeatPlayers / max) * 100 },
  ]
})

const gamesChartData = computed(() => ({
  labels: gamesHealth.value?.daily.map(d => d.day) ?? [],
  datasets: [
    {
      label: 'Completed',
      data: gamesHealth.value?.daily.map(d => d.completed) ?? [],
      borderColor: '#34d399',
      backgroundColor: 'rgba(52, 211, 153, 0.12)',
      fill: true,
      tension: 0.3,
    },
    {
      label: 'Cancelled',
      data: gamesHealth.value?.daily.map(d => d.cancelled) ?? [],
      borderColor: '#f87171',
      backgroundColor: 'rgba(248, 113, 113, 0.12)',
      fill: true,
      tension: 0.3,
    },
  ],
}))

const distributionChartData = computed(() => ({
  labels: Object.keys(engagement.value?.distribution ?? {}),
  datasets: [{
    label: 'Players',
    data: Object.values(engagement.value?.distribution ?? {}),
    backgroundColor: 'rgba(245, 158, 11, 0.6)',
    borderColor: '#f59e0b',
    borderWidth: 1,
  }],
}))

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: 'rgba(255,255,255,0.7)' } } },
  scales: {
    x: { ticks: { color: 'rgba(255,255,255,0.5)' }, grid: { color: 'rgba(255,255,255,0.06)' } },
    y: { ticks: { color: 'rgba(255,255,255,0.5)' }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true },
  },
}

function retentionCellStyle(pct: number) {
  return { background: `rgba(245, 158, 11, ${Math.min(pct / 100, 1) * 0.75})` }
}

const sortedRetentionRows = computed(() => {
  if (!gameRetention.value) return []
  const rows = [...gameRetention.value.rows]
  const key = retentionSortKey.value
  const dir = retentionSortDir.value === 'desc' ? -1 : 1
  return rows.sort((a, b) => (a[key] - b[key]) * dir)
})

function toggleSort(key: typeof retentionSortKey.value) {
  if (retentionSortKey.value === key) {
    retentionSortDir.value = retentionSortDir.value === 'desc' ? 'asc' : 'desc'
  } else {
    retentionSortKey.value = key
    retentionSortDir.value = 'desc'
  }
}

const sortedGamePnl = computed(() => {
  if (!gamePnl.value) return []
  const rows = [...gamePnl.value]
  const key = pnlSortKey.value
  const dir = pnlSortDir.value === 'asc' ? 1 : -1
  return rows.sort((a, b) => (a[key] - b[key]) * dir)
})

function togglePnlSort(key: typeof pnlSortKey.value) {
  if (pnlSortKey.value === key) {
    pnlSortDir.value = pnlSortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    pnlSortKey.value = key
    pnlSortDir.value = 'asc'
  }
}

function exportGamePnlCsv() {
  if (!gamePnl.value?.length) return
  const headers = ['Game', 'Ended At', 'Players', 'Ticket Price (ETB)', 'House Edge %', 'Gross Revenue (ETB)', 'Prizes Paid (ETB)', 'Net P&L (ETB)', 'Expected House (ETB)', 'Shortfall (ETB)']
  const rows = sortedGamePnl.value.map(r => [
    `"${r.title.replace(/"/g, '""')}"`,
    r.endedAt ? new Date(r.endedAt).toISOString().slice(0, 19).replace('T', ' ') : '',
    r.playerCount,
    r.ticketPrice.toFixed(2),
    r.houseEdgePct.toFixed(1),
    r.grossRevenue.toFixed(2),
    r.totalPrizes.toFixed(2),
    r.netPnl.toFixed(2),
    r.expectedHouse.toFixed(2),
    r.shortfall.toFixed(2),
  ])
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `game-pnl-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="analytics-page">
    <div class="page-head">
      <div>
        <h1 class="page-title">Analytics</h1>
        <p class="page-sub">Conversion funnel, retention and game health — bots excluded</p>
      </div>
      <USelectMenu v-model="rangeDays" :options="rangeOptions" value-attribute="value" option-attribute="label" class="w-32" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-else-if="loading" class="loading-state">Loading analytics…</div>

    <template v-else>
      <!-- ── Funnel ──────────────────────────────────────────────── -->
      <section class="card">
        <h2 class="card-title">Conversion funnel <span class="card-hint">signups in last {{ rangeDays }} days</span></h2>
        <div class="funnel">
          <div v-for="stage in funnelStages" :key="stage.label" class="funnel-row">
            <span class="funnel-label">{{ stage.label }}</span>
            <div class="funnel-track">
              <div class="funnel-bar" :style="{ width: stage.width + '%' }" />
            </div>
            <span class="funnel-count">{{ stage.count }}</span>
            <span class="funnel-pct">{{ stage.pct }}%</span>
          </div>
        </div>
      </section>

      <!-- ── KPI cards ───────────────────────────────────────────── -->
      <div class="kpi-grid" v-if="engagement && gamesHealth">
        <div class="card kpi">
          <span class="kpi-value">{{ engagement.oneAndDonePct }}%</span>
          <span class="kpi-label">One-and-done players</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ engagement.active7d }} / {{ engagement.totalPlayers }}</span>
          <span class="kpi-label">Players active last 7 days</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ gamesHealth.fill.avgHumanFillPct }}%</span>
          <span class="kpi-label">Avg human fill (completed games)</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ engagement.idleMoney.wallets }} · {{ engagement.idleMoney.balance.toFixed(0) }} ETB</span>
          <span class="kpi-label">Idle wallets (can afford a ticket, 7d inactive)</span>
        </div>
      </div>

      <!-- ── Win experience ──────────────────────────────────────── -->
      <section class="card" v-if="engagement">
        <h2 class="card-title">Win experience vs retention <span class="card-hint">players with ≥3 games</span></h2>
        <div class="winexp-grid">
          <div class="winexp-cell">
            <span class="winexp-num">{{ engagement.winExperience.winners.active7dPct }}%</span>
            <span class="winexp-label">of {{ engagement.winExperience.winners.total }} winners still active (7d)</span>
          </div>
          <div class="winexp-cell">
            <span class="winexp-num winexp-num--bad">{{ engagement.winExperience.neverWon.active7dPct }}%</span>
            <span class="winexp-label">of {{ engagement.winExperience.neverWon.total }} never-won players still active (7d)</span>
          </div>
        </div>
      </section>

      <!-- ── Games health chart ──────────────────────────────────── -->
      <section class="card">
        <h2 class="card-title">Game supply &amp; cancellations <span class="card-hint">bot share of entries: {{ gamesHealth?.fill.botSharePct }}%</span></h2>
        <div class="chart-box">
          <Line :data="gamesChartData" :options="chartOptions" />
        </div>
      </section>

      <!-- ── Engagement distribution ─────────────────────────────── -->
      <section class="card">
        <h2 class="card-title">Games played per player <span class="card-hint">all time</span></h2>
        <div class="chart-box">
          <Bar :data="distributionChartData" :options="chartOptions" />
        </div>
      </section>

      <!-- ── Conversion KPIs (Layer 2) ─────────────────────────── -->
      <div class="kpi-grid" v-if="conversionKpis">
        <div class="card kpi">
          <span class="kpi-value">{{ conversionKpis.totalVisitors.toLocaleString() }}</span>
          <span class="kpi-label">Visitors ({{ conversionKpis.anonVisitors.toLocaleString() }} anon)</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ conversionKpis.visitorToRegPct }}%</span>
          <span class="kpi-label">Visitor → Registration</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ conversionKpis.regToDepositPct }}%</span>
          <span class="kpi-label">Registration → 1st deposit</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ conversionKpis.browseToJoinPct }}%</span>
          <span class="kpi-label">Browse → Join click</span>
        </div>
      </div>

      <!-- ── Browse funnel (Layer 2) ────────────────────────────── -->
      <section class="card" v-if="browseFunnel">
        <h2 class="card-title">Visitor conversion funnel <span class="card-hint">incl. anonymous visitors</span></h2>
        <div class="funnel">
          <div v-for="stage in browseFunnel.stages" :key="stage.name" class="funnel-row">
            <span class="funnel-label">{{ { visited: 'Visited lobby', viewed_game: 'Viewed a game', join_click: 'Tapped join', registered: 'Registered', deposited: 'Deposited', played: 'Played a game' }[stage.name] ?? stage.name }}</span>
            <div class="funnel-track">
              <div
                class="funnel-bar"
                :style="{ width: (browseFunnel.stages[0]?.count ? (stage.count / browseFunnel.stages[0].count) * 100 : 0) + '%' }"
              />
            </div>
            <span class="funnel-count">{{ stage.count.toLocaleString() }}</span>
            <span class="funnel-pct" :class="stage.dropOffPct > 50 ? 'funnel-pct--warn' : ''">
              {{ stage.dropOffPct > 0 ? `-${stage.dropOffPct}%` : '—' }}
            </span>
          </div>
        </div>
      </section>

      <!-- ── Deposit funnel (Layer 2) ───────────────────────────── -->
      <section class="card" v-if="depositFunnel">
        <h2 class="card-title">Deposit funnel</h2>
        <div class="funnel">
          <div v-for="stage in depositFunnel.stages" :key="stage.name" class="funnel-row">
            <span class="funnel-label">{{ { modal_opened: 'Opened modal', method_selected: 'Selected method', amount_entered: 'Entered amount', submitted: 'Submitted', approved: 'Approved' }[stage.name] ?? stage.name }}</span>
            <div class="funnel-track">
              <div
                class="funnel-bar funnel-bar--blue"
                :style="{ width: (depositFunnel.stages[0]?.count ? (stage.count / depositFunnel.stages[0].count) * 100 : 0) + '%' }"
              />
            </div>
            <span class="funnel-count">{{ stage.count.toLocaleString() }}</span>
            <span class="funnel-pct" :class="stage.dropOffPct > 30 ? 'funnel-pct--warn' : ''">
              {{ stage.dropOffPct > 0 ? `-${stage.dropOffPct}%` : '—' }}
            </span>
          </div>
        </div>
        <div v-if="depositFunnel.byMethod.length" class="method-breakdown">
          <div class="method-breakdown-title">By payment method</div>
          <div v-for="m in depositFunnel.byMethod" :key="m.method" class="method-row">
            <span class="method-name">{{ m.method }}</span>
            <span class="method-conv">{{ m.conversionPct }}%</span>
            <span class="method-detail">{{ m.approved }}/{{ m.submitted }} approved</span>
          </div>
        </div>
      </section>

      <!-- ── Game Retention Scorecard ────────────────────────────── -->
      <section class="card" v-if="gameRetention">
        <h2 class="card-title">
          Which games retain new players?
          <span class="card-hint">
            baseline 7-day return: {{ gameRetention.baselineReturn7dPct }}%
          </span>
        </h2>
        <div class="retention-scroll">
          <table class="scorecard-table">
            <thead>
              <tr>
                <th class="sc-name">Game</th>
                <th class="sc-type">Type</th>
                <th class="sc-num" @click="toggleSort('firstGameCohort')" style="cursor:pointer">
                  Cohort <span v-if="retentionSortKey === 'firstGameCohort'">{{ retentionSortDir === 'desc' ? '↓' : '↑' }}</span>
                </th>
                <th class="sc-num" @click="toggleSort('returnRate7d')" style="cursor:pointer">
                  Return 7d <span v-if="retentionSortKey === 'returnRate7d'">{{ retentionSortDir === 'desc' ? '↓' : '↑' }}</span>
                </th>
                <th class="sc-num" @click="toggleSort('lift')" style="cursor:pointer">
                  Lift <span v-if="retentionSortKey === 'lift'">{{ retentionSortDir === 'desc' ? '↓' : '↑' }}</span>
                </th>
                <th class="sc-num">Next-day</th>
                <th class="sc-num" @click="toggleSort('replayRate')" style="cursor:pointer">
                  Replay <span v-if="retentionSortKey === 'replayRate'">{{ retentionSortDir === 'desc' ? '↓' : '↑' }}</span>
                </th>
                <th class="sc-num">Plays/player</th>
                <th class="sc-num">Avg P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in sortedRetentionRows"
                :key="row.gameKey"
                :class="{
                  'sc-row--retaining': row.lift > 5,
                  'sc-row--churn': row.lift < -5,
                }"
              >
                <td class="sc-name">
                  {{ row.gameLabel }}
                  <span v-if="row.lowSample" class="sc-low-sample" title="Small cohort — treat with caution">⚠</span>
                </td>
                <td class="sc-type">
                  <span class="sc-badge" :class="row.gameType === 'bingo' ? 'sc-badge--bingo' : 'sc-badge--provider'">
                    {{ row.gameType === 'bingo' ? 'Bingo' : 'Slot' }}
                  </span>
                </td>
                <td class="sc-num">{{ row.firstGameCohort.toLocaleString() }}</td>
                <td class="sc-num">{{ row.returnRate7d }}%</td>
                <td class="sc-num sc-lift" :class="row.lift > 0 ? 'sc-lift--up' : row.lift < 0 ? 'sc-lift--down' : ''">
                  {{ row.lift > 0 ? '+' : '' }}{{ row.lift }}%
                </td>
                <td class="sc-num">{{ row.nextDayReturn }}%</td>
                <td class="sc-num">{{ row.replayRate }}%</td>
                <td class="sc-num">{{ row.sessionsPerPlayer }}×</td>
                <td class="sc-num" :class="row.avgNetPnl != null && row.avgNetPnl < 0 ? 'sc-pnl--neg' : 'sc-pnl--pos'">
                  {{ row.avgNetPnl != null ? (row.avgNetPnl >= 0 ? '+' : '') + row.avgNetPnl.toFixed(2) : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Provider browse funnel sub-section (only when Tier 2 data exists) -->
        <template v-if="providerFunnel">
          <div v-if="!providerFunnel.hasEnoughData" class="sc-no-data">
            Provider browse funnel — not enough data yet (need ≥ 50 provider game views in the window)
          </div>
          <template v-else>
            <h3 class="sc-subtitle">Provider browse funnel</h3>
            <div class="funnel">
              <div v-for="stage in providerFunnel.stages" :key="stage.name" class="funnel-row">
                <span class="funnel-label">{{ { viewed: 'Viewed game', launched: 'Launched', first_bet: 'Placed first bet', returned_7d: 'Returned 7d' }[stage.name] ?? stage.name }}</span>
                <div class="funnel-track">
                  <div
                    class="funnel-bar funnel-bar--blue"
                    :style="{ width: (providerFunnel.stages[0]?.count ? (stage.count / providerFunnel.stages[0].count) * 100 : 0) + '%' }"
                  />
                </div>
                <span class="funnel-count">{{ stage.count.toLocaleString() }}</span>
                <span class="funnel-pct" :class="stage.dropOffPct > 40 ? 'funnel-pct--warn' : ''">
                  {{ stage.dropOffPct > 0 ? `-${stage.dropOffPct}%` : '—' }}
                </span>
              </div>
            </div>
          </template>
        </template>
      </section>

      <!-- ── Game P&L ─────────────────────────────────────────────── -->
      <section class="card" v-if="gamePnl">
        <div class="pnl-head">
          <div>
            <h2 class="card-title" style="margin-bottom:2px;">Which games are costing us money?</h2>
            <p class="pnl-sub">Top 50 completed games sorted by net P&amp;L — lowest first. Net = entries collected − prizes paid to real players.</p>
          </div>
          <button class="pnl-export-btn" @click="exportGamePnlCsv">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export CSV
          </button>
        </div>
        <div class="retention-scroll">
          <table class="scorecard-table">
            <thead>
              <tr>
                <th class="sc-name">Game</th>
                <th class="sc-num" @click="togglePnlSort('playerCount')" style="cursor:pointer">
                  Players <span v-if="pnlSortKey === 'playerCount'">{{ pnlSortDir === 'asc' ? '↑' : '↓' }}</span>
                </th>
                <th class="sc-num">Ticket</th>
                <th class="sc-num">Edge %</th>
                <th class="sc-num" @click="togglePnlSort('grossRevenue')" style="cursor:pointer">
                  Revenue <span v-if="pnlSortKey === 'grossRevenue'">{{ pnlSortDir === 'asc' ? '↑' : '↓' }}</span>
                </th>
                <th class="sc-num" @click="togglePnlSort('totalPrizes')" style="cursor:pointer">
                  Prizes Paid <span v-if="pnlSortKey === 'totalPrizes'">{{ pnlSortDir === 'asc' ? '↑' : '↓' }}</span>
                </th>
                <th class="sc-num" @click="togglePnlSort('expectedHouse')" style="cursor:pointer">
                  Expected <span v-if="pnlSortKey === 'expectedHouse'">{{ pnlSortDir === 'asc' ? '↑' : '↓' }}</span>
                </th>
                <th class="sc-num" @click="togglePnlSort('netPnl')" style="cursor:pointer">
                  Net P&amp;L <span v-if="pnlSortKey === 'netPnl'">{{ pnlSortDir === 'asc' ? '↑' : '↓' }}</span>
                </th>
                <th class="sc-num" @click="togglePnlSort('shortfall')" style="cursor:pointer">
                  Shortfall <span v-if="pnlSortKey === 'shortfall'">{{ pnlSortDir === 'asc' ? '↑' : '↓' }}</span>
                </th>
                <th class="sc-num">Ended</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!sortedGamePnl.length">
                <td colspan="10" class="pnl-empty">No completed games in this period</td>
              </tr>
              <tr
                v-for="row in sortedGamePnl"
                :key="row.gameId"
                :class="row.netPnl < 0 ? 'sc-row--churn' : row.shortfall > 0 ? 'sc-row--warn' : ''"
              >
                <td class="sc-name pnl-title">{{ row.title }}</td>
                <td class="sc-num">{{ row.playerCount }}</td>
                <td class="sc-num pnl-mono">{{ row.ticketPrice.toFixed(2) }}</td>
                <td class="sc-num pnl-mono">{{ row.houseEdgePct }}%</td>
                <td class="sc-num pnl-mono">{{ row.grossRevenue.toFixed(2) }}</td>
                <td class="sc-num pnl-mono">{{ row.totalPrizes.toFixed(2) }}</td>
                <td class="sc-num pnl-mono pnl-expected">{{ row.expectedHouse.toFixed(2) }}</td>
                <td class="sc-num pnl-mono" :class="row.netPnl < 0 ? 'sc-pnl--neg' : 'sc-pnl--pos'">
                  {{ row.netPnl >= 0 ? '+' : '' }}{{ row.netPnl.toFixed(2) }}
                </td>
                <td class="sc-num pnl-mono" :class="row.shortfall > 0.01 ? 'sc-pnl--neg' : 'sc-pnl--pos'">
                  {{ row.shortfall > 0.01 ? '-' : '' }}{{ Math.abs(row.shortfall).toFixed(2) }}
                </td>
                <td class="sc-num pnl-date">{{ row.endedAt ? new Date(row.endedAt).toLocaleDateString('en-ET', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ── Retention matrix ────────────────────────────────────── -->
      <section class="card" v-if="retention">
        <h2 class="card-title">Weekly retention cohorts <span class="card-hint">% of signup cohort playing in week N</span></h2>
        <div class="retention-scroll">
          <table class="retention-table">
            <thead>
              <tr>
                <th>Cohort</th>
                <th>Size</th>
                <th v-for="(_, i) in retention.cohorts[0]?.offsets ?? []" :key="i">W{{ i }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in retention.cohorts" :key="c.week">
                <td class="retention-week">{{ c.week }}</td>
                <td class="retention-size">{{ c.size }}</td>
                <td v-for="(pct, i) in c.offsets" :key="i" class="retention-cell" :style="retentionCellStyle(pct)">
                  {{ pct > 0 ? pct + '%' : '·' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.analytics-page { display: flex; flex-direction: column; gap: 20px; max-width: 1100px; }

.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.page-title { font-size: 22px; font-weight: 700; color: var(--text-primary); }
.page-sub { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

.error-banner {
  padding: 12px 16px; border-radius: 8px; font-size: 13px;
  background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: #f87171;
}
.loading-state { padding: 40px; text-align: center; color: var(--text-muted); font-size: 14px; }

.card {
  background: var(--surface-raised); border: 1px solid var(--surface-border);
  border-radius: 10px; padding: 18px 20px;
}
.card-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 14px; }
.card-hint { font-size: 11px; font-weight: 500; color: var(--text-muted); margin-left: 8px; }

/* Funnel */
.funnel { display: flex; flex-direction: column; gap: 10px; }
.funnel-row { display: grid; grid-template-columns: 110px 1fr 64px 52px; align-items: center; gap: 12px; }
.funnel-label { font-size: 12px; color: var(--text-secondary); }
.funnel-track { height: 22px; background: rgba(255,255,255,0.04); border-radius: 4px; overflow: hidden; }
.funnel-bar { height: 100%; background: var(--brand-primary); border-radius: 4px; transition: width 0.4s ease; min-width: 2px; }
.funnel-count { font-size: 13px; font-weight: 600; color: var(--text-primary); text-align: right; }
.funnel-pct { font-size: 11px; color: var(--text-muted); text-align: right; }

/* KPIs */
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.kpi { display: flex; flex-direction: column; gap: 4px; }
.kpi-value { font-size: 20px; font-weight: 700; color: var(--text-primary); }
.kpi-label { font-size: 11px; color: var(--text-muted); }

/* Win experience */
.winexp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.winexp-cell { display: flex; flex-direction: column; gap: 4px; padding: 10px 0; }
.winexp-num { font-size: 24px; font-weight: 700; color: #34d399; }
.winexp-num--bad { color: #f87171; }
.winexp-label { font-size: 12px; color: var(--text-muted); }

/* Charts */
.chart-box { height: 260px; position: relative; }

/* Retention */
.retention-scroll { overflow-x: auto; }
.retention-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.retention-table th {
  text-align: left; padding: 6px 8px; font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-muted); border-bottom: 1px solid var(--surface-border);
}
.retention-table td { padding: 6px 8px; }
.retention-week { color: var(--text-secondary); white-space: nowrap; }
.retention-size { color: var(--text-muted); }
.retention-cell { text-align: center; border-radius: 3px; color: var(--text-primary); min-width: 48px; }

/* Layer 2 funnel additions */
.funnel-pct--warn { color: #f87171; }
.funnel-bar--blue { background: #3b82f6; }
.method-breakdown { margin-top: 16px; border-top: 1px solid var(--surface-border); padding-top: 12px; }
.method-breakdown-title { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
.method-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
.method-name { font-size: 13px; color: var(--text-primary); flex: 1; }
.method-conv { font-size: 14px; font-weight: 700; color: #34d399; width: 44px; text-align: right; }
.method-detail { font-size: 11px; color: var(--text-muted); }

/* Game Retention Scorecard */
.scorecard-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.scorecard-table th { padding: 6px 10px; text-align: right; color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--surface-border); white-space: nowrap; }
.scorecard-table th.sc-name, .scorecard-table td.sc-name { text-align: left; }
.scorecard-table td { padding: 7px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); color: var(--text-primary); }
.sc-num { text-align: right; font-variant-numeric: tabular-nums; }
.sc-type { text-align: center; }
.sc-row--retaining td { background: rgba(52,211,153,0.04); }
.sc-row--churn td { background: rgba(248,113,113,0.05); }
.sc-lift { font-weight: 700; }
.sc-lift--up { color: #34d399; }
.sc-lift--down { color: #f87171; }
.sc-pnl--neg { color: #f87171; }
.sc-pnl--pos { color: #34d399; }
.sc-low-sample { color: #fbbf24; font-size: 10px; margin-left: 4px; cursor: help; }
.sc-badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
.sc-badge--bingo { background: rgba(245,158,11,0.15); color: #f59e0b; }
.sc-badge--provider { background: rgba(99,102,241,0.15); color: #818cf8; }
.sc-subtitle { font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 16px 0 10px; text-transform: uppercase; letter-spacing: 0.06em; }
.sc-no-data { font-size: 12px; color: var(--text-muted); padding: 12px 0; margin-top: 12px; border-top: 1px solid var(--surface-border); }
.retention-scroll { overflow-x: auto; }

/* Game P&L table */
.pnl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.pnl-sub { font-size: 11px; color: var(--text-muted); margin-top: 3px; }
.pnl-export-btn {
  display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  border-radius: 6px; border: 1px solid var(--surface-border);
  background: rgba(255,255,255,0.04); color: var(--text-secondary);
  font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: background 0.15s;
}
.pnl-export-btn:hover { background: rgba(255,255,255,0.08); color: var(--text-primary); }
.pnl-title { max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pnl-mono { font-variant-numeric: tabular-nums; font-family: monospace; font-size: 11px; }
.pnl-expected { color: rgba(255,255,255,0.35); }
.pnl-date { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.pnl-empty { padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; }
.sc-row--warn td { background: rgba(251,191,36,0.04); }
</style>
