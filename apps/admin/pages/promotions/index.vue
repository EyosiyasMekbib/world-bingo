<script setup lang="ts">
import { PromoKind, type PromoArtworkDto } from '@world-bingo/shared-types'

definePageMeta({ layout: 'default' })

const api = useAdminApi()
const {
  getCashbackPromotions,
  createCashbackPromotion,
  toggleCashbackPromotion,
  getBonusRules,
  createBonusRule,
  toggleBonusRule,
  getBonusReconciliation,
  getSegments,
  countSegmentRules,
  getGameTemplates,
  getProviders,
  getProviderGames,
} = api
const toast = useToast()

type PromotionStatus = 'live' | 'scheduled' | 'ended' | 'paused'

/** One row of GET /admin/promotions — welcome, cashback and deposit rules alike. */
type PromotionRow = {
  kind: PromoKind
  id: string
  name: string
  status: PromotionStatus
  rewardSummary: string
  audience: string
  startsAt: string | null
  endsAt: string | null
  paidThisWeek: number
  totalPaid: number
  payoutCount: number
  hasArtwork: boolean
}

type PromotionSummary = {
  paidThisWeek: number
  paidAllTime: number
  playersReached: number
  outstandingLiability: number
}

const rows = ref<PromotionRow[]>([])
const loading = ref(true)
const loadFailed = ref(false)

// Every surface below the table degrades on its own: a summary that will not
// load is hidden rather than shown as zeroes, which would read as "nothing has
// ever been paid" instead of "we could not ask".
const summary = ref<PromotionSummary | null>(null)

// The spine carries money, status and audience but not frequency or validity,
// so the two config lists ride along for the type line under each name — and
// for the next cashback close, which is a function of frequency alone.
const cashbackConfigs = ref<any[]>([])
const ruleConfigs = ref<any[]>([])

const cashbackById = computed(() => new Map(cashbackConfigs.value.map((c: any) => [c.id, c])))
const ruleById = computed(() => new Map(ruleConfigs.value.map((r: any) => [r.id, r])))

// Keyed 'KIND:refId'. `artworkLoaded` is separate because a failed artwork
// request must not relabel an uploaded tile as "Generated" — without it the
// absence of a key is indistinguishable from never having asked.
const artworkByKey = ref(new Map<string, PromoArtworkDto>())
const artworkLoaded = ref(false)

/* ── Load ───────────────────────────────────────────────────────────────── */

async function fetchRows() {
  loading.value = true
  loadFailed.value = false
  try {
    const res = await api.fetch<{ items: PromotionRow[] }>('/admin/promotions')
    rows.value = res?.items ?? []
  } catch {
    loadFailed.value = true
    rows.value = []
  } finally {
    loading.value = false
  }
}

async function fetchSummary() {
  try {
    summary.value = await api.fetch<PromotionSummary>('/admin/promotions/summary')
  } catch {
    summary.value = null
  }
}

async function fetchArtwork() {
  try {
    const res = await api.fetch<{ items: PromoArtworkDto[] }>('/admin/promo-artwork')
    artworkByKey.value = new Map((res?.items ?? []).map((art) => [`${art.kind}:${art.refId}`, art]))
    artworkLoaded.value = true
  } catch {
    artworkLoaded.value = false
  }
}

async function fetchConfigs() {
  const [cashback, rules] = await Promise.all([
    getCashbackPromotions().catch(() => [] as any[]),
    getBonusRules().catch(() => [] as any[]),
  ])
  cashbackConfigs.value = (cashback as any[]) ?? []
  ruleConfigs.value = (rules as any[]) ?? []
}

function load() {
  return Promise.all([fetchRows(), fetchSummary(), fetchArtwork(), fetchConfigs()])
}

/* ── Row projection ─────────────────────────────────────────────────────── */

const KIND_LABEL: Record<string, string> = {
  [PromoKind.WELCOME]: 'Welcome bonus',
  [PromoKind.CASHBACK]: 'Cashback',
  [PromoKind.DEPOSIT_RULE]: 'Deposit rule',
  [PromoKind.REFERRAL]: 'Referral',
}

const KIND_ICON: Record<string, string> = {
  [PromoKind.WELCOME]: 'i-heroicons:gift',
  [PromoKind.CASHBACK]: 'i-heroicons:arrow-path-rounded-square',
  [PromoKind.DEPOSIT_RULE]: 'i-heroicons:calendar-days',
  [PromoKind.REFERRAL]: 'i-heroicons:user-plus',
}

function shortDate(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-ET', { month: 'short', day: 'numeric' })
}

function typeLine(row: PromotionRow) {
  const kind = KIND_LABEL[row.kind] ?? 'Promotion'
  if (row.kind === PromoKind.WELCOME) return 'First deposit · no expiry'
  if (row.status === 'ended') return `${kind} · ended ${shortDate(row.endsAt)}`

  if (row.kind === PromoKind.CASHBACK) {
    const cfg = cashbackById.value.get(row.id)
    if (!cfg) return kind
    const parts = [
      kind,
      String(cfg.frequency).toLowerCase(),
      cfg.payoutTiming === 'ON_THRESHOLD' ? 'pays on threshold' : 'pays at close',
    ]
    const scoped = cfg.scopedGameNames?.length ?? 0
    if (scoped > 0) parts.push(`${scoped} scoped game${scoped === 1 ? '' : 's'}`)
    return parts.join(' · ')
  }

  const rule = ruleById.value.get(row.id)
  if (!rule) return kind
  return `${kind} · ${rule.type === 'DAILY_DEPOSIT' ? 'daily' : 'weekly'} · valid ${rule.validityHours}h`
}

