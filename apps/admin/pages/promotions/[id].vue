<script setup lang="ts">
import { CashbackPayoutTiming } from '@world-bingo/shared-types'
import type {
  CashbackPeriodHistory,
  CashbackPromotionDetail,
  CashbackPromotionPatch,
  CashbackQualifiers,
  PromotionActivityRow,
} from '~/composables/useAdminApi'

definePageMeta({ layout: 'default' })

const route = useRoute()
const {
  getCashbackDetail,
  getCashbackQualifiers,
  updateCashbackPromotion,
  toggleCashbackPromotion,
  endCashbackPromotion,
  createCashbackPromotion,
} = useAdminApi()
const toast = useToast()

const id = route.params.id as string

const promotion = ref<CashbackPromotionDetail | null>(null)
const history = ref<CashbackPeriodHistory[]>([])
const activity = ref<PromotionActivityRow[]>([])
const qualifiers = ref<CashbackQualifiers | null>(null)

const loading = ref(true)
const unresolved = ref(false)
const loadFailed = ref(false)
const busy = ref(false)
const refreshingQualifiers = ref(false)

const showEdit = ref(false)
const showEndConfirm = ref(false)

// ── Formatting ─────────────────────────────────────────────────────────────
// Periods are UTC instants; every label has to be read back in Addis time or a
// Mon-Sun week renders as Sunday-Saturday for anyone west of UTC+3.
const ADDIS = 'Africa/Addis_Ababa'

const money = (v: number, dp = 2) =>
  v.toLocaleString('en-ET', { minimumFractionDigits: dp, maximumFractionDigits: dp })

const whole = (v: number) => Math.round(v).toLocaleString('en-ET')

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: ADDIS, month: 'short', day: 'numeric' })

const dayYearLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: ADDIS, month: 'short', day: 'numeric', year: 'numeric' })

// `periodEnd` may be the exclusive next-period boundary or the last instant
// inside the period, and the API is free to change its mind. Stepping back a
// millisecond lands on the closing day under either convention.
const lastInstant = (iso: string) => new Date(new Date(iso).getTime() - 1).toISOString()

const periodLabel = (start: string, end: string) => `${dayLabel(start)} – ${dayLabel(lastInstant(end))}`

// ── Load ───────────────────────────────────────────────────────────────────
async function load() {
  loading.value = true
  unresolved.value = false
  loadFailed.value = false
  try {
    const res = await getCashbackDetail(id)
    promotion.value = res.promotion
    history.value = res.history ?? []
    activity.value = res.activity ?? []
  } catch (err: any) {
    // A missing promotion is an empty state, not an error banner — a stale
    // bookmark is the common way to land here. Anything else is an outage, and
    // saying "this does not exist" about a promotion that does is worse than
    // saying nothing.
    if (err?.statusCode === 404 || err?.status === 404) unresolved.value = true
    else loadFailed.value = true
  } finally {
    loading.value = false
  }
}

async function loadQualifiers() {
  refreshingQualifiers.value = true
  try {
    qualifiers.value = await getCashbackQualifiers(id)
  } catch {
    // The projection is a live extra. Losing it must not take the page with it.
    qualifiers.value = null
  } finally {
    refreshingQualifiers.value = false
  }
}

onMounted(async () => {
  await load()
  if (!unresolved.value) await loadQualifiers()
})

// The close countdown is on screen, so it has to move without a reload.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onUnmounted(() => {
  if (clock) clearInterval(clock)
})

// ── Derived figures ────────────────────────────────────────────────────────
const closedPeriods = computed(() => {
  const openStart = qualifiers.value?.periodStart
  return [...history.value]
    .filter((p) => p.periodStart !== openStart)
    .sort((a, b) => new Date(b.periodStart).getTime() - new Date(a.periodStart).getTime())
})

const lastClosed = computed(() => closedPeriods.value[0] ?? null)
const totalPaid = computed(() => closedPeriods.value.reduce((sum, p) => sum + p.total, 0))
const payoutCount = computed(() => closedPeriods.value.reduce((sum, p) => sum + p.players, 0))
const averagePayout = computed(() => (payoutCount.value ? totalPaid.value / payoutCount.value : 0))

const countdown = computed(() => {
  const end = qualifiers.value ? new Date(qualifiers.value.periodEnd).getTime() : null
  if (!end) return '—'
  const ms = end - now.value
  if (ms <= 0) return 'Due now'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  const mins = Math.floor((ms % 3_600_000) / 60_000)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
})

