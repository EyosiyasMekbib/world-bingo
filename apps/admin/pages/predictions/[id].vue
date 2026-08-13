<script setup lang="ts">
/**
 * One prediction market: the book on both sides, the tape, who holds what, and
 * the lifecycle actions that are legal right now.
 *
 * THE NUMBER THIS PAGE EXISTS FOR is the payout obligation per outcome — the
 * shares held on a side multiplied by the market's own `shareValue`, i.e. what
 * the book owes if that side wins. On a solvent book each side's obligation
 * equals the escrow held, because losers' escrow funds winners exactly. Showing
 * both side by side makes a breach visible without reading a log. The
 * multiplication is done server-side in `Prisma.Decimal`; this page renders the
 * string it is given and never recomputes it in JS.
 *
 * MONEY IS NEVER A FLOAT HERE. Amounts arrive as decimal strings and are
 * formatted as strings; the only comparison of two amounts converts both to
 * exact integer minor units with BigInt. `toWholeBirr` reads whole birr out of a
 * price by inspecting the text, and refuses anything fractional.
 *
 * RESOLVE AND VOID REQUIRE TYPED CONFIRMATION. Resolving names the winner and
 * schedules an irreversible payout; voiding refunds the entire book. Both are
 * gated on the operator typing the outcome label — or the word VOID — exactly.
 * While RESOLVING, the dispute countdown runs on screen and unresolve stays
 * available until it expires, which is the whole mitigation for a miscall on a
 * third-party event with no result feed.
 */
import { toWholeBirr } from '@world-bingo/shared-types'
import type {
  PredictionFillDto,
  PredictionMarketDto,
  PredictionOutcomeDto,
  PredictionPositionDto,
} from '@world-bingo/shared-types'

definePageMeta({ layout: 'default' })

type Market = PredictionMarketDto & { outcomes: PredictionOutcomeDto[] }
type BookLevel = { price: string; shares: number }
type BookSide = { outcomeId: string; lastPrice: string | null; levels: BookLevel[] }
type Book = {
  marketId: string
  shareValue: string
  outcomes: BookSide[]
  fills: PredictionFillDto[]
}
type OutcomeSummary = {
  outcomeId: string
  label: string
  sortOrder: number
  holders: number
  shares: number
  obligation: string
  costBasisReal: string
  costBasisBonus: string
  payout: string
  feePaid: string
}
type PositionRow = PredictionPositionDto & {
  outcome: { id: string; label: string; sortOrder: number } | null
  user: { id: string; username: string | null; phone: string | null } | null
}
type PositionsResponse = {
  marketId: string
  shareValue: string
  totalShares: number
  totalVolume: string
  outcomes: OutcomeSummary[]
  positions: PositionRow[]
  nextCursor: string | null
}

const route = useRoute()
const router = useRouter()
const { apiFetch } = useAdminAuth()
const toast = useToast()

const id = route.params.id as string

const market = ref<Market | null>(null)
const book = ref<Book | null>(null)
const positions = ref<PositionsResponse | null>(null)
const positionRows = ref<PositionRow[]>([])
const loading = ref(true)
const busy = ref(false)
const loadingMorePositions = ref(false)

// ── Formatting ──────────────────────────────────────────────────────────────

/** Group a decimal-string amount. String work: money must not touch a float. */
function money(value: string | null | undefined, dp = 2): string {
  if (value === null || value === undefined || value === '') return '—'
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const decimals = dp > 0 ? `.${(fraction + '0'.repeat(dp)).slice(0, dp)}` : ''
  return `${negative ? '-' : ''}${grouped}${decimals}`
}

/** A decimal string as an exact integer count of minor units. */
function toMinor(value: string, dp = 2): bigint {
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const scale = BigInt(10) ** BigInt(dp)
  const minor = BigInt(whole || '0') * scale + BigInt((fraction + '0'.repeat(dp)).slice(0, dp) || '0')
  return negative ? -minor : minor
}

/** Integer minor units back out as a decimal string. */
function fromMinor(total: bigint, dp = 2): string {
  const scale = BigInt(10) ** BigInt(dp)
  const negative = total < BigInt(0)
  const abs = negative ? -total : total
  return `${negative ? '-' : ''}${abs / scale}.${(abs % scale).toString().padStart(dp, '0')}`
}

/** Exact sum of decimal strings, back out as a decimal string. */
function sumMoney(values: string[], dp = 2): string {
  let total = BigInt(0)
  for (const value of values) total += toMinor(value, dp)
  return fromMinor(total, dp)
}

/**
 * Exact `amount × whole count` — the payout arithmetic of this market. Shares
 * are integers by construction, so this is integer multiplication in minor
 * units, not a float multiply of money.
 */
function scaleMoney(value: string, count: number, dp = 2): string {
  return fromMinor(toMinor(value, dp) * BigInt(Math.trunc(count)), dp)
}

/** `> 0` on a decimal string, without going through a float. */
function isPositive(value: string | null | undefined): boolean {
  return !!value && toMinor(value) > BigInt(0)
}

/** Percentages carry trailing zeroes from a Decimal(5,2); drop them. */
function percent(value: string | null | undefined): string {
  if (!value) return '0'
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value
}