// A percentage reward with no ceiling is the one config that can cost an
// unbounded amount, so it is flagged in the list and not only on the detail page.
function isUncapped(row: PromotionRow) {
  if (row.kind === PromoKind.CASHBACK) {
    const cfg = cashbackById.value.get(row.id)
    return cfg?.refundType === 'PERCENTAGE' && cfg?.maxPayoutPerPlayer == null
  }
  if (row.kind === PromoKind.DEPOSIT_RULE) {
    const rule = ruleById.value.get(row.id)
    return rule?.rewardType === 'PERCENTAGE' && rule?.maxReward == null
  }
  return false
}

const isSegmented = (row: PromotionRow) => row.audience !== 'All players'

const STATUS_TAG: Record<PromotionStatus, string> = {
  live: 'status-tag--positive',
  paused: 'status-tag--warning',
  scheduled: 'tag-info',
  ended: 'status-tag--neutral',
}

function statusLabel(row: PromotionRow) {
  if (row.status === 'scheduled') return `Starts ${shortDate(row.startsAt)}`
  return { live: 'Live', paused: 'Paused', ended: 'Ended' }[row.status]
}

const artworkFor = (row: PromotionRow) => artworkByKey.value.get(`${row.kind}:${row.id}`) ?? null

// Whole ETB: the list is for scanning relative size, and the decimals are on
// the detail page where individual payouts are listed.
const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })
const figure = (n: number) => (n > 0 ? money(n) : '—')

/* ── Filter tabs ────────────────────────────────────────────────────────── */

type Tab = 'live' | 'scheduled' | 'ended' | 'all'

const tab = ref<Tab>('live')

// A paused offer sits inside its window and is one toggle away from paying
// again, so it is grouped with the live ones. The four tabs the design calls
// for have no fifth home, and dropping it into All alone would make an offer
// disappear from the list the moment an admin paused it.
function inTab(row: PromotionRow, t: Tab) {
  if (t === 'all') return true
  if (t === 'live') return row.status === 'live' || row.status === 'paused'
  return row.status === t
}

const TAB_LABELS: Array<{ key: Tab; label: string }> = [
  { key: 'live', label: 'Live' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'ended', label: 'Ended' },
  { key: 'all', label: 'All' },
]

const tabs = computed(() =>
  TAB_LABELS.map((t) => ({ ...t, count: rows.value.filter((row) => inTab(row, t.key)).length })),
)

const visibleRows = computed(() => rows.value.filter((row) => inTab(row, tab.value)))

const emptyMessage = computed(() =>
  tab.value === 'all' ? 'No promotions yet' : `No ${tab.value} promotions`,
)

/* ── Health strip ───────────────────────────────────────────────────────── */

const mismatches = ref<Array<{ userId: string; cachedBalance: number; lotSum: number }>>([])
const reconciling = ref(false)
const reconciliationStatus = ref<'checking' | 'clean' | 'drift' | 'error'>('checking')

async function fetchReconciliation() {
  reconciling.value = true
  reconciliationStatus.value = 'checking'
  try {
    mismatches.value = await getBonusReconciliation()
    reconciliationStatus.value = mismatches.value.length ? 'drift' : 'clean'
  } catch {
    reconciliationStatus.value = 'error'
    toast.add({ title: 'Error', description: 'Failed to run reconciliation', color: 'error' })
  } finally {
    reconciling.value = false
  }
}

const reconciliationIcon = computed(() => ({
  checking: 'i-heroicons:arrow-path',
  clean: 'i-heroicons:check-circle',
  drift: 'i-heroicons:exclamation-triangle',
  error: 'i-heroicons:x-circle',
}[reconciliationStatus.value]))

const reconciliationIconColor = computed(() => ({
  checking: 'text-white/55',
  clean: 'text-green-400',
  drift: 'text-red-400',
  error: 'text-amber-400',
}[reconciliationStatus.value]))

const reconciliationBorderClass = computed(() => ({
  checking: '',
  clean: '',
  drift: 'strip--drift',
  error: 'strip--error',
}[reconciliationStatus.value]))

const reconciliationMessage = computed(() => {
  if (reconciliationStatus.value === 'checking') return 'Checking bonus ledger for drift...'
  if (reconciliationStatus.value === 'clean') return 'Bonus ledger reconciled — no drift'
  if (reconciliationStatus.value === 'drift') return `${mismatches.value.length} wallet(s) disagree with their bonus grant ledger`
  return 'Reconciliation check failed — try again'
})

// Mirrors apps/api/src/lib/bonus-period.ts, which cuts every bonus window in the
// system: the deposit-rule buckets, and — since getCurrentPeriod in
// apps/api/src/services/cashback.service.ts delegates to those same helpers —
// the cashback periods this close belongs to. Africa/Addis_Ababa is a fixed UTC+3
// with no DST, so the local calendar day is found by shifting the instant rather
// than by asking for the zone's transition rules.
const ADDIS_OFFSET_MS = 3 * 60 * 60 * 1000

function nextPeriodStart(frequency: string, now: Date) {
  const local = new Date(now.getTime() + ADDIS_OFFSET_MS)
  const y = local.getUTCFullYear()
  const m = local.getUTCMonth()
  const d = local.getUTCDate()
  if (frequency === 'MONTHLY') return new Date(Date.UTC(y, m + 1, 1) - ADDIS_OFFSET_MS)
  if (frequency === 'WEEKLY') {
    const daysToMonday = 7 - ((local.getUTCDay() + 6) % 7)
    return new Date(Date.UTC(y, m, d + daysToMonday) - ADDIS_OFFSET_MS)
  }
  return new Date(Date.UTC(y, m, d + 1) - ADDIS_OFFSET_MS)
}