const closesAtLabel = computed(() => {
  if (!qualifiers.value) return 'Open period unknown'
  const at = new Date(lastInstant(qualifiers.value.periodEnd))
  const stamp = at.toLocaleString('en-GB', {
    timeZone: ADDIS,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return `Period closes ${stamp}`
})

const periodBudget = computed(() => {
  const raw = promotion.value?.periodBudget
  return raw == null ? null : Number(raw)
})

const maxPerPlayer = computed(() => {
  const raw = promotion.value?.maxPayoutPerPlayer
  return raw == null ? null : Number(raw)
})

const projected = computed(() => qualifiers.value?.projectedTotal ?? 0)

const budgetPct = computed(() => {
  const budget = periodBudget.value
  if (!budget || !qualifiers.value) return null
  return Math.round((projected.value / budget) * 100)
})

const overBudgetBy = computed(() => {
  const budget = periodBudget.value
  if (!budget || !qualifiers.value) return 0
  return Math.max(0, projected.value - budget)
})

// Disbursement stops at the cap, so the excess is paid for by dropping players
// off the tail. At the average payout that is roughly this many of them.
const skippedEstimate = computed(() => {
  const players = qualifiers.value?.players ?? 0
  if (!players || !overBudgetBy.value) return 0
  const average = projected.value / players
  return average > 0 ? Math.ceil(overBudgetBy.value / average) : 0
})

type PeriodRow = CashbackPeriodHistory & { open: boolean }

const periodRows = computed<PeriodRow[]>(() => {
  const rows: PeriodRow[] = closedPeriods.value.map((p) => ({ ...p, open: false }))
  const q = qualifiers.value
  if (q) {
    rows.unshift({
      periodStart: q.periodStart,
      periodEnd: q.periodEnd,
      players: q.players,
      total: q.projectedTotal,
      average: q.players ? q.projectedTotal / q.players : 0,
      largest: q.largest,
      open: true,
    })
  }
  return rows
})

const capBarPct = (total: number) => {
  const budget = periodBudget.value
  if (!budget) return null
  return Math.min(100, Math.round((total / budget) * 100))
}

// ── Configuration copy ─────────────────────────────────────────────────────
const statusTagClass = computed(() => {
  switch (promotion.value?.status) {
    case 'live':
      return 'status-tag--positive'
    case 'paused':
      return 'status-tag--warning'
    default:
      return 'status-tag--neutral'
  }
})

const paysAtClose = computed(() => promotion.value?.payoutTiming === CashbackPayoutTiming.PERIOD_CLOSE)

const refundLabel = computed(() => {
  const p = promotion.value
  if (!p) return '—'
  return p.refundType === 'PERCENTAGE'
    ? `${Number(p.refundValue)}% of net loss`
    : `${money(Number(p.refundValue))} ETB flat`
})

const frequencyLabel = computed(() => {
  switch (promotion.value?.frequency) {
    case 'DAILY':
      return 'Daily · midnight to midnight'
    case 'MONTHLY':
      return 'Monthly · 1st to last'
    default:
      return 'Weekly · Mon–Sun'
  }
})

const scopeLabel = computed(() => {
  const p = promotion.value
  if (!p) return '—'
  const templates = p.templateIds?.length ?? 0
  const providerGames = p.providerGameKeys?.length ?? 0
  if (!templates && !providerGames) return 'Site-wide · bingo + provider'
  const parts: string[] = []
  if (templates) parts.push(`${templates} bingo template${templates === 1 ? '' : 's'}`)
  if (providerGames) parts.push(`${providerGames} provider game${providerGames === 1 ? '' : 's'}`)
  return `Scoped · ${parts.join(' + ')}`
})

const validityLabel = computed(() => {
  const hours = promotion.value?.bonusValidityHours ?? 0
  if (!hours) return 'No expiry'
  if (hours % 24 === 0) {
    const days = hours / 24
    return `${days} day${days === 1 ? '' : 's'} from payout`
  }
  return `${hours} hour${hours === 1 ? '' : 's'} from payout`
})

/** Names the unit the range covers, as the artboard's "Week of ..." caption does. */
const periodCaption = (start: string, end: string) => {
  const range = periodLabel(start, end)
  if (promotion.value?.frequency === 'WEEKLY') return `Week of ${range}`
  if (promotion.value?.frequency === 'MONTHLY') return `Month of ${range}`
  return range
}

const windowLabel = computed(() => {
  const p = promotion.value
  if (!p) return '—'
  return `${dayLabel(p.startsAt)} – ${dayYearLabel(lastInstant(p.endsAt))}`
})

// ── Activity copy ──────────────────────────────────────────────────────────
// Actions are API-defined slugs. Rather than maintain a lookup that silently
// drops anything new, humanise the slug and let unknown actions still read.
const humanAction = (action: string) => action.replace(/[._-]+/g, ' ').trim()

const activityDetail = (row: PromotionActivityRow) => {
  if (!row.detail) return ''
  return Object.entries(row.detail)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${String(value)}`)
    .join(' · ')
}

const activityIcon = (action: string) => {
  const a = action.toLowerCase()
  if (a.includes('creat')) return 'i-heroicons:plus'
  if (a.includes('end') || a.includes('cancel')) return 'i-heroicons:x-mark'
  if (a.includes('clos') || a.includes('paid') || a.includes('payout')) return 'i-heroicons:check'
  if (a.includes('pause')) return 'i-heroicons:pause'
  return 'i-heroicons:pencil'
}

const activityTint = (action: string) => {
  const a = action.toLowerCase()
  if (a.includes('clos') || a.includes('paid') || a.includes('payout'))
    return { background: 'rgba(52,211,153,0.13)', color: '#34d399' }
  if (a.includes('end') || a.includes('cancel'))
    return { background: 'rgba(239,68,68,0.13)', color: '#f87171' }
  if (a.includes('creat')) return { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }
  return { background: 'rgba(245,166,35,0.13)', color: 'var(--brand-primary)' }
}

const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: ADDIS,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

// ── Edit ───────────────────────────────────────────────────────────────────
const form = reactive({
  name: '',
  lossThreshold: 0,
  refundValue: 0,
  maxPayoutPerPlayer: '' as string,
  periodBudget: '' as string,
  bonusValidityHours: 0,
  endsAt: '',
})

// datetime-local wants wall-clock text in the browser's own zone, which is what
// `new Date(value)` reads back on submit.
const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function openEdit() {
  const p = promotion.value
  if (!p) return
  form.name = p.name
  form.lossThreshold = Number(p.lossThreshold)
  form.refundValue = Number(p.refundValue)
  form.maxPayoutPerPlayer = p.maxPayoutPerPlayer == null ? '' : String(Number(p.maxPayoutPerPlayer))
  form.periodBudget = p.periodBudget == null ? '' : String(Number(p.periodBudget))
  form.bonusValidityHours = p.bonusValidityHours
  form.endsAt = toLocalInput(p.endsAt)
  showEdit.value = true
}

/** '' means "no cap" and clears the column; anything unparseable is ignored. */
const optionalMoney = (raw: string): number | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

async function saveEdit() {
  const p = promotion.value
  if (!p) return
  if (!form.name.trim()) {
    toast.add({ title: 'Name is required', color: 'error' })
    return
  }

  const patch: CashbackPromotionPatch = {}
  if (form.name.trim() !== p.name) patch.name = form.name.trim()
  if (form.lossThreshold !== Number(p.lossThreshold)) patch.lossThreshold = form.lossThreshold
  if (form.refundValue !== Number(p.refundValue)) patch.refundValue = form.refundValue
  if (form.bonusValidityHours !== p.bonusValidityHours) patch.bonusValidityHours = form.bonusValidityHours

  const nextMax = optionalMoney(form.maxPayoutPerPlayer)
  if (nextMax !== maxPerPlayer.value) patch.maxPayoutPerPlayer = nextMax
  const nextBudget = optionalMoney(form.periodBudget)
  if (nextBudget !== periodBudget.value) patch.periodBudget = nextBudget

  if (form.endsAt) {
    const iso = new Date(form.endsAt).toISOString()
    if (iso !== new Date(p.endsAt).toISOString()) patch.endsAt = iso
  }

  if (!Object.keys(patch).length) {
    showEdit.value = false
    return
  }

  busy.value = true
  try {
    await updateCashbackPromotion(id, patch)
    toast.add({ title: 'Saved', color: 'success' })
    showEdit.value = false
    await load()
    // The cap and the threshold both move the projection, so it is stale now.
    await loadQualifiers()
  } catch (err: any) {
    toast.add({ title: 'Failed to save', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    busy.value = false
  }
}

// ── Pause / end / duplicate ────────────────────────────────────────────────
async function togglePause() {
  const p = promotion.value
  if (!p) return
  busy.value = true
  try {
    await toggleCashbackPromotion(id, !p.isActive)
    toast.add({ title: p.isActive ? 'Promotion paused' : 'Promotion resumed', color: 'success' })
    await load()
  } catch (err: any) {
    toast.add({ title: 'Failed', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    busy.value = false
  }
}

async function endNow() {
  busy.value = true
  try {
    await endCashbackPromotion(id)
    toast.add({ title: 'Promotion ended', description: 'No further period will settle.', color: 'success' })
    showEndConfirm.value = false
    await load()
  } catch (err: any) {
    toast.add({ title: 'Failed to end', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    busy.value = false
  }
}

async function duplicate() {
  const p = promotion.value
  if (!p) return
  busy.value = true
  try {
    const created = (await createCashbackPromotion({
      name: `${p.name} (copy)`,
      lossThreshold: Number(p.lossThreshold),
      refundType: p.refundType,
      refundValue: Number(p.refundValue),
      frequency: p.frequency,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      templateIds: p.templateIds,
      providerGameKeys: p.providerGameKeys,
    })) as { id?: string } | null

    // Create does not take the caps or the validity window, so the copy is only
    // a real copy after this second call. It lands paused either way, so a
    // half-copied promotion cannot pay anyone.
    if (created?.id) {
      await updateCashbackPromotion(created.id, {
        maxPayoutPerPlayer: maxPerPlayer.value,
        periodBudget: periodBudget.value,
        bonusValidityHours: p.bonusValidityHours,
      })
    }

    toast.add({ title: 'Duplicated', description: 'The copy is inactive until you enable it.', color: 'success' })
    if (created?.id) await navigateTo(`/promotions/${created.id}`)
  } catch (err: any) {
    toast.add({ title: 'Failed to duplicate', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    busy.value = false
  }
}

// ── Export ─────────────────────────────────────────────────────────────────
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

function exportCsv() {
  const lines = [
    ['Period start', 'Period end', 'Payouts', 'Total', 'Average', 'Largest', 'Status'],
    ...periodRows.value.map((r) => [
      r.periodStart,
      r.periodEnd,
      String(r.players),
      r.total.toFixed(2),
      r.average.toFixed(2),
      r.largest.toFixed(2),
      r.open ? 'projected' : 'settled',
    ]),
  ]
  const csv = lines.map((row) => row.map(csvCell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `cashback-${id}-payouts.csv`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="p-4 md:p-6 space-y-5">
    <div v-if="loading" class="space-y-4">
      <USkeleton class="h-8 w-64" />
      <USkeleton class="h-24 w-full" />
      <USkeleton class="h-72 w-full" />
    </div>

    <!-- A stale link is the usual way in, so name the thing that is missing. -->
    <div v-else-if="loadFailed" class="admin-card flex flex-col items-center gap-3 px-6 py-16 text-center">
      <UIcon name="i-heroicons:exclamation-triangle" class="h-10 w-10 text-amber-400" />
      <h1 class="text-lg font-bold text-white">Could not load this promotion</h1>
      <p class="max-w-md text-sm text-white/60">
        The request failed. The promotion is untouched — nothing here has changed.
      </p>
      <div class="flex gap-2">
        <UButton color="primary" label="Try again" class="min-h-11" @click="load" />
        <UButton to="/promotions" color="neutral" variant="subtle" label="Back to promotions" class="min-h-11" />
      </div>
    </div>

    <div
      v-else-if="unresolved || !promotion"
      class="admin-card flex flex-col items-center gap-3 px-6 py-16 text-center"
    >
      <UIcon name="i-heroicons:magnifying-glass" class="h-10 w-10 text-white/55" />
      <h1 class="text-lg font-bold text-white">No cashback promotion here</h1>
      <p class="max-w-md text-sm text-white/60">
        Nothing is stored against <span class="font-mono text-white/75">{{ id }}</span>. It may have been
        deleted, or this link may point at a promotion of another kind — this page covers cashback only.
      </p>
      <UButton to="/promotions" color="primary" label="Back to promotions" class="min-h-11" />
    </div>

    <template v-else>
      <!-- Breadcrumb -->
      <nav class="flex items-center gap-2 text-[12.5px] text-white/55" aria-label="Breadcrumb">
        <NuxtLink to="/promotions" class="hover:text-white/85">Promotions</NuxtLink>
        <UIcon name="i-heroicons:chevron-right" class="w-3 h-3" />
        <span class="text-white/85">{{ promotion.name }}</span>
      </nav>

      <!-- Title + actions -->
      <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="text-2xl font-bold tracking-tight text-white">{{ promotion.name }}</h1>
            <span class="status-tag" :class="statusTagClass">{{ promotion.status }}</span>
            <span class="status-tag cashback-tag">Cashback</span>
          </div>
          <p class="mt-1 text-[13.5px] text-white/60">
            {{ promotion.rewardSummary }} ·
            {{ paysAtClose ? 'pays at period close' : 'pays on threshold' }} ·
            Africa/Addis_Ababa
          </p>
        </div>

        <div class="flex shrink-0 flex-wrap gap-2">
          <UButton
            v-if="promotion.status !== 'ended'"
            :icon="promotion.isActive ? 'i-heroicons:pause' : 'i-heroicons:play'"
            :label="promotion.isActive ? 'Pause' : 'Resume'"
            color="neutral"
            variant="subtle"
            class="min-h-11"
            :loading="busy"
            @click="togglePause"
          />
          <UButton
            icon="i-heroicons:document-duplicate"
            label="Duplicate"
            color="neutral"
            variant="subtle"
            class="min-h-11"
            :loading="busy"
            @click="duplicate"
          />
          <UButton
            v-if="promotion.status !== 'ended'"
            icon="i-heroicons:x-circle"
            label="End now"
            color="error"
            variant="subtle"
            class="min-h-11"
            @click="showEndConfirm = true"
          />
          <UButton
            icon="i-heroicons:pencil"
            label="Edit"
            color="primary"
            class="min-h-11"
            @click="openEdit"
          />
        </div>
      </div>

      <!-- Stat tiles -->
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div class="admin-card flex flex-col gap-1.5 px-4 py-3.5">
          <span class="lbl">Paid last period</span>
          <span class="stat">{{ lastClosed ? whole(lastClosed.total) : '—' }} <span class="unit">ETB</span></span>
          <span class="cap">
            {{ lastClosed ? periodCaption(lastClosed.periodStart, lastClosed.periodEnd) : 'No period has closed yet' }}
          </span>
        </div>
        <div class="admin-card flex flex-col gap-1.5 px-4 py-3.5">
          <span class="lbl">Total paid</span>
          <span class="stat">{{ whole(totalPaid) }} <span class="unit">ETB</span></span>
          <span class="cap">
            Across {{ closedPeriods.length }} closed period{{ closedPeriods.length === 1 ? '' : 's' }}
          </span>
        </div>
        <div class="admin-card flex flex-col gap-1.5 px-4 py-3.5">
          <span class="lbl">Payouts made</span>
          <span class="stat">{{ whole(payoutCount) }}</span>
          <span class="cap">{{ payoutCount ? `Avg ${money(averagePayout)} ETB each` : 'Nothing paid yet' }}</span>
        </div>
        <div class="admin-card flex flex-col gap-1.5 px-4 py-3.5">
          <span class="lbl">Next payout</span>
          <span class="stat">{{ countdown }}</span>
          <span class="cap">{{ closesAtLabel }}</span>
        </div>
      </div>

      <!-- Configuration | live qualification -->
      <div class="grid gap-4 xl:grid-cols-2 xl:items-start">
        <!-- Configuration -->
        <section class="admin-card px-4 py-4 md:px-[18px]">
          <div class="flex items-center justify-between pb-2">
            <h2 class="text-sm font-bold tracking-wide text-white">Configuration</h2>
            <button type="button" class="action-link min-h-11" @click="openEdit">Edit</button>
          </div>

          <div class="cfg"><span class="ck">Loss threshold</span><span class="cv tabular-nums">{{ money(Number(promotion.lossThreshold)) }} ETB</span></div>
          <div class="cfg"><span class="ck">Refund</span><span class="cv">{{ refundLabel }}</span></div>
          <div class="cfg">
            <span class="ck">Max payout per player</span>
            <span class="cv flex items-center justify-end gap-2">
              <template v-if="maxPerPlayer == null">
                <span class="status-tag status-tag--warning">Not set</span>
                <span class="text-white/55">unlimited</span>
              </template>
              <span v-else class="tabular-nums">{{ money(maxPerPlayer) }} ETB</span>
            </span>
          </div>
          <div class="cfg">
            <span class="ck">Budget per period</span>
            <span class="cv flex items-center justify-end gap-2">
              <template v-if="periodBudget == null">
                <span class="status-tag status-tag--warning">Not set</span>
                <span class="text-white/55">unlimited</span>
              </template>
              <span v-else class="tabular-nums">{{ money(periodBudget) }} ETB</span>
            </span>
          </div>
          <div class="cfg">
            <span class="ck">Payout timing</span>
            <span class="cv">{{ paysAtClose ? 'At period close' : 'On threshold' }}</span>
          </div>
          <div class="cfg"><span class="ck">Frequency</span><span class="cv">{{ frequencyLabel }}</span></div>
          <div class="cfg"><span class="ck">Time zone</span><span class="cv">Africa/Addis_Ababa (UTC+3)</span></div>
          <div class="cfg"><span class="ck">Game scope</span><span class="cv">{{ scopeLabel }}</span></div>
          <div class="cfg"><span class="ck">Audience</span><span class="cv">All players</span></div>
          <div class="cfg"><span class="ck">Bonus validity</span><span class="cv">{{ validityLabel }}</span></div>
          <div class="cfg"><span class="ck">Window</span><span class="cv">{{ windowLabel }}</span></div>

          <!-- Budget meter, measured against the projected close rather than
               against what has already been paid: nothing is paid mid-period. -->
          <div
            v-if="periodBudget != null && qualifiers"
            class="mt-3.5 flex flex-col gap-2 border-t border-white/[0.06] pt-3.5"
          >
            <div class="flex items-baseline justify-between">
              <span class="ck">Projected against period budget</span>
              <span
                class="text-[13px] font-bold tabular-nums"
                :class="overBudgetBy > 0 ? 'text-amber-400' : 'text-white/85'"
              >{{ budgetPct }}%</span>
            </div>
            <div class="h-[7px] overflow-hidden rounded-full bg-white/10">
              <div
                class="h-full rounded-full"
                :style="{
                  width: `${Math.min(100, budgetPct ?? 0)}%`,
                  background: overBudgetBy > 0 ? '#fbbf24' : 'rgba(255,255,255,0.4)',
                }"
              />
            </div>
            <span class="cap">
              {{ whole(projected) }} ETB projected at close against a {{ whole(periodBudget) }} ETB cap.
              Disbursement stops automatically at the cap.
            </span>
          </div>
        </section>

        <!-- Qualifies right now -->
        <section
          class="admin-card flex flex-col gap-3.5 px-4 py-4 md:px-[18px]"
          style="border-color: rgba(6,182,212,0.3);"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-sm font-bold tracking-wide text-white">Qualifies right now</h2>
              <p class="mt-0.5 text-[12.5px] leading-relaxed text-white/60">
                Recomputed live. The next close pays these players unless their loss changes.
              </p>
            </div>
            <button
              type="button"
              class="action-link action-link--cyan min-h-11"
              :disabled="refreshingQualifiers"
              @click="loadQualifiers"
            >
              <UIcon
                name="i-heroicons:arrow-path"
                class="h-3.5 w-3.5"
                :class="refreshingQualifiers ? 'animate-spin' : ''"
              />
              Refresh
            </button>
          </div>

          <template v-if="qualifiers">
            <p class="text-[12.5px] text-white/60">
              Open period {{ periodLabel(qualifiers.periodStart, qualifiers.periodEnd) }}
            </p>

            <div class="grid grid-cols-3 gap-2.5">
              <div class="mini">
                <span class="lbl lbl--sm">Players</span>
                <span class="mini-val">{{ whole(qualifiers.players) }}</span>
              </div>
              <div class="mini">
                <span class="lbl lbl--sm">Projected</span>
                <span class="mini-val" style="color: #22d3ee">{{ whole(qualifiers.projectedTotal) }}</span>
              </div>
              <div class="mini">
                <span class="lbl lbl--sm">Largest</span>
                <span class="mini-val">{{ whole(qualifiers.largest) }}</span>
              </div>
            </div>

            <div
              v-if="overBudgetBy > 0"
              class="flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5"
              style="background: rgba(251,191,36,0.07); border-color: rgba(251,191,36,0.22);"
            >
              <UIcon name="i-heroicons:exclamation-triangle" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <p class="m-0 text-[12.5px] leading-normal text-white/80">
                This close would exceed the period budget by {{ whole(overBudgetBy) }} ETB.
                <template v-if="skippedEstimate">
                  About {{ skippedEstimate }} player{{ skippedEstimate === 1 ? '' : 's' }} at the tail would be
                  skipped
                </template>
                — raise the cap or accept the cut-off.
              </p>
            </div>

            <div v-if="qualifiers.top.length" class="flex flex-col">
              <div
                v-for="row in qualifiers.top"
                :key="row.username"
                class="flex items-center justify-between gap-3 border-t border-white/[0.06] py-2.5"
              >
                <span class="text-[12.5px] tabular-nums text-white/80">
                  {{ row.username }} · {{ whole(row.netLoss) }} ETB lost
                </span>
                <span class="text-[13px] font-bold tabular-nums" style="color: #34d399">{{ money(row.payout) }}</span>
              </div>
              <p v-if="qualifiers.players > qualifiers.top.length" class="cap border-t border-white/[0.06] pt-2.5">
                Showing the top {{ qualifiers.top.length }} of {{ whole(qualifiers.players) }}.
              </p>
            </div>

            <p v-else class="cap">Nobody has crossed the threshold in this period yet.</p>
          </template>

          <p v-else class="cap">
            The live projection is unavailable right now. Everything else on this page is unaffected.
          </p>
        </section>
      </div>

      <!-- Artwork -->
      <PromoArtworkPanel kind="CASHBACK" :ref-id="id" />

      <!-- Payout history -->
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-bold tracking-wide text-white">Payout history</h2>
          <button
            type="button"
            class="action-link action-link--muted min-h-11"
            :disabled="!periodRows.length"
            @click="exportCsv"
          >
            <UIcon name="i-heroicons:arrow-down-tray" class="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>

        <div class="admin-card overflow-x-auto">
          <table v-if="periodRows.length" class="admin-table">
            <thead>
              <tr>
                <th>Period</th>
                <th class="num">Payouts</th>
                <th class="num">Total</th>
                <th class="num">Average</th>
                <th class="num">Largest</th>
                <th>Against cap</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in periodRows" :key="row.periodStart">
                <td :class="row.open ? 'font-medium' : ''">
                  {{ periodLabel(row.periodStart, row.periodEnd) }}
                  <span v-if="row.open" class="status-tag status-tag--positive ml-2">Open</span>
                </td>
                <td class="num" :class="row.open ? 'text-white/70' : ''">{{ whole(row.players) }}{{ row.open ? '*' : '' }}</td>
                <td class="num" :class="row.open ? 'text-white/70' : ''">{{ money(row.total) }}{{ row.open ? '*' : '' }}</td>
                <td class="num" :class="row.open ? 'text-white/70' : ''">{{ money(row.average) }}{{ row.open ? '*' : '' }}</td>
                <td class="num" :class="row.open ? 'text-white/70' : ''">{{ money(row.largest) }}{{ row.open ? '*' : '' }}</td>
                <td class="w-[140px]">
                  <div v-if="capBarPct(row.total) !== null" class="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      class="h-full rounded-full"
                      :style="{
                        width: `${capBarPct(row.total)}%`,
                        background: row.total > (periodBudget ?? 0) ? '#fbbf24' : 'rgba(255,255,255,0.4)',
                      }"
                    />
                  </div>
                  <span v-else class="text-[12.5px] text-white/55">No cap</span>
                </td>
              </tr>
            </tbody>
          </table>

          <p v-else class="px-4 py-10 text-center text-[12.5px] text-white/60">
            No period has settled yet. The first payout lands when the open period closes.
          </p>
        </div>

        <p v-if="qualifiers" class="m-0 text-[12.5px] leading-normal text-white/55">
          * Projected. Nothing is paid until the period closes. Closed periods are shown against the
          {{ periodBudget == null ? 'cap in force today, which is unlimited' : `${whole(periodBudget)} ETB cap in force today` }} —
          the cap that applied when each of them settled is not recorded.
        </p>
      </section>

      <!-- Activity -->
      <section class="flex flex-col gap-3">
        <h2 class="text-sm font-bold tracking-wide text-white">Activity</h2>
        <div class="admin-card px-4 py-1 md:px-[18px]">
          <div
            v-for="(row, i) in activity"
            :key="row.id"
            class="flex items-start gap-3 py-3"
            :class="i ? 'border-t border-white/[0.06]' : ''"
          >
            <div class="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg" :style="activityTint(row.action)">
              <UIcon :name="activityIcon(row.action)" class="h-3.5 w-3.5" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="m-0 text-[13px] text-white/85">
                <strong class="font-semibold text-white">{{ row.actorName ?? 'System' }}</strong>
                {{ humanAction(row.action) }}
              </p>
              <p v-if="activityDetail(row)" class="m-0 mt-0.5 text-[12.5px] text-white/60">{{ activityDetail(row) }}</p>
            </div>
            <span class="shrink-0 text-[12.5px] text-white/55">{{ stamp(row.createdAt) }}</span>
          </div>

          <p v-if="!activity.length" class="py-8 text-center text-[12.5px] text-white/60">
            Nothing has been recorded against this promotion yet.
          </p>
        </div>
      </section>
    </template>

    <!-- Edit -->
    <UModal v-model:open="showEdit" title="Edit promotion" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name">
            <UInput v-model="form.name" class="w-full" />
          </UFormField>
          <UFormField label="Loss threshold (ETB)">
            <UInput v-model.number="form.lossThreshold" type="number" min="1" class="w-full" />
          </UFormField>
          <UFormField
            :label="promotion?.refundType === 'PERCENTAGE' ? 'Refund percentage (%)' : 'Refund amount (ETB)'"
          >
            <UInput v-model.number="form.refundValue" type="number" min="0.01" class="w-full" />
          </UFormField>
          <UFormField label="Max payout per player (ETB)" help="Leave empty for no per-player cap.">
            <UInput v-model="form.maxPayoutPerPlayer" type="number" min="0" placeholder="Unlimited" class="w-full" />
          </UFormField>
          <UFormField label="Budget per period (ETB)" help="Disbursement stops once a close reaches this.">
            <UInput v-model="form.periodBudget" type="number" min="0" placeholder="Unlimited" class="w-full" />
          </UFormField>
          <UFormField label="Bonus validity (hours)">
            <UInput v-model.number="form.bonusValidityHours" type="number" min="1" class="w-full" />
          </UFormField>
          <UFormField label="Window end">
            <UInput v-model="form.endsAt" type="datetime-local" class="w-full" />
          </UFormField>
          <p class="text-[12.5px] text-white/60">
            Refund type, frequency and game scope are fixed once a promotion exists — duplicate it to
            change them.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" class="min-h-11" @click="showEdit = false" />
          <UButton color="primary" label="Save" class="min-h-11" :loading="busy" @click="saveEdit" />
        </div>
      </template>
    </UModal>

    <!-- End now: irreversible, so it is confirmed rather than undone. -->
    <UModal v-model:open="showEndConfirm" title="End this promotion?" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-3 text-sm text-white/80">
          <p class="m-0">
            Ending closes the window and deactivates <strong class="text-white">{{ promotion?.name }}</strong>.
            No period that opens after this settles, and there is no undo.
          </p>
          <p v-if="qualifiers && qualifiers.players > 0" class="m-0 text-amber-400">
            {{ whole(qualifiers.players) }} player{{ qualifiers.players === 1 ? '' : 's' }} currently
            projected for {{ whole(projected) }} ETB will not be paid.
          </p>
          <p class="m-0 text-white/60">Pause instead if you only want to stop it temporarily.</p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" class="min-h-11" @click="showEndConfirm = false" />
          <UButton color="error" label="End now" class="min-h-11" :loading="busy" @click="endNow" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* Values lifted from docs/design/bonus-cashback/AdminPromoDetail.dc.html so the
   page matches the artboard rather than approximating it. */
.lbl {
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
}
.lbl--sm {
  font-size: 10.5px;
}
.stat {
  font-family: var(--font-ui);
  font-size: 23px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.unit {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.55);
}
.cap {
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.55);
}
.cfg {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.ck {
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.55);
}
.cv {
  font-size: 13px;
  font-weight: 500;
  color: #fff;
  text-align: right;
}
.mini {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.mini-val {
  font-family: var(--font-ui);
  font-size: 19px;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.cashback-tag {
  color: #22d3ee;
  background: rgba(6, 182, 212, 0.1);
  border-color: rgba(6, 182, 212, 0.26);
}
/* 44px minimum hit target, with the padding pulled back out so the label still
   sits on the artboard's baseline. */
.action-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  margin-right: -8px;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--brand-primary);
}
.action-link:hover {
  color: var(--brand-primary-dim);
}
.action-link:disabled {
  opacity: 0.45;
}
.action-link--cyan {
  color: #22d3ee;
}
.action-link--muted {
  color: rgba(255, 255, 255, 0.62);
}
.action-link--muted:hover {
  color: #fff;
}
</style>