/**
 * Price as a probability, against this market's own share value. At the default
 * 100 ETB share the two are the same number — never assume that.
 */
function pricePct(price: string | null | undefined): number | null {
  if (!price || !market.value) return null
  try {
    const share = toWholeBirr(market.value.shareValue)
    if (share <= 0) return null
    return Math.round((toWholeBirr(price) * 100) / share)
  } catch {
    return null
  }
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function statusColor(status: string): 'primary' | 'success' | 'warning' | 'info' | 'error' | 'neutral' {
  switch (status) {
    case 'DRAFT': return 'neutral'
    case 'OPEN': return 'success'
    case 'CLOSED': return 'warning'
    case 'RESOLVING': return 'info'
    case 'SETTLED': return 'primary'
    case 'VOIDED': return 'error'
    default: return 'neutral'
  }
}

function positionColor(status: string): 'success' | 'error' | 'info' | 'neutral' {
  switch (status) {
    case 'WON': return 'success'
    case 'LOST': return 'error'
    case 'REFUNDED': return 'info'
    default: return 'neutral'
  }
}

function trader(row: PositionRow): string {
  return row.user?.username ?? row.user?.phone ?? row.userId.slice(0, 8)
}

// ── Data ────────────────────────────────────────────────────────────────────

async function loadMarket() {
  market.value = await apiFetch<Market>(`/admin/prediction/markets/${id}`)
}

async function loadBook() {
  book.value = await apiFetch<Book>(`/admin/prediction/markets/${id}/book?fills=50`)
}

async function loadPositions() {
  const data = await apiFetch<PositionsResponse>(
    `/admin/prediction/markets/${id}/positions?limit=50`,
  )
  positions.value = data
  positionRows.value = data.positions
}

async function refresh(showSpinner = false) {
  if (showSpinner) loading.value = true
  try {
    await Promise.all([loadMarket(), loadBook(), loadPositions()])
  } catch (err: any) {
    toast.add({
      title: 'Could not load market',
      description: err?.data?.error ?? 'Load failed',
      color: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function loadMorePositions() {
  if (!positions.value?.nextCursor) return
  loadingMorePositions.value = true
  try {
    const data = await apiFetch<PositionsResponse>(
      `/admin/prediction/markets/${id}/positions?limit=50&cursor=${positions.value.nextCursor}`,
    )
    positionRows.value = [...positionRows.value, ...data.positions]
    positions.value = { ...data, positions: positionRows.value }
  } catch (err: any) {
    toast.add({ title: 'Could not load more', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    loadingMorePositions.value = false
  }
}

onMounted(() => refresh(true))

// ── Dispute countdown ───────────────────────────────────────────────────────
//
// The window between naming a winner and the money moving is the only chance to
// take a miscall back, so it ticks on screen rather than sitting as a timestamp
// the operator has to subtract from the clock themselves.

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
let poller: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  // While the payout is pending the status flips on its own when the delayed
  // job runs; poll so the page does not sit on a stale RESOLVING.
  poller = setInterval(() => {
    if (market.value?.status === 'RESOLVING') refresh()
  }, 5000)
})
onUnmounted(() => {
  if (ticker) clearInterval(ticker)
  if (poller) clearInterval(poller)
})

const disputeMsLeft = computed(() => {
  if (!market.value?.disputeUntil) return 0
  return Math.max(0, new Date(market.value.disputeUntil).getTime() - now.value)
})

const disputeOpen = computed(() => market.value?.status === 'RESOLVING' && disputeMsLeft.value > 0)

const disputeCountdown = computed(() => {
  const total = Math.floor(disputeMsLeft.value / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
})

// ── Derived views ───────────────────────────────────────────────────────────

const outcomes = computed(() => market.value?.outcomes ?? [])

const labelById = computed(() => {
  const map = new Map<string, string>()
  for (const outcome of outcomes.value) map.set(outcome.id, outcome.label)
  return map
})

const winningLabel = computed(() =>
  market.value?.winningOutcomeId ? labelById.value.get(market.value.winningOutcomeId) ?? null : null,
)

function sideFor(outcomeId: string): BookSide | null {
  return book.value?.outcomes.find((side) => side.outcomeId === outcomeId) ?? null
}

function summaryFor(outcomeId: string): OutcomeSummary | null {
  return positions.value?.outcomes.find((row) => row.outcomeId === outcomeId) ?? null
}

/** One side's levels with running depth attached. Shares are integers, not money. */
function levelsWithDepth(outcomeId: string): Array<BookLevel & { depth: number }> {
  let running = 0
  return (sideFor(outcomeId)?.levels ?? []).map((level) => {
    running += level.shares
    return { ...level, depth: running }
  })
}

/** Total unfilled shares resting on one side. */
function restingShares(outcomeId: string): number {
  const side = sideFor(outcomeId)
  if (!side) return 0
  return side.levels.reduce((total, level) => total + level.shares, 0)
}

/** The price this fill traded at for a given outcome — read off, never derived. */
function fillPriceFor(fill: PredictionFillDto, outcomeId: string): string {
  return fill.takerOutcomeId === outcomeId ? fill.takerPrice : fill.makerPrice
}

/**
 * Solvency, checked against the escrow actually held. Every matched pair puts
 * exactly one share value in escrow, so a side owing more than the book holds
 * would mean the invariant has been broken somewhere upstream.
 */
const insolventOutcomes = computed(() => {
  if (!market.value || !positions.value) return []
  const escrow = toMinor(market.value.totalVolume)
  return positions.value.outcomes.filter((row) => toMinor(row.obligation) > escrow)
})

/** Cost basis of a position, real plus bonus, summed exactly. */
function basis(row: PositionRow): string {
  return sumMoney([row.costBasisReal, row.costBasisBonus])
}

/** Gross this position is owed if its side wins: shares × the market's share value. */
function payoutIfWins(row: PositionRow): string {
  return market.value ? scaleMoney(market.value.shareValue, row.shares) : '0'
}

// ── Lifecycle actions ───────────────────────────────────────────────────────

const canPublish = computed(() => market.value?.status === 'DRAFT')
const canClose = computed(() => market.value?.status === 'OPEN')
const canResolve = computed(() => market.value?.status === 'CLOSED')
const canUnresolve = computed(() => disputeOpen.value)
const canVoid = computed(
  () => !!market.value && !['SETTLED', 'VOIDED'].includes(market.value.status),
)
const canEdit = computed(
  () => !!market.value && !['SETTLED', 'VOIDED'].includes(market.value.status),
)

const showPublish = ref(false)
const showClose = ref(false)
const showResolve = ref(false)
const showUnresolve = ref(false)
const showVoid = ref(false)
const showEdit = ref(false)

async function act(path: string, body: Record<string, unknown> | undefined, success: string) {
  busy.value = true
  try {
    await apiFetch(`/admin/prediction/markets/${id}${path}`, {
      method: 'POST',
      ...(body ? { body } : {}),
    })
    toast.add({ title: success, color: 'success' })
    await refresh()
    return true
  } catch (err: any) {
    toast.add({ title: 'Action failed', description: err?.data?.error ?? '', color: 'error' })
    return false
  } finally {
    busy.value = false
  }
}

async function doPublish() {
  if (await act('/publish', undefined, 'Market published')) showPublish.value = false
}

async function doClose() {
  if (await act('/close', undefined, 'Market closed')) showClose.value = false
}

async function doUnresolve() {
  if (await act('/unresolve', undefined, 'Resolution reversed')) showUnresolve.value = false
}

// ── Resolve ─────────────────────────────────────────────────────────────────

const resolveOutcomeId = ref<string | null>(null)
const resolveConfirm = ref('')

const resolveOutcome = computed(
  () => outcomes.value.find((outcome) => outcome.id === resolveOutcomeId.value) ?? null,
)

/** Exact match on the label — a speed bump that a misclick cannot clear. */
const resolveReady = computed(
  () => !!resolveOutcome.value && resolveConfirm.value.trim() === resolveOutcome.value.label,
)

function openResolve() {
  resolveOutcomeId.value = null
  resolveConfirm.value = ''
  showResolve.value = true
}

async function doResolve() {
  if (!resolveReady.value || !resolveOutcome.value) return
  if (await act('/resolve', { outcomeId: resolveOutcome.value.id }, 'Market resolved — payout scheduled')) {
    showResolve.value = false
  }
}

// ── Void ────────────────────────────────────────────────────────────────────

const voidReason = ref('')
const voidConfirm = ref('')

const voidReady = computed(
  () => voidReason.value.trim().length >= 3 && voidConfirm.value.trim() === 'VOID',
)

function openVoid() {
  voidReason.value = ''
  voidConfirm.value = ''
  showVoid.value = true
}

async function doVoid() {
  if (!voidReady.value) return
  if (await act('/void', { reason: voidReason.value.trim() }, 'Market voided — everyone refunded')) {
    showVoid.value = false
  }
}

// ── Edit ────────────────────────────────────────────────────────────────────
//
// Once a market is OPEN the terms are frozen and only the description, the image
// and a LATER closing time may change — changing an outcome label or the share
// value while money is escrowed against it is indistinguishable from rigging the
// market. The form disables what the server would reject.

const isDraft = computed(() => market.value?.status === 'DRAFT')

const edit = reactive({
  eventName: '',
  question: '',
  description: '',
  imageUrl: '',
  closesAt: '',
  shareValue: 100,
  feePct: 15,
  minOrderShares: 1,
  maxOrderShares: 10000,
})

/** ISO → the `datetime-local` shape, in the operator's own timezone. */
function toLocalInput(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function openEdit() {
  const current = market.value
  if (!current) return
  edit.eventName = current.eventName
  edit.question = current.question
  edit.description = current.description ?? ''
  edit.imageUrl = current.imageUrl ?? ''
  edit.closesAt = toLocalInput(current.closesAt)
  // Both are only editable while DRAFT. `toWholeBirr` reads the share value as
  // an integer number of birr by inspecting the text — it throws rather than
  // silently truncating if a market somehow carries a fractional denomination.
  try {
    edit.shareValue = toWholeBirr(current.shareValue)
  } catch {
    edit.shareValue = 0
  }
  // The fee percent is a number on the wire by contract (`feePct` is sent as a
  // JSON number with at most two decimals), so the form field has to hold one.
  // Converted through exact integer minor units rather than a string→float parse.
  edit.feePct = Number(toMinor(current.feePct)) / 100
  edit.minOrderShares = current.minOrderShares
  edit.maxOrderShares = current.maxOrderShares
  showEdit.value = true
}

async function saveEdit() {
  const current = market.value
  if (!current) return
  const parsed = new Date(edit.closesAt)
  if (Number.isNaN(parsed.getTime())) {
    toast.add({ title: 'Closing time is not a valid date', color: 'error' })
    return
  }

  // Only send what changed. The server's freeze is value-based, so an unchanged
  // frozen field is not an edit — but sending less keeps the audit entry honest
  // about what the operator actually touched.
  const body: Record<string, unknown> = {}
  if (edit.description.trim() !== (current.description ?? '')) {
    body.description = edit.description.trim() || null
  }
  if (edit.imageUrl.trim() !== (current.imageUrl ?? '')) {
    body.imageUrl = edit.imageUrl.trim() || null
  }
  if (parsed.getTime() !== new Date(current.closesAt).getTime()) {
    body.closesAt = parsed.toISOString()
  }
  if (isDraft.value) {
    if (edit.eventName.trim() !== current.eventName) body.eventName = edit.eventName.trim()
    if (edit.question.trim() !== current.question) body.question = edit.question.trim()
    body.shareValue = Math.trunc(edit.shareValue)
    body.feePct = edit.feePct
    body.minOrderShares = Math.trunc(edit.minOrderShares)
    body.maxOrderShares = Math.trunc(edit.maxOrderShares)
  }

  if (Object.keys(body).length === 0) {
    showEdit.value = false
    return
  }

  busy.value = true
  try {
    await apiFetch(`/admin/prediction/markets/${id}`, { method: 'PATCH', body })
    toast.add({ title: 'Market updated', color: 'success' })
    showEdit.value = false
    await refresh()
  } catch (err: any) {
    toast.add({ title: 'Could not update', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <div v-if="loading" class="flex items-center justify-center py-20 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" />
      Loading market…
    </div>

    <template v-else-if="market">
      <!-- Header + lifecycle actions -->
      <div class="flex items-start justify-between flex-wrap gap-3">
        <div class="flex items-start gap-2 min-w-0">
          <UButton icon="i-heroicons:arrow-left" variant="ghost" color="neutral" to="/predictions" />
          <div class="min-w-0">
            <h1 class="text-2xl font-bold text-white tracking-tight truncate">{{ market.question }}</h1>
            <div class="flex items-center gap-2 mt-1 flex-wrap">
              <span class="text-sm text-white/50 font-medium">{{ market.eventName }}</span>
              <UBadge :color="statusColor(market.status)" variant="soft" size="xs">
                {{ market.status }}
              </UBadge>
              <span v-if="winningLabel" class="text-xs text-emerald-400 font-semibold">
                Winner: {{ winningLabel }}
              </span>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2 flex-wrap shrink-0">
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-heroicons:arrow-path"
            size="sm"
            @click="refresh()"
          />
          <UButton
            v-if="canEdit"
            color="neutral"
            variant="subtle"
            size="sm"
            icon="i-heroicons:pencil-square"
            @click="openEdit"
          >
            Edit
          </UButton>
          <UButton
            v-if="canPublish"
            color="success"
            size="sm"
            icon="i-heroicons:megaphone"
            :loading="busy"
            @click="showPublish = true"
          >
            Publish
          </UButton>
          <UButton
            v-if="canClose"
            color="warning"
            size="sm"
            icon="i-heroicons:lock-closed"
            :loading="busy"
            @click="showClose = true"
          >
            Close book
          </UButton>
          <UButton
            v-if="canResolve"
            color="primary"
            size="sm"
            icon="i-heroicons:check-badge"
            :loading="busy"
            @click="openResolve"
          >
            Resolve
          </UButton>
          <UButton
            v-if="canUnresolve"
            color="info"
            size="sm"
            icon="i-heroicons:arrow-uturn-left"
            :loading="busy"
            @click="showUnresolve = true"
          >
            Unresolve
          </UButton>
          <UButton
            v-if="canVoid"
            color="error"
            variant="subtle"
            size="sm"
            icon="i-heroicons:no-symbol"
            :loading="busy"
            @click="openVoid"
          >
            Void
          </UButton>
        </div>
      </div>

      <!-- Dispute window. Unresolve is available only until this expires. -->
      <UAlert
        v-if="market.status === 'RESOLVING'"
        :color="disputeOpen ? 'info' : 'warning'"
        variant="subtle"
        icon="i-heroicons:clock"
      >
        <template #description>
          <div v-if="disputeOpen" class="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span class="text-base">
              Payout in
              <strong class="tabular-nums font-mono">{{ disputeCountdown }}</strong>
            </span>
            <span class="text-xs">
              Resolved as <strong>{{ winningLabel ?? '—' }}</strong> at {{ when(market.resolvedAt) }}.
              Nothing has moved yet — unresolve until the window closes, after which reversing it
              would mean clawing money back out of wallets.
            </span>
          </div>
          <div v-else class="text-xs">
            The dispute window closed at {{ when(market.disputeUntil) }}. Settlement is running —
            this page will show SETTLED once the payouts commit.
          </div>
        </template>
      </UAlert>

      <UAlert
        v-if="market.status === 'VOIDED'"
        color="error"
        variant="subtle"
        icon="i-heroicons:no-symbol"
      >
        <template #description>
          Voided — every position refunded at cost basis, bonus returned as bonus.
          <span v-if="market.voidReason"> Reason: <strong>{{ market.voidReason }}</strong></span>
        </template>
      </UAlert>

      <UAlert
        v-if="market.status === 'SETTLED'"
        color="success"
        variant="subtle"
        icon="i-heroicons:check-badge"
      >
        <template #description>
          Settled {{ when(market.settledAt) }} — <strong>{{ winningLabel ?? '—' }}</strong> paid
          {{ money(market.shareValue) }} ETB per share, less
          {{ percent(market.feePct) }}% of profit.
        </template>
      </UAlert>

      <!-- Solvency breach: every matched pair escrows exactly one share value,
           so an obligation above the escrow held should be impossible. -->
      <UAlert
        v-if="insolventOutcomes.length"
        color="error"
        variant="solid"
        icon="i-heroicons:exclamation-triangle"
        title="Payout obligation exceeds escrow"
      >
        <template #description>
          {{ insolventOutcomes.map((row) => row.label).join(', ') }} would be owed more than the
          {{ money(market.totalVolume) }} ETB this book holds. Do not resolve — escalate.
        </template>
      </UAlert>

      <!-- Terms -->
      <div class="rounded-2xl border border-(--surface-border) p-5 shadow-lg" style="background:var(--surface-raised);">
        <dl class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-sm">
          <div>
            <dt class="text-[10px] text-white/40 uppercase tracking-widest font-bold">Share value</dt>
            <dd class="text-white font-bold tabular-nums mt-1">{{ money(market.shareValue) }} ETB</dd>
          </div>
          <div>
            <dt class="text-[10px] text-white/40 uppercase tracking-widest font-bold">Fee</dt>
            <dd class="text-white font-bold tabular-nums mt-1">{{ percent(market.feePct) }}% of profit</dd>
          </div>
          <div>
            <dt class="text-[10px] text-white/40 uppercase tracking-widest font-bold">Order size</dt>
            <dd class="text-white font-bold tabular-nums mt-1">
              {{ market.minOrderShares.toLocaleString() }}–{{ market.maxOrderShares.toLocaleString() }}
            </dd>
          </div>
          <div>
            <dt class="text-[10px] text-white/40 uppercase tracking-widest font-bold">Closes</dt>
            <dd class="text-white font-medium mt-1">{{ when(market.closesAt) }}</dd>
          </div>
          <div>
            <dt class="text-[10px] text-white/40 uppercase tracking-widest font-bold">Matched shares</dt>
            <dd class="text-white font-bold tabular-nums mt-1">{{ market.totalShares.toLocaleString() }}</dd>
          </div>
          <div>
            <dt class="text-[10px] text-white/40 uppercase tracking-widest font-bold">Escrow held</dt>
            <dd class="text-yellow-500 font-bold tabular-nums mt-1">{{ money(market.totalVolume) }} ETB</dd>
          </div>
        </dl>
        <p v-if="market.description" class="text-xs text-white/40 mt-4 pt-4 border-t border-white/8">
          {{ market.description }}
        </p>
      </div>

      <!-- Payout obligation per outcome -->
      <div>
        <h2 class="text-sm font-bold text-white uppercase tracking-widest mb-3">
          Payout obligation
        </h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <div
            v-for="outcome in outcomes"
            :key="outcome.id"
            class="rounded-2xl border p-5 shadow-lg"
            :class="market.winningOutcomeId === outcome.id ? 'border-emerald-500/40' : 'border-(--surface-border)'"
            style="background:var(--surface-raised);"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="text-base font-bold text-white truncate">{{ outcome.label }}</div>
                <div class="text-[11px] text-white/40 mt-0.5">
                  {{ (summaryFor(outcome.id)?.holders ?? 0).toLocaleString() }} holders ·
                  {{ (summaryFor(outcome.id)?.shares ?? 0).toLocaleString() }} shares ·
                  {{ restingShares(outcome.id).toLocaleString() }} resting
                </div>
              </div>
              <div class="text-right shrink-0">
                <div class="text-[10px] text-white/40 uppercase tracking-widest font-bold">Last</div>
                <div v-if="sideFor(outcome.id)?.lastPrice" class="text-white font-bold tabular-nums">
                  {{ money(sideFor(outcome.id)!.lastPrice, 0) }}
                  <span class="text-xs text-white/40">
                    ETB ({{ pricePct(sideFor(outcome.id)!.lastPrice) }}%)
                  </span>
                </div>
                <div v-else class="text-white/25 text-sm">no trades</div>
              </div>
            </div>

            <!-- What the book owes if this side wins: shares × shareValue. -->
            <div class="mt-4 pt-4 border-t border-white/8">
              <div class="text-[10px] text-white/40 uppercase tracking-widest font-bold">
                Owed if {{ outcome.label }} wins
              </div>
              <div class="text-2xl font-bold text-yellow-500 tabular-nums tracking-tight mt-1">
                {{ money(summaryFor(outcome.id)?.obligation) }}
                <span class="text-[11px] text-white/40 font-medium">ETB</span>
              </div>
              <div class="text-[11px] text-white/35 mt-1">
                {{ (summaryFor(outcome.id)?.shares ?? 0).toLocaleString() }} shares ×
                {{ money(market.shareValue) }} ETB · against {{ money(market.totalVolume) }} ETB escrowed
              </div>
              <div v-if="summaryFor(outcome.id)" class="text-[11px] text-white/35 mt-1">
                Cost basis {{ money(summaryFor(outcome.id)!.costBasisReal) }} real +
                {{ money(summaryFor(outcome.id)!.costBasisBonus) }} bonus
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Book depth, both sides -->
      <div>
        <h2 class="text-sm font-bold text-white uppercase tracking-widest mb-3">Book depth</h2>
        <div class="grid gap-4 sm:grid-cols-2">
          <div
            v-for="outcome in outcomes"
            :key="outcome.id"
            class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-lg"
            style="background:var(--surface-raised);"
          >
            <div class="px-4 py-3 border-b border-(--surface-border) flex items-center justify-between" style="background:var(--surface-overlay);">
              <span class="font-bold text-white text-sm truncate">{{ outcome.label }}</span>
              <span class="text-[11px] text-white/40 tabular-nums">
                {{ restingShares(outcome.id).toLocaleString() }} shares resting
              </span>
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-white/5">
                  <th class="text-left px-4 py-2 text-white/40 font-semibold text-[10px] uppercase tracking-wide">Price</th>
                  <th class="text-right px-4 py-2 text-white/40 font-semibold text-[10px] uppercase tracking-wide">Shares</th>
                  <th class="text-right px-4 py-2 text-white/40 font-semibold text-[10px] uppercase tracking-wide">Cumulative</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                <tr v-if="!levelsWithDepth(outcome.id).length">
                  <td colspan="3" class="px-4 py-8 text-center text-zinc-600 text-xs">
                    No resting orders
                  </td>
                </tr>
                <tr
                  v-for="level in levelsWithDepth(outcome.id)"
                  :key="level.price"
                  class="hover:bg-white/3 transition-colors"
                >
                  <td class="px-4 py-2 font-bold text-white tabular-nums">
                    {{ money(level.price, 0) }}
                    <span class="text-white/35 text-[11px] font-medium">
                      ETB ({{ pricePct(level.price) }}%)
                    </span>
                  </td>
                  <td class="px-4 py-2 text-right text-zinc-300 tabular-nums">
                    {{ level.shares.toLocaleString() }}
                  </td>
                  <td class="px-4 py-2 text-right text-white/35 tabular-nums">
                    {{ level.depth.toLocaleString() }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- The tape -->
      <div>
        <h2 class="text-sm font-bold text-white uppercase tracking-widest mb-3">Recent fills</h2>
        <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-lg" style="background:var(--surface-raised);">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="border-b border-(--surface-border)" style="background:var(--surface-overlay);">
                <tr>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Time</th>
                  <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Shares</th>
                  <th
                    v-for="outcome in outcomes"
                    :key="outcome.id"
                    class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide"
                  >
                    {{ outcome.label }}
                  </th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Taker</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                <tr v-if="!book?.fills?.length">
                  <td :colspan="3 + outcomes.length" class="px-4 py-10 text-center text-zinc-600">
                    <UIcon name="i-heroicons:arrows-right-left" class="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p class="text-xs">Nothing has traded yet</p>
                  </td>
                </tr>
                <tr v-for="fill in book?.fills ?? []" :key="fill.id" class="hover:bg-white/3 transition-colors">
                  <td class="px-4 py-2 text-white/40 text-xs font-mono whitespace-nowrap">
                    {{ clockTime(fill.createdAt) }}
                  </td>
                  <td class="px-4 py-2 text-right text-zinc-300 tabular-nums">
                    {{ fill.quantity.toLocaleString() }}
                  </td>
                  <td
                    v-for="outcome in outcomes"
                    :key="outcome.id"
                    class="px-4 py-2 text-right text-white tabular-nums"
                  >
                    {{ money(fillPriceFor(fill, outcome.id), 0) }}
                    <span class="text-white/35 text-[11px]">
                      ({{ pricePct(fillPriceFor(fill, outcome.id)) }}%)
                    </span>
                  </td>
                  <td class="px-4 py-2 text-white/40 text-xs truncate">
                    {{ labelById.get(fill.takerOutcomeId) ?? '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Positions -->
      <div>
        <h2 class="text-sm font-bold text-white uppercase tracking-widest mb-3">
          Positions
          <span class="text-white/35 font-medium normal-case tracking-normal">
            — largest holders first
          </span>
        </h2>
        <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-lg" style="background:var(--surface-raised);">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="border-b border-(--surface-border)" style="background:var(--surface-overlay);">
                <tr>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Player</th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Side</th>
                  <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Shares</th>
                  <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Cost basis</th>
                  <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">If it wins</th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Status</th>
                  <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Paid</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                <tr v-if="!positionRows.length">
                  <td colspan="7" class="px-4 py-10 text-center text-zinc-600">
                    <UIcon name="i-heroicons:user-group" class="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p class="text-xs">Nobody holds a position yet</p>
                  </td>
                </tr>
                <tr v-for="row in positionRows" :key="row.id" class="hover:bg-white/3 transition-colors">
                  <td class="px-4 py-2 text-zinc-200 font-medium truncate max-w-40">{{ trader(row) }}</td>
                  <td class="px-4 py-2 text-white/60 truncate max-w-32">{{ row.outcome?.label ?? '—' }}</td>
                  <td class="px-4 py-2 text-right text-zinc-300 tabular-nums">
                    {{ row.shares.toLocaleString() }}
                  </td>
                  <td class="px-4 py-2 text-right text-zinc-300 tabular-nums">
                    {{ money(basis(row)) }}
                    <span v-if="isPositive(row.costBasisBonus)" class="text-[11px] text-white/35">
                      ({{ money(row.costBasisBonus) }} bonus)
                    </span>
                  </td>
                  <td class="px-4 py-2 text-right text-yellow-500 tabular-nums">
                    {{ money(payoutIfWins(row)) }}
                  </td>
                  <td class="px-4 py-2">
                    <UBadge :color="positionColor(row.status)" variant="soft" size="xs">
                      {{ row.status }}
                    </UBadge>
                  </td>
                  <td class="px-4 py-2 text-right tabular-nums">
                    <span v-if="row.status === 'OPEN'" class="text-white/25">—</span>
                    <span v-else class="text-emerald-400">{{ money(row.payout) }}</span>
                    <span v-if="isPositive(row.feePaid)" class="text-[11px] text-white/35">
                      (fee {{ money(row.feePaid) }})
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="positions?.nextCursor" class="border-t border-(--surface-border) p-3 text-center">
            <UButton color="neutral" variant="ghost" :loading="loadingMorePositions" @click="loadMorePositions">
              Load more
            </UButton>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Publish ────────────────────────────────────────────────────────── -->
    <UModal v-model:open="showPublish" title="Publish market" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div v-if="market" class="space-y-3 text-sm">
          <p class="text-zinc-200">
            Opens the book on <strong>{{ market.question }}</strong>. Players can place limit orders
            immediately and money starts being escrowed.
          </p>
          <UAlert color="warning" variant="subtle" icon="i-heroicons:lock-closed">
            <template #description>
              <span class="text-xs">
                The question, outcome labels, share value ({{ money(market.shareValue) }} ETB) and
                fee ({{ percent(market.feePct) }}% of profit) freeze on publish. Only the
                description, image and a <em>later</em> closing time stay editable.
              </span>
            </template>
          </UAlert>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showPublish = false">Cancel</UButton>
        <UButton color="primary" :loading="busy" @click="doPublish">Publish</UButton>
      </template>
    </UModal>

    <!-- ── Close ──────────────────────────────────────────────────────────── -->
    <UModal v-model:open="showClose" title="Close the book" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-3 text-sm">
          <p class="text-zinc-200">
            Stops all new orders. A closed book cannot be reopened — the only ways out are resolve
            or void.
          </p>
          <p class="text-xs text-white/50">
            Resting orders stay funded and untouched: unmatched money was never at risk and is
            refunded in full when the market settles or voids.
          </p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showClose = false">Cancel</UButton>
        <UButton color="warning" :loading="busy" @click="doClose">Close book</UButton>
      </template>
    </UModal>

    <!-- ── Resolve — typed confirmation of the winning label ───────────────── -->
    <UModal v-model:open="showResolve" title="Resolve market" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div v-if="market" class="space-y-4">
          <p class="text-sm text-zinc-200">
            Name the winning side. Nothing pays out immediately — the payout is scheduled for the
            end of the dispute window, and you can unresolve until it expires.
          </p>

          <div class="grid gap-3 sm:grid-cols-2">
            <button
              v-for="outcome in outcomes"
              :key="outcome.id"
              type="button"
              class="rounded-xl border p-4 text-left transition-colors"
              :class="resolveOutcomeId === outcome.id
                ? 'border-yellow-500/60 bg-yellow-500/10'
                : 'border-(--surface-border) hover:border-white/20'"
              @click="resolveOutcomeId = outcome.id; resolveConfirm = ''"
            >
              <div class="font-bold text-white truncate">{{ outcome.label }}</div>
              <div class="text-[11px] text-white/40 mt-1">
                {{ (summaryFor(outcome.id)?.shares ?? 0).toLocaleString() }} shares ·
                {{ (summaryFor(outcome.id)?.holders ?? 0).toLocaleString() }} holders
              </div>
              <div class="text-sm font-bold text-yellow-500 tabular-nums mt-2">
                {{ money(summaryFor(outcome.id)?.obligation) }} ETB owed
              </div>
            </button>
          </div>

          <template v-if="resolveOutcome">
            <UAlert color="warning" variant="subtle" icon="i-heroicons:banknotes">
              <template #description>
                <div class="space-y-1 text-xs">
                  <div>
                    <strong>{{ money(summaryFor(resolveOutcome.id)?.obligation) }} ETB</strong>
                    will be paid to
                    {{ (summaryFor(resolveOutcome.id)?.holders ?? 0).toLocaleString() }} holders of
                    <strong>{{ resolveOutcome.label }}</strong>, less
                    {{ percent(market.feePct) }}% of each position's profit. Everyone on the other
                    side is paid nothing.
                  </div>
                  <div>
                    Remaining open orders are cancelled and refunded in full, then the market is
                    terminal. This cannot be undone once the dispute window closes.
                  </div>
                </div>
              </template>
            </UAlert>

            <UFormField :label="`Type ${resolveOutcome.label} to confirm`" required>
              <UInput
                v-model="resolveConfirm"
                :placeholder="resolveOutcome.label"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
          </template>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showResolve = false">Cancel</UButton>
        <UButton color="primary" :loading="busy" :disabled="!resolveReady" @click="doResolve">
          Resolve market
        </UButton>
      </template>
    </UModal>

    <!-- ── Unresolve ──────────────────────────────────────────────────────── -->
    <UModal v-model:open="showUnresolve" title="Reverse the resolution" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-3 text-sm">
          <p class="text-zinc-200">
            Takes the call back and returns the market to CLOSED. The scheduled payout is removed;
            no money has moved, so nothing is clawed back.
          </p>
          <p class="text-xs text-white/50 tabular-nums">
            Available for another <strong class="font-mono">{{ disputeCountdown }}</strong>.
          </p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showUnresolve = false">Cancel</UButton>
        <UButton color="info" :loading="busy" @click="doUnresolve">Unresolve</UButton>
      </template>
    </UModal>

    <!-- ── Void — typed confirmation of the word VOID ──────────────────────── -->
    <UModal v-model:open="showVoid" title="Void market" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-4">
          <UAlert color="error" variant="subtle" icon="i-heroicons:no-symbol">
            <template #description>
              <div class="space-y-1 text-xs">
                <div>
                  Every position is refunded at cost basis and every open order is refunded in
                  full. Bonus-funded money goes back to the bonus balance, not to real. No fee is
                  taken and nothing is paid to the house.
                </div>
                <div>This is terminal — a voided market cannot be resolved afterwards.</div>
              </div>
            </template>
          </UAlert>

          <UFormField label="Reason" required hint="Recorded in the audit log and shown to players">
            <UTextarea
              v-model="voidReason"
              :rows="2"
              placeholder="Bout ended in a draw"
              class="w-full"
            />
          </UFormField>

          <UFormField label="Type VOID to confirm" required>
            <UInput v-model="voidConfirm" placeholder="VOID" autocomplete="off" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showVoid = false">Cancel</UButton>
        <UButton color="error" :loading="busy" :disabled="!voidReady" @click="doVoid">
          Void and refund
        </UButton>
      </template>
    </UModal>

    <!-- ── Edit ───────────────────────────────────────────────────────────── -->
    <UModal v-model:open="showEdit" title="Edit market" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-4">
          <UAlert v-if="!isDraft" color="info" variant="subtle" icon="i-heroicons:lock-closed">
            <template #description>
              <span class="text-xs">
                This market is live. Only the description, the image and an <em>extended</em>
                closing time can change — the terms money is escrowed against are frozen.
              </span>
            </template>
          </UAlert>

          <UFormField label="Event name">
            <UInput v-model="edit.eventName" :disabled="!isDraft" class="w-full" />
          </UFormField>
          <UFormField label="Question">
            <UInput v-model="edit.question" :disabled="!isDraft" class="w-full" />
          </UFormField>
          <UFormField label="Description">
            <UTextarea v-model="edit.description" :rows="2" class="w-full" />
          </UFormField>
          <UFormField label="Image URL">
            <UInput v-model="edit.imageUrl" class="w-full" />
          </UFormField>
          <UFormField
            label="Closes at"
            :hint="isDraft ? undefined : 'Can only be extended'"
          >
            <UInput v-model="edit.closesAt" type="datetime-local" class="w-full" />
          </UFormField>

          <div v-if="isDraft" class="grid gap-4 sm:grid-cols-2 pt-4 border-t border-white/8">
            <UFormField label="Share value (ETB)">
              <UInput v-model.number="edit.shareValue" type="number" min="2" step="1" class="w-full" />
            </UFormField>
            <UFormField label="Fee (% of profit)">
              <UInput v-model.number="edit.feePct" type="number" min="0" max="100" step="0.01" class="w-full" />
            </UFormField>
            <UFormField label="Min order size">
              <UInput v-model.number="edit.minOrderShares" type="number" min="1" step="1" class="w-full" />
            </UFormField>
            <UFormField label="Max order size">
              <UInput v-model.number="edit.maxOrderShares" type="number" min="1" step="1" class="w-full" />
            </UFormField>
          </div>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showEdit = false">Cancel</UButton>
        <UButton color="primary" :loading="busy" @click="saveEdit">Save changes</UButton>
      </template>
    </UModal>
  </div>
</template>