function formatClose(at: Date, frequency: string) {
  const shape: Intl.DateTimeFormatOptions = frequency === 'MONTHLY'
    ? { month: 'short', day: 'numeric' }
    : { weekday: 'short' }
  return new Intl.DateTimeFormat('en-GB', {
    ...shape,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Africa/Addis_Ababa',
  }).format(at)
}

const nextCashbackClose = computed(() => {
  const now = new Date()
  let soonest: { at: Date; frequency: string } | null = null
  for (const row of rows.value) {
    if (row.kind !== PromoKind.CASHBACK || row.status !== 'live') continue
    const frequency = cashbackById.value.get(row.id)?.frequency
    if (typeof frequency !== 'string') continue
    const at = nextPeriodStart(frequency, now)
    if (!soonest || at < soonest.at) soonest = { at, frequency }
  }
  if (!soonest) return null
  // The boundary instant belongs to the next period; the label wants the last
  // minute of this one, which is the clock an admin is actually watching.
  return formatClose(new Date(soonest.at.getTime() - 60_000), soonest.frequency)
})

/* ── Row actions ────────────────────────────────────────────────────────── */

function openRow(row: PromotionRow) {
  if (row.kind !== PromoKind.CASHBACK) return
  navigateTo(`/promotions/${row.id}`)
}

async function toggle(row: PromotionRow) {
  const resume = row.status === 'paused'
  try {
    if (row.kind === PromoKind.CASHBACK) await toggleCashbackPromotion(row.id, resume)
    else await toggleBonusRule(row.id, resume)
    toast.add({ title: resume ? 'Resumed' : 'Paused', color: 'success' })
    await load()
  } catch {
    toast.add({ title: 'Error', description: 'Failed to update', color: 'error' })
  }
}

const endTarget = ref<PromotionRow | null>(null)
const ending = ref(false)

// What ending owes depends on the timing: a PERIOD_CLOSE promotion settles the
// window it was ended inside, an ON_THRESHOLD one has already paid whatever it
// owes. PERIOD_CLOSE is the column default, so an unknown timing is read as the
// branch that promises one more settlement rather than none.
const paysAtClose = (row: PromotionRow) =>
  cashbackById.value.get(row.id)?.payoutTiming !== 'ON_THRESHOLD'

async function confirmEnd() {
  const row = endTarget.value
  if (!row) return
  const owesFinalClose = paysAtClose(row)
  ending.value = true
  try {
    await api.fetch(`/admin/cashback/${row.id}/end`, { method: 'POST' })
    toast.add({
      title: 'Ended',
      description: owesFinalClose
        ? `${row.name} stops accruing now — the period in progress still settles at its close`
        : `${row.name} stops paying now`,
      color: 'success',
    })
    endTarget.value = null
    await load()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to end promotion', color: 'error' })
  } finally {
    ending.value = false
  }
}

function menuItems(row: PromotionRow) {
  if (row.kind === PromoKind.WELCOME) {
    return [[{ label: 'Edit amount in Settings', icon: 'i-heroicons:cog-6-tooth', to: '/settings/features' }]]
  }

  const items: any[] = []
  if (row.kind === PromoKind.CASHBACK) {
    items.push({ label: 'Open detail', icon: 'i-heroicons:arrow-top-right-on-square', onSelect: () => openRow(row) })
  }
  if (row.status !== 'ended') {
    const paused = row.status === 'paused'
    items.push({
      label: paused ? 'Resume' : 'Pause',
      icon: paused ? 'i-heroicons:play' : 'i-heroicons:pause',
      onSelect: () => toggle(row),
    })
  }
  if (row.kind === PromoKind.CASHBACK && row.status !== 'ended') {
    items.push({ label: 'End now', icon: 'i-heroicons:stop-circle', color: 'error', onSelect: () => { endTarget.value = row } })
  }
  return [items]
}

/* ── New promotion ──────────────────────────────────────────────────────── */

const showCreate = ref(false)
const createKind = ref<'CASHBACK' | 'DEPOSIT_RULE'>('CASHBACK')
const creating = ref(false)

const createTitle = computed(() =>
  createKind.value === 'CASHBACK' ? 'New cashback promotion' : 'New deposit bonus rule',
)

/* Cashback form (carried over from the retired /cashback page) */

const cashbackForm = reactive({
  name: '',
  lossThreshold: 500,
  refundType: 'PERCENTAGE' as 'PERCENTAGE' | 'FIXED',
  refundValue: 10,
  frequency: 'WEEKLY' as 'DAILY' | 'WEEKLY' | 'MONTHLY',
  startsAt: '',
  endsAt: '',
})

const templates = ref<any[]>([])
const providers = ref<any[]>([])
const selectedTemplateIds = ref<string[]>([])
const providerGameQuery = ref('')
const providerGameResults = ref<any[]>([])
const selectedProviderGames = ref<Array<{ providerId: string; gameCode: string; gameName: string }>>([])
const loadingProviderGames = ref(false)
let providerGameSearchTimer: ReturnType<typeof setTimeout> | undefined
// Same guard as refreshProjection below: a slow answer for "star" landing after
// a fast one for "starburst" would repopulate the list with games the admin is
// no longer looking at, and they tick one they never searched for.
let providerGameToken = 0

const primaryProvider = computed(() => providers.value.find((p: any) => p.isPrimary) ?? providers.value[0] ?? null)

const refundTypeOptions = [
  { label: 'Percentage of loss', value: 'PERCENTAGE' },
  { label: 'Fixed amount (ETB)', value: 'FIXED' },
]

const frequencyOptions = [
  { label: 'Daily', value: 'DAILY' },
  { label: 'Weekly', value: 'WEEKLY' },
  { label: 'Monthly', value: 'MONTHLY' },
]

const refundValueLabel = computed(() =>
  cashbackForm.refundType === 'PERCENTAGE' ? 'Refund Percentage (%)' : 'Refund Amount (ETB)'
)

function onProviderGameSearch() {
  if (providerGameSearchTimer) clearTimeout(providerGameSearchTimer)
  providerGameSearchTimer = setTimeout(async () => {
    if (!primaryProvider.value) return
    const token = ++providerGameToken
    loadingProviderGames.value = true
    try {
      const res = await getProviderGames(primaryProvider.value.code, { search: providerGameQuery.value, limit: 20 })
      if (token === providerGameToken) providerGameResults.value = (res as any)?.data ?? []
    } catch {
      // Stale results under a new query read as "these are your matches", so
      // they go — and the failure is said out loud rather than left as an
      // unhandled rejection behind an empty list.
      if (token === providerGameToken) {
        providerGameResults.value = []
        toast.add({ title: 'Error', description: 'Failed to search provider games', color: 'error' })
      }
    } finally {
      if (token === providerGameToken) loadingProviderGames.value = false
    }
  }, 300)
}

function isProviderGameSelected(game: any) {
  return selectedProviderGames.value.some((g) => g.providerId === game.providerId && g.gameCode === game.gameCode)
}

function toggleProviderGame(game: any) {
  const idx = selectedProviderGames.value.findIndex((g) => g.providerId === game.providerId && g.gameCode === game.gameCode)
  if (idx >= 0) selectedProviderGames.value.splice(idx, 1)
  else selectedProviderGames.value.push({ providerId: game.providerId, gameCode: game.gameCode, gameName: game.gameName })
}

async function createCashback() {
  if (!cashbackForm.name.trim() || !cashbackForm.startsAt || !cashbackForm.endsAt) {
    toast.add({ title: 'Missing fields', description: 'Name, Period Start and Period End are required', color: 'error' })
    return
  }
  creating.value = true
  try {
    await createCashbackPromotion({
      name: cashbackForm.name,
      lossThreshold: cashbackForm.lossThreshold,
      refundType: cashbackForm.refundType,
      refundValue: cashbackForm.refundValue,
      frequency: cashbackForm.frequency,
      startsAt: new Date(cashbackForm.startsAt).toISOString(),
      endsAt: new Date(cashbackForm.endsAt).toISOString(),
      templateIds: selectedTemplateIds.value,
      providerGameKeys: selectedProviderGames.value.map((g) => `${g.providerId}:${g.gameCode}`),
    })
    toast.add({ title: 'Created', description: 'Cashback promotion created', color: 'success' })
    showCreate.value = false
    cashbackForm.name = ''
    cashbackForm.lossThreshold = 500
    cashbackForm.refundType = 'PERCENTAGE'
    cashbackForm.refundValue = 10
    cashbackForm.frequency = 'WEEKLY'
    cashbackForm.startsAt = ''
    cashbackForm.endsAt = ''
    selectedTemplateIds.value = []
    selectedProviderGames.value = []
    providerGameQuery.value = ''
    providerGameResults.value = []
    await load()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to create', color: 'error' })
  } finally {
    creating.value = false
  }
}

/* Deposit bonus rule form (carried over from the retired /bonus-rules page) */

const ruleForm = reactive({
  name: '',
  type: 'DAILY_DEPOSIT' as 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT',
  threshold: 500,
  rewardType: 'FIXED' as 'FIXED' | 'PERCENTAGE',
  rewardValue: 50,
  maxReward: null as number | null,
  validityHours: 24,
  startsAt: '',
  endsAt: '',
  segmentId: '',
})

const segments = ref<any[]>([])
const projecting = ref(false)
const projectedCount = ref<number | null>(null)

const typeOptions = [
  { label: 'Daily deposit', value: 'DAILY_DEPOSIT' },
  { label: 'Weekly deposit', value: 'WEEKLY_DEPOSIT' },
]

const rewardTypeOptions = [
  { label: 'Fixed amount (ETB)', value: 'FIXED' },
  { label: 'Percentage of bucket total', value: 'PERCENTAGE' },
]

const rewardValueLabel = computed(() =>
  ruleForm.rewardType === 'PERCENTAGE' ? 'Reward Percentage (%)' : 'Reward Amount (ETB)'
)

const segmentOptions = computed(() => [
  { label: 'All players (no targeting)', value: '' },
  ...segments.value.map((s: any) => ({ label: s.name, value: s.id })),
])

// FIXED rewards always have a known per-player ceiling; PERCENTAGE rewards
// only do when maxReward is set — otherwise there is no worst case to show.
const maxPerPlayer = computed<number | null>(() =>
  ruleForm.rewardType === 'FIXED' ? ruleForm.rewardValue : (ruleForm.maxReward ?? null)
)

const maxExposure = computed<number | null>(() => {
  // Zero matched players means zero exposure no matter the per-player cap —
  // "uncapped" only describes the unknown ceiling on an amount that can occur.
  if (projectedCount.value === 0) return 0
  return projectedCount.value !== null && maxPerPlayer.value !== null
    ? projectedCount.value * maxPerPlayer.value
    : null
})

// Guards against out-of-order responses: if the admin switches segments while
// a count request is still in flight, only the response for the *latest*
// selected segment is allowed to write into projectedCount/projecting.
let projectionToken = 0

async function refreshProjection() {
  const token = ++projectionToken
  if (!ruleForm.segmentId) {
    projectedCount.value = null
    return
  }
  const seg = segments.value.find((s: any) => s.id === ruleForm.segmentId)
  if (!seg) {
    projectedCount.value = null
    return
  }
  projecting.value = true
  try {
    const res = await countSegmentRules(seg.rules)
    if (token === projectionToken) projectedCount.value = res.count
  } catch {
    if (token === projectionToken) projectedCount.value = null
  } finally {
    if (token === projectionToken) projecting.value = false
  }
}

watch(() => ruleForm.segmentId, refreshProjection)

async function createRule() {
  if (!ruleForm.name.trim() || !ruleForm.startsAt || !ruleForm.endsAt) {
    toast.add({ title: 'Missing fields', description: 'Name, Period Start and Period End are required', color: 'error' })
    return
  }
  creating.value = true
  try {
    await createBonusRule({
      name: ruleForm.name,
      type: ruleForm.type,
      threshold: ruleForm.threshold,
      rewardType: ruleForm.rewardType,
      rewardValue: ruleForm.rewardValue,
      maxReward: ruleForm.rewardType === 'PERCENTAGE' ? ruleForm.maxReward : null,
      validityHours: ruleForm.validityHours,
      startsAt: new Date(ruleForm.startsAt).toISOString(),
      endsAt: new Date(ruleForm.endsAt).toISOString(),
      segmentId: ruleForm.segmentId || null,
    })
    toast.add({ title: 'Created', description: 'Bonus rule created', color: 'success' })
    showCreate.value = false
    ruleForm.name = ''
    ruleForm.threshold = 500
    ruleForm.rewardType = 'FIXED'
    ruleForm.rewardValue = 50
    ruleForm.maxReward = null
    ruleForm.validityHours = 24
    ruleForm.startsAt = ''
    ruleForm.endsAt = ''
    ruleForm.segmentId = ''
    projectedCount.value = null
    await load()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to create', color: 'error' })
  } finally {
    creating.value = false
  }
}

const submitCreate = () => (createKind.value === 'CASHBACK' ? createCashback() : createRule())

async function fetchFormOptions() {
  const [t, p, s] = await Promise.all([
    getGameTemplates().catch(() => [] as any[]),
    getProviders().catch(() => [] as any[]),
    getSegments().catch(() => [] as any[]),
  ])
  templates.value = (t as any[]) ?? []
  providers.value = (p as any[]) ?? []
  segments.value = (s as any[]) ?? []
}

onMounted(() => {
  load()
  fetchReconciliation()
  fetchFormOptions()
})
</script>

<template>
  <div class="promo-page">
    <!-- header -->
    <div class="page-head">
      <div>
        <h1 class="page-title">Promotions</h1>
        <p class="page-sub">Every player offer in one place — welcome bonus, deposit rules and cashback</p>
      </div>
      <UButton icon="i-heroicons:plus" label="New Promotion" color="primary" class="h-11 px-4" @click="showCreate = true" />
    </div>

    <!-- summary tiles -->
    <div v-if="summary" class="tiles">
      <div class="admin-card tile">
        <span class="tile-label">Paid this week</span>
        <span class="tile-value">{{ money(summary.paidThisWeek) }} <span class="tile-unit">ETB</span></span>
      </div>
      <div class="admin-card tile">
        <span class="tile-label">Paid all time</span>
        <span class="tile-value">{{ money(summary.paidAllTime) }} <span class="tile-unit">ETB</span></span>
      </div>
      <div class="admin-card tile">
        <span class="tile-label">Players reached</span>
        <span class="tile-value">{{ money(summary.playersReached) }}</span>
      </div>
      <div class="admin-card tile tile--liability">
        <span class="tile-label">Outstanding liability</span>
        <span class="tile-value tile-value--accent">{{ money(summary.outstandingLiability) }} <span class="tile-unit">ETB</span></span>
      </div>
    </div>

    <!-- health strip -->
    <div class="admin-card strip" :class="reconciliationBorderClass">
      <div class="strip-facts">
        <div class="strip-fact">
          <UIcon
            :name="reconciliationIcon"
            class="w-[17px] h-[17px]"
            :class="[reconciliationIconColor, { 'animate-spin': reconciliationStatus === 'checking' }]"
          />
          <span>{{ reconciliationMessage }}</span>
        </div>
        <div class="strip-rule" />
        <div class="strip-fact">
          <UIcon name="i-heroicons:clock" class="w-[17px] h-[17px] text-white/55" />
          <span>
            Next cashback close
            <strong v-if="nextCashbackClose">{{ nextCashbackClose }}</strong>
            <strong v-else>— no live cashback</strong>
          </span>
        </div>
        <div class="strip-rule" />
        <div class="strip-fact">
          <UIcon name="i-heroicons:globe-alt" class="w-[17px] h-[17px] text-white/55" />
          <span>Windows run on <strong>Africa/Addis_Ababa</strong></span>
        </div>
      </div>
      <UButton
        variant="ghost"
        color="neutral"
        icon="i-heroicons:arrow-path"
        label="Re-check"
        class="h-11 px-3 shrink-0"
        :loading="reconciling"
        @click="fetchReconciliation"
      />
    </div>
    <div v-if="reconciliationStatus === 'drift'" class="drift-list">
      <div v-for="m in mismatches" :key="m.userId" class="drift-row">
        <span>{{ m.userId }}</span>
        <span>wallet: {{ m.cachedBalance.toFixed(2) }} · lots: {{ m.lotSum.toFixed(2) }}</span>
      </div>
    </div>

    <!-- filter tabs -->
    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        class="tab"
        :class="{ 'tab--on': tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }} <span class="tab-count">{{ t.count }}</span>
      </button>
    </div>

    <div v-if="loading" class="state">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" /> Loading...
    </div>

    <div v-else-if="loadFailed" class="admin-card state state--error">
      <p>Could not load promotions.</p>
      <UButton color="neutral" variant="outline" icon="i-heroicons:arrow-path" class="h-11 px-4 mt-3" label="Retry" @click="load()" />
    </div>

    <div v-else-if="!visibleRows.length" class="admin-card state">
      <UIcon name="i-heroicons:gift" class="w-12 h-12 mx-auto mb-3 opacity-20" />
      <p>{{ emptyMessage }}</p>
    </div>

    <!-- table -->
    <div v-else class="admin-card table-wrap">
      <table class="admin-table promo-table">
        <thead>
          <tr>
            <th>Promotion</th>
            <th>Status</th>
            <th>Reward</th>
            <th>Audience</th>
            <th class="num">Paid this week</th>
            <th class="num">Total paid</th>
            <th class="num">Payouts</th>
            <th class="center">Artwork</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in visibleRows"
            :key="`${row.kind}:${row.id}`"
            :class="{ 'row--clickable': row.kind === PromoKind.CASHBACK, 'row--dim': row.status === 'ended' }"
            :tabindex="row.kind === PromoKind.CASHBACK ? 0 : undefined"
            @click="openRow(row)"
            @keydown.enter="openRow(row)"
            @keydown.space.prevent="openRow(row)"
          >
            <td>
              <div class="promo-cell">
                <div class="promo-icon" :class="`promo-icon--${row.kind.toLowerCase()}`">
                  <UIcon :name="KIND_ICON[row.kind] ?? 'i-heroicons:gift'" class="w-4 h-4" />
                </div>
                <div class="promo-names">
                  <span class="promo-name">{{ row.name }}</span>
                  <span class="promo-type">{{ typeLine(row) }}</span>
                </div>
              </div>
            </td>
            <td><span class="status-tag" :class="STATUS_TAG[row.status]">{{ statusLabel(row) }}</span></td>
            <td>
              <div class="reward-cell">
                <span>{{ row.rewardSummary }}</span>
                <span v-if="isUncapped(row)" class="status-tag status-tag--warning">No cap</span>
              </div>
            </td>
            <td>
              <span v-if="isSegmented(row)" class="status-tag tag-info">{{ row.audience }}</span>
              <span v-else class="secondary">{{ row.audience }}</span>
            </td>
            <td class="num">{{ figure(row.paidThisWeek) }}</td>
            <td class="num secondary">{{ figure(row.totalPaid) }}</td>
            <td class="num secondary">{{ figure(row.payoutCount) }}</td>
            <td class="center">
              <img
                v-if="artworkFor(row)"
                class="thumb"
                :src="artworkFor(row)!.imageUrl"
                :alt="artworkFor(row)!.altText || `${row.name} promo tile`"
                width="60"
                height="20"
              >
              <span v-else-if="!artworkLoaded && row.hasArtwork" class="status-tag status-tag--neutral">Uploaded</span>
              <span v-else class="status-tag status-tag--neutral">Generated</span>
            </td>
            <td class="center" @click.stop>
              <UDropdownMenu :items="menuItems(row)" :content="{ align: 'end' }">
                <button type="button" class="kebab" :aria-label="`Actions for ${row.name}`">
                  <UIcon name="i-heroicons:ellipsis-vertical" class="w-4 h-4" />
                </button>
              </UDropdownMenu>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- New promotion -->
    <UModal v-model:open="showCreate" :title="createTitle" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <div class="kind-switch">
            <button
              type="button"
              class="kind-btn"
              :class="{ 'kind-btn--on': createKind === 'CASHBACK' }"
              @click="createKind = 'CASHBACK'"
            >
              Cashback
            </button>
            <button
              type="button"
              class="kind-btn"
              :class="{ 'kind-btn--on': createKind === 'DEPOSIT_RULE' }"
              @click="createKind = 'DEPOSIT_RULE'"
            >
              Deposit bonus
            </button>
          </div>

          <!-- Cashback -->
          <template v-if="createKind === 'CASHBACK'">
            <UFormField label="Name">
              <UInput v-model="cashbackForm.name" placeholder="Weekend Cashback" class="w-full" />
            </UFormField>
            <UFormField label="Loss Threshold (ETB)">
              <UInput v-model.number="cashbackForm.lossThreshold" type="number" min="1" class="w-full" />
            </UFormField>
            <UFormField label="Refund Type">
              <USelect v-model="cashbackForm.refundType" :items="refundTypeOptions" value-key="value" label-key="label" class="w-full" />
            </UFormField>
            <UFormField :label="refundValueLabel">
              <UInput v-model.number="cashbackForm.refundValue" type="number" min="0.01" class="w-full" />
            </UFormField>
            <UFormField label="Frequency">
              <USelect v-model="cashbackForm.frequency" :items="frequencyOptions" value-key="value" label-key="label" class="w-full" />
            </UFormField>
            <UFormField label="Bingo Templates (optional — leave empty for site-wide)">
              <div class="pick-list">
                <label v-for="t in templates" :key="t.id" class="pick-row">
                  <input v-model="selectedTemplateIds" type="checkbox" :value="t.id" class="accent-primary-500">
                  {{ t.title }}
                </label>
                <p v-if="!templates.length" class="pick-empty">No templates found</p>
              </div>
            </UFormField>
            <UFormField label="Provider Games (optional)">
              <UInput v-model="providerGameQuery" placeholder="Search provider games..." class="w-full mb-2" @input="onProviderGameSearch" />
              <div class="pick-list">
                <p v-if="loadingProviderGames" class="pick-empty">Searching...</p>
                <label v-for="g in providerGameResults" :key="`${g.providerId}-${g.gameCode}`" class="pick-row">
                  <input type="checkbox" :checked="isProviderGameSelected(g)" class="accent-primary-500" @change="toggleProviderGame(g)">
                  {{ g.gameName }}
                </label>
              </div>
              <div v-if="selectedProviderGames.length" class="flex flex-wrap gap-1 mt-2">
                <UBadge v-for="g in selectedProviderGames" :key="`${g.providerId}-${g.gameCode}`" color="primary" variant="soft" :label="g.gameName" />
              </div>
            </UFormField>
            <UFormField label="Period Start">
              <UInput v-model="cashbackForm.startsAt" type="datetime-local" class="w-full" />
            </UFormField>
            <UFormField label="Period End">
              <UInput v-model="cashbackForm.endsAt" type="datetime-local" class="w-full" />
            </UFormField>
          </template>

          <!-- Deposit bonus rule -->
          <template v-else>
            <UFormField label="Name">
              <UInput v-model="ruleForm.name" placeholder="Daily 500 bonus" class="w-full" />
            </UFormField>
            <UFormField label="Type">
              <USelect v-model="ruleForm.type" :items="typeOptions" value-key="value" label-key="label" class="w-full" />
            </UFormField>
            <UFormField label="Target Segment">
              <USelect v-model="ruleForm.segmentId" :items="segmentOptions" value-key="value" label-key="label" class="w-full" />
            </UFormField>
            <div v-if="ruleForm.segmentId" class="projection">
              <div v-if="projecting" class="secondary">Calculating…</div>
              <template v-else-if="projectedCount !== null">
                <div class="projection-row"><span>Matching players</span><strong>{{ projectedCount.toLocaleString() }}</strong></div>
                <div class="projection-row">
                  <span>Max reward per player</span>
                  <strong>{{ maxPerPlayer !== null ? `${maxPerPlayer} ETB` : 'uncapped' }}</strong>
                </div>
                <div class="projection-row">
                  <span>Max exposure per period</span>
                  <strong>{{ maxExposure !== null ? `${maxExposure.toLocaleString()} ETB` : 'uncapped' }}</strong>
                </div>
                <p v-if="projectedCount === 0" class="projection-warn">This segment matches no players — the rule could never pay anyone.</p>
                <p v-else class="projection-note">Worst case: assumes every matched player crosses the threshold in the same period.</p>
              </template>
            </div>
            <UFormField label="Threshold (ETB)">
              <UInput v-model.number="ruleForm.threshold" type="number" min="1" class="w-full" />
            </UFormField>
            <UFormField label="Reward Type">
              <USelect v-model="ruleForm.rewardType" :items="rewardTypeOptions" value-key="value" label-key="label" class="w-full" />
            </UFormField>
            <UFormField :label="rewardValueLabel">
              <UInput v-model.number="ruleForm.rewardValue" type="number" min="0.01" class="w-full" />
            </UFormField>
            <UFormField v-if="ruleForm.rewardType === 'PERCENTAGE'" label="Max Reward (ETB, optional)">
              <UInput v-model.number="ruleForm.maxReward" type="number" min="0" class="w-full" />
            </UFormField>
            <UFormField label="Validity (hours)">
              <UInput v-model.number="ruleForm.validityHours" type="number" min="1" max="2160" class="w-full" />
            </UFormField>
            <UFormField label="Period Start">
              <UInput v-model="ruleForm.startsAt" type="datetime-local" class="w-full" />
            </UFormField>
            <UFormField label="Period End">
              <UInput v-model="ruleForm.endsAt" type="datetime-local" class="w-full" />
            </UFormField>
          </template>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" label="Cancel" class="h-11 px-4" @click="showCreate = false" />
          <UButton color="primary" :loading="creating" label="Create" class="h-11 px-4" @click="submitCreate" />
        </div>
      </template>
    </UModal>

    <!-- End confirmation: endsAt moves to now and isActive is deliberately left
         alone, so the window the promotion was ended inside still settles at its
         close. The move itself has no undo — a closed window cannot be reopened
         through the toggle. -->
    <UModal :open="endTarget !== null" title="End promotion" :ui="{ footer: 'justify-end' }" @update:open="(open: boolean) => { if (!open) endTarget = null }">
      <template #body>
        <p class="secondary">
          {{ endTarget?.name }} stops accruing at this instant: its window closes now, and no period
          opening later can ever settle.
          <template v-if="endTarget && paysAtClose(endTarget)">
            The play up to now is already earned, so the period in progress still settles at its close —
            after that this promotion never pays again.
          </template>
          <template v-else>
            It pays as players cross the threshold, so nothing further is paid.
          </template>
          There is no undo.
        </p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" label="Cancel" class="h-11 px-4" :disabled="ending" @click="endTarget = null" />
        <UButton color="error" icon="i-heroicons:stop-circle" label="End now" class="h-11 px-4" :loading="ending" @click="confirmEnd" />
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.promo-page { display: flex; flex-direction: column; gap: 20px; max-width: 1180px; }

.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.page-title { font-size: 24px; font-weight: 700; letter-spacing: -0.01em; color: var(--text-primary); }
.page-sub { margin-top: 3px; font-size: 14px; font-weight: 500; color: rgba(255, 255, 255, 0.55); }

/* ── Summary tiles ─────────────────────────────────────────────────────── */
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.tile { padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.tile--liability { border-color: rgba(245, 166, 35, 0.3); }
.tile-label {
  font-family: var(--font-ui); font-size: 12px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55);
}
.tile-value {
  font-family: var(--font-ui); font-size: 23px; font-weight: 700; line-height: 1;
  color: var(--text-primary); font-variant-numeric: tabular-nums;
}
.tile-value--accent { color: var(--brand-primary); }
.tile-unit { font-size: 13px; color: rgba(255, 255, 255, 0.55); }

/* ── Health strip ──────────────────────────────────────────────────────── */
.strip { padding: 13px 16px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.strip--drift { border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.05); }
.strip--error { border-color: rgba(245, 166, 35, 0.4); background: rgba(245, 166, 35, 0.05); }
.strip-facts { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.strip-fact { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--text-secondary); }
.strip-fact strong { color: var(--text-primary); font-weight: 600; }
.strip-rule { width: 1px; height: 20px; background: var(--surface-border); }

.drift-list { border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 12px; overflow: hidden; }
.drift-row {
  display: flex; justify-content: space-between; gap: 12px;
  padding: 8px 16px; font-size: 12px; color: var(--text-secondary);
  border-bottom: 1px solid rgba(239, 68, 68, 0.1);
}
.drift-row:last-child { border-bottom: none; }

/* ── Filter tabs ───────────────────────────────────────────────────────── */
.tabs { display: flex; gap: 6px; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.09); }
.tab {
  font-family: var(--font-ui); min-height: 44px; padding: 9px 14px;
  font-size: 13px; font-weight: 600; letter-spacing: 0.03em;
  color: rgba(255, 255, 255, 0.62); background: none; border: none;
  border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer;
}
.tab:hover { color: var(--text-primary); }
.tab--on { color: var(--brand-primary); font-weight: 700; border-bottom-color: var(--brand-primary); }
.tab-count { color: rgba(255, 255, 255, 0.55); font-weight: 600; }
.tab--on .tab-count { color: rgba(255, 255, 255, 0.62); }

/* ── States ────────────────────────────────────────────────────────────── */
.state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 56px 20px; font-size: 14px; color: rgba(255, 255, 255, 0.55); text-align: center;
}
.state--error { color: #f87171; }

/* ── Table ─────────────────────────────────────────────────────────────── */
.table-wrap { overflow: hidden; }
/* The shared thead grey is rgba(255,255,255,0.4), below the contrast floor for
   these surfaces — every other rule here is inherited from .admin-table. */
.promo-table thead th { color: rgba(255, 255, 255, 0.55); }
.promo-table th.center, .promo-table td.center { text-align: center; }
.promo-table .secondary { color: var(--text-secondary); }

.row--clickable { cursor: pointer; }
.row--clickable:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: -2px; }
.row--dim .promo-name { color: rgba(255, 255, 255, 0.55); }

.promo-cell { display: flex; align-items: center; gap: 11px; }
.promo-icon {
  width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.55);
}
.promo-icon--welcome { background: rgba(245, 166, 35, 0.14); color: var(--brand-primary); }
.promo-icon--cashback { background: rgba(6, 182, 212, 0.14); color: #22d3ee; }
.promo-icon--deposit_rule { background: rgba(59, 130, 246, 0.14); color: #60a5fa; }
.promo-icon--referral { background: rgba(168, 85, 247, 0.14); color: #c084fc; }

.promo-names { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.promo-name { font-family: var(--font-ui); font-size: 14px; font-weight: 700; color: var(--text-primary); }
.promo-type { font-size: 12.5px; color: rgba(255, 255, 255, 0.55); }

.reward-cell { display: flex; align-items: center; gap: 7px; color: var(--text-secondary); }

/* Nuxt UI has no info tone in .status-tag; the design uses blue for a window
   that has not opened yet and for a segment badge. */
.tag-info { color: #60a5fa; background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.26); }

.thumb {
  display: block; width: 60px; height: 20px; margin: 0 auto;
  border-radius: 4px; object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.16); background: var(--surface-overlay);
}

.kebab {
  width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 8px; color: rgba(255, 255, 255, 0.55); background: none; border: none; cursor: pointer;
}
.kebab:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.05); }

/* ── Create modal ──────────────────────────────────────────────────────── */
.kind-switch {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 4px;
  border: 1px solid var(--surface-border); border-radius: 10px; background: var(--surface-base);
}
.kind-btn {
  font-family: var(--font-ui); min-height: 44px; border-radius: 7px; border: none;
  font-size: 13px; font-weight: 600; letter-spacing: 0.03em;
  color: var(--text-secondary); background: none; cursor: pointer;
}
.kind-btn--on { color: #12203a; background: var(--brand-primary); font-weight: 700; }

.pick-list {
  display: flex; flex-direction: column; gap: 4px; max-height: 128px; overflow-y: auto;
  border: 1px solid var(--surface-border); border-radius: 8px; padding: 8px;
}
.pick-row { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: 13px; color: var(--text-secondary); }
.pick-empty { font-size: 12px; color: rgba(255, 255, 255, 0.55); }

.projection {
  display: flex; flex-direction: column; gap: 4px;
  border: 1px solid var(--surface-border); border-radius: 12px; padding: 12px; font-size: 13px;
}
.projection-row { display: flex; justify-content: space-between; gap: 12px; color: rgba(255, 255, 255, 0.55); }
.projection-row strong { color: var(--text-primary); font-weight: 500; }
.projection-warn { padding-top: 4px; color: #f87171; }
.projection-note { padding-top: 4px; font-size: 12px; color: rgba(255, 255, 255, 0.55); }

.secondary { color: var(--text-secondary); font-size: 13px; }

@media (max-width: 900px) {
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .strip { flex-direction: column; align-items: flex-start; }
  .table-wrap { overflow-x: auto; }
}
</style>
