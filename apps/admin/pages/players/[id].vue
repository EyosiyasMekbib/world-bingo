<script setup lang="ts">
import { BonusGrantStatus, BonusSource } from '@world-bingo/shared-types'
import type { PlayerBonusGrant } from '~/composables/useAdminApi'

definePageMeta({ layout: 'default' })

const route = useRoute()
const {
  fetch: adminFetch,
  getPlayer,
  getPlayerBonusGrants,
  adjustPlayerBalance,
  restrictPlayer,
  suspendPlayer,
  reinstatePlayer,
  getPlayerStatusHistory,
  resetPlayerPassword,
} = useAdminApi()
// `user` names the actor in the bonus-grant audit line. Password reset and the
// bonus grant are both ADMIN-only on the server; hiding them for everyone else
// just saves them a 403.
const { user, isAdmin } = useAdminAuth()
const toast = useToast()

const activeTab = ref<'overview' | 'bonuses'>('overview')

const player = ref<any>(null)
const loading = ref(true)
const showAdjust = ref(false)
const adjusting = ref(false)
const activeFilter = ref<string | null>(null)

const FILTER_MAP: Record<string, string[]> = {
  games: ['GAME_ENTRY'],
  wins: ['PRIZE_WIN'],
  deposits: ['DEPOSIT'],
  withdrawals: ['WITHDRAWAL'],
}

const filteredTransactions = computed(() => {
  if (!player.value?.transactions) return []
  if (!activeFilter.value) return player.value.transactions
  const types = FILTER_MAP[activeFilter.value] ?? []
  return player.value.transactions.filter((tx: any) => types.includes(tx.type))
})

function toggleFilter(key: string) {
  activeFilter.value = activeFilter.value === key ? null : key
}

const adjustForm = reactive({
  type: 'real' as 'real' | 'bonus',
  amount: 0,
  note: '',
})

// adjust-balance reads `amount` as a signed delta, and the deduct entry point
// used to leave that sign to the admin: 50 typed under a button labelled
// "Deduct bonus" GRANTED 50 ETB of bonus which, sent without an expiresAt,
// never expired. Direction is the modal's own state now, not a typing habit.
const adjustMode = ref<'signed' | 'deduct'>('signed')

const adjustDelta = computed(() =>
  adjustMode.value === 'deduct' ? -Math.abs(adjustForm.amount) : adjustForm.amount,
)

const adjustTitle = computed(() =>
  adjustMode.value === 'deduct' ? 'Deduct Player Bonus' : 'Adjust Player Balance',
)

// Mode as well as sign, so a modal opened to deduct never offers to credit
// while the amount still sits at zero.
const adjustIsDeduction = computed(() => adjustMode.value === 'deduct' || adjustDelta.value < 0)

/** Names the direction and the amount, because "Apply" named neither. */
const adjustActionLabel = computed(() => {
  const target = adjustForm.type === 'bonus' ? 'bonus' : 'real balance'
  return adjustIsDeduction.value
    ? `Deduct ${fmt(Math.abs(adjustDelta.value))} ETB ${target}`
    : `Credit ${fmt(adjustDelta.value)} ETB ${target}`
})

function openAdjust() {
  adjustMode.value = 'signed'
  adjustForm.type = 'real'
  adjustForm.amount = 0
  adjustForm.note = ''
  showAdjust.value = true
}

/** The bonus panel's deduct action: the same modal, one direction only. */
function openBonusDeduction() {
  adjustMode.value = 'deduct'
  adjustForm.type = 'bonus'
  adjustForm.amount = 0
  adjustForm.note = ''
  showAdjust.value = true
}

// ── Bonuses tab ───────────────────────────────────────────────────────
const HOUR_MS = 3600_000

const grants = ref<PlayerBonusGrant[]>([])
const grantsLoading = ref(false)
const grantsLoaded = ref(false)
const grantsFailed = ref(false)

// Comes from the API, summed off the player's BONUS_EXPIRED transactions: the
// expiry sweep zeroes a lot's `remaining` as it marks it EXPIRED, so no
// arithmetic over the lots below can recover what went unused.
const expiredUnused = ref(0)

// Relative expiry labels go stale on a page a clerk leaves open all shift, and
// "3h left" turning red is the whole point of the column.
const now = ref(Date.now())

async function fetchGrants() {
  grantsLoading.value = true
  try {
    const payload = await getPlayerBonusGrants(route.params.id as string)
    grants.value = payload.grants
    expiredUnused.value = payload.expiredUnused
    grantsFailed.value = false
    grantsLoaded.value = true
  } catch (err: any) {
    // The tab's own data: an empty strip beats taking the player page down.
    // But unread lots are not zero lots, and silence here made the tab argue
    // the wallet disagreed with nothing and the player had never held a bonus.
    grants.value = []
    expiredUnused.value = 0
    grantsFailed.value = true
    toast.add({
      title: 'Could not load bonus lots',
      description: err?.data?.error ?? 'Request failed',
      color: 'error',
    })
  } finally {
    grantsLoading.value = false
  }
}

const activeLots = computed(() => grants.value.filter((g) => g.status === BonusGrantStatus.ACTIVE))
const closedLots = computed(() => grants.value.filter((g) => g.status !== BonusGrantStatus.ACTIVE))

const walletBonus = computed(() => Number(player.value?.wallet?.bonusBalance ?? 0))
const activeLotSum = computed(() => activeLots.value.reduce((sum, g) => sum + g.remaining, 0))

// BonusService.restore mints a fresh lot for bonus handed back, from 15 call
// sites — a per-order prediction cancel among them — so a player granted 100
// ETB who cancels five bonus-funded orders owns lots summing to 600. Only the
// non-REFUND lots are bonus the house actually gave away; totalling the rest is
// the overstatement bonus.service.ts:229-233 warns about.
const receivedLots = computed(() => grants.value.filter((g) => g.source !== BonusSource.REFUND))
const lifetimeGranted = computed(() => receivedLots.value.reduce((sum, g) => sum + g.amount, 0))
const closedTotal = computed(() =>
  receivedLots.value
    .filter((g) => g.status !== BonusGrantStatus.ACTIVE)
    .reduce((sum, g) => sum + g.amount, 0),
)

// wallets.bonusBalance is Decimal(20,8) and the lots are Decimal(12,2), so an
// exact comparison would flag every player. Half a cent is the real tolerance.
const ledgerAgrees = computed(() => Math.abs(walletBonus.value - activeLotSum.value) < 0.005)

const SOURCE_META: Record<BonusSource, { label: string; icon: string; tint: string }> = {
  [BonusSource.FIRST_DEPOSIT]: { label: 'First deposit', icon: 'i-heroicons:gift', tint: 'text-amber-400 bg-amber-400/15' },
  [BonusSource.DAILY_DEPOSIT]: { label: 'Deposit rule', icon: 'i-heroicons:calendar-days', tint: 'text-amber-400 bg-amber-400/15' },
  [BonusSource.WEEKLY_DEPOSIT]: { label: 'Weekly deposit rule', icon: 'i-heroicons:calendar', tint: 'text-amber-400 bg-amber-400/15' },
  [BonusSource.CASHBACK]: { label: 'Cashback', icon: 'i-heroicons:arrow-path-rounded-square', tint: 'text-cyan-400 bg-cyan-400/15' },
  [BonusSource.CAMPAIGN]: { label: 'Campaign', icon: 'i-heroicons:megaphone', tint: 'text-fuchsia-400 bg-fuchsia-400/15' },
  [BonusSource.ADMIN]: { label: 'Manual grant', icon: 'i-heroicons:shield-check', tint: 'text-white/70 bg-white/10' },
  [BonusSource.REFUND]: { label: 'Refund', icon: 'i-heroicons:receipt-refund', tint: 'text-emerald-400 bg-emerald-400/15' },
}

function sourceMeta(g: PlayerBonusGrant) {
  return SOURCE_META[g.source ?? BonusSource.ADMIN] ?? SOURCE_META[BonusSource.ADMIN]
}

/** The rule's own name where there is one — a lot from before `source` landed has only that. */
function lotName(g: PlayerBonusGrant) {
  return g.ruleName ?? sourceMeta(g).label
}

function hoursLeft(expiresAt: string | null) {
  if (!expiresAt) return null
  return (new Date(expiresAt).getTime() - now.value) / HOUR_MS
}

function expiryLabel(expiresAt: string | null) {
  const left = hoursLeft(expiresAt)
  if (left === null) return 'No expiry'
  if (left <= 0) return 'Expired'
  if (left < 24) return `${Math.max(1, Math.round(left))}h left`
  const days = Math.floor(left / 24)
  const hours = Math.round(left % 24)
  return hours ? `${days}d ${hours}h left` : `${days}d left`
}

function expiryUrgent(expiresAt: string | null) {
  const left = hoursLeft(expiresAt)
  return left !== null && left < 6
}

/**
 * Expired / spent in full / partially spent. Status is read before `remaining`
 * because the expiry sweep zeroes `remaining` as it marks a lot EXPIRED: test
 * the amount first and a player who lost 500 ETB to the sweep reads as having
 * spent every birr of it, in green. That zeroing is also why no per-lot unused
 * figure appears here — it is gone from the lot, and the strip's "Expired
 * unused" comes from the BONUS_EXPIRED transactions instead.
 */
function outcome(g: PlayerBonusGrant) {
  if (g.status === BonusGrantStatus.EXPIRED) {
    return { label: 'Expired', color: 'error' as const }
  }
  if (g.status === BonusGrantStatus.CONSUMED || g.remaining <= 0) {
    return { label: 'Spent in full', color: 'success' as const }
  }
  return { label: `Partially spent · ${fmt(g.remaining)} unused`, color: 'warning' as const }
}

function fmt(n: number) {
  return Number(n ?? 0).toFixed(2)
}

// ── Manual grant ──────────────────────────────────────────────────────
const EXPIRY_PRESETS = [
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7 days', hours: 24 * 7 },
  { label: 'No expiry', hours: null },
] as const

// A select, not free text: the reason drives how finance reads the audit log
// later, and six fixed phrasings are countable where typed ones are not.
const GRANT_REASONS = [
  'Goodwill — support resolution',
  'Goodwill — failed deposit',
  'Compensation — game or room fault',
  'Promotion make-good',
  'Retention gesture',
  'Correcting an earlier adjustment',
]

const grantForm = reactive({
  amount: 0,
  hours: 24 as number | null,
  reason: '',
  note: '',
})
const granting = ref(false)

const grantReady = computed(
  () => grantForm.amount > 0 && !!grantForm.reason && grantForm.note.trim().length >= 3,
)

function expiresAtFrom(hours: number | null) {
  return hours === null ? null : new Date(Date.now() + hours * HOUR_MS).toISOString()
}

async function submitGrant() {
  if (!grantReady.value) return
  granting.value = true
  const preset = EXPIRY_PRESETS.find((p) => p.hours === grantForm.hours)
  const validity = grantForm.hours === null ? 'no expiry' : `valid ${preset?.label}`
  try {
    // Reason and validity are folded into the note as well as sent as fields:
    // adjust-balance copies the note verbatim into the audit row, and that row
    // is what somebody reads a year from now.
    await adminFetch(`/admin/players/${route.params.id}/adjust-balance`, {
      method: 'POST',
      body: {
        type: 'bonus',
        amount: grantForm.amount,
        note: `${grantForm.reason} · ${validity} · ${grantForm.note.trim()}`,
        expiresAt: expiresAtFrom(grantForm.hours),
      },
    })
    toast.add({ title: `Granted ${fmt(grantForm.amount)} ETB bonus`, color: 'success' })
    grantForm.amount = 0
    grantForm.reason = ''
    grantForm.note = ''
    await Promise.all([fetchPlayer({ silent: true }), fetchGrants()])
  } catch (err: any) {
    toast.add({
      title: 'Could not grant bonus',
      description: err?.data?.error ?? 'Request failed',
      color: 'error',
    })
  } finally {
    granting.value = false
  }
}

// ── Extend a lot's expiry ─────────────────────────────────────────────
const showExtend = ref(false)
const extendTarget = ref<PlayerBonusGrant | null>(null)
const extendHours = ref<number | null>(24)
const extending = ref(false)

function openExtend(g: PlayerBonusGrant) {
  extendTarget.value = g
  extendHours.value = 24
  showExtend.value = true
}

async function submitExtend() {
  const lot = extendTarget.value
  if (!lot) return
  extending.value = true
  try {
    // Counted from now rather than from the old expiry: a lot somebody is
    // rescuing is usually already at or past its deadline, and "48h" has to
    // mean the player really has 48 hours.
    await adminFetch(`/admin/players/${route.params.id}/bonus-grants/${lot.id}/extend`, {
      method: 'POST',
      body: { expiresAt: expiresAtFrom(extendHours.value) },
    })
    toast.add({ title: 'Expiry extended', color: 'success' })
    showExtend.value = false
    await fetchGrants()
  } catch (err: any) {
    toast.add({
      title: 'Could not extend the lot',
      description: err?.data?.error ?? 'Request failed',
      color: 'error',
    })
  } finally {
    extending.value = false
  }
}

// ── Account status ────────────────────────────────────────────────────
const STATUS_CATEGORIES = ['RECEIPT_FRAUD', 'CHARGEBACK', 'BONUS_ABUSE', 'MULTI_ACCOUNT', 'OTHER']

const statusHistory = ref<any[]>([])
const showStatus = ref(false)
const savingStatus = ref(false)
/** Which transition the dialog is about: 'RESTRICTED' | 'SUSPENDED' | 'ACTIVE'. */
const statusTarget = ref<'RESTRICTED' | 'SUSPENDED' | 'ACTIVE'>('RESTRICTED')

const statusForm = reactive({ reason: '', category: '', expiresAt: '' })

const STATUS_STYLE: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'neutral' }> = {
  ACTIVE: { label: 'Active', color: 'success' },
  RESTRICTED: { label: 'Restricted', color: 'warning' },
  SUSPENDED: { label: 'Suspended', color: 'error' },
}

const currentStatus = computed(() => player.value?.accountStatus ?? 'ACTIVE')

function openStatus(target: 'RESTRICTED' | 'SUSPENDED' | 'ACTIVE') {
  statusTarget.value = target
  statusForm.reason = ''
  statusForm.category = ''
  statusForm.expiresAt = ''
  showStatus.value = true
}

async function fetchStatusHistory() {
  try {
    statusHistory.value = await getPlayerStatusHistory(route.params.id as string)
  } catch {
    // The history is context, not the page: a failure here should not blank
    // out the player's balances and transactions.
    statusHistory.value = []
  }
}

async function submitStatus() {
  const reason = statusForm.reason.trim()
  if (reason.length < 3) {
    toast.add({ title: 'A reason is required', description: 'At least 3 characters.', color: 'error' })
    return
  }
  savingStatus.value = true
  const id = route.params.id as string
  try {
    if (statusTarget.value === 'ACTIVE') {
      await reinstatePlayer(id, { reason })
    } else {
      const body: { reason: string; category?: string; expiresAt?: string } = { reason }
      if (statusForm.category) body.category = statusForm.category
      if (statusForm.expiresAt) body.expiresAt = new Date(statusForm.expiresAt).toISOString()
      if (statusTarget.value === 'RESTRICTED') await restrictPlayer(id, body)
      else await suspendPlayer(id, body)
    }
    showStatus.value = false
    await Promise.all([fetchPlayer(), fetchStatusHistory()])
    toast.add({ title: 'Account status updated', color: 'success' })
  } catch (err: any) {
    toast.add({
      title: 'Could not update status',
      description: err?.data?.error ?? 'Request failed',
      color: 'error',
    })
  } finally {
    savingStatus.value = false
  }
}

// ── Password reset ────────────────────────────────────────────────────
// Support-assisted recovery for a player who forgot their password. The API
// returns the temporary password exactly once; it lives in this ref only while
// the dialog is open and is dropped the moment it closes.
const showReset = ref(false)
const resetting = ref(false)
const identityVerified = ref(false)
const temporaryPassword = ref<string | null>(null)
const copied = ref(false)

function openReset() {
  identityVerified.value = false
  temporaryPassword.value = null
  copied.value = false
  showReset.value = true
}

watch(showReset, (open) => {
  if (!open) {
    temporaryPassword.value = null
    identityVerified.value = false
    copied.value = false
  }
})

async function submitReset() {
  resetting.value = true
  try {
    const result = await resetPlayerPassword(route.params.id as string)
    temporaryPassword.value = result.temporaryPassword
  } catch (err: any) {
    toast.add({
      title: 'Could not reset password',
      description: err?.data?.error ?? err?.data?.message ?? 'Request failed',
      color: 'error',
    })
  } finally {
    resetting.value = false
  }
}

async function copyTemporaryPassword() {
  if (!temporaryPassword.value) return
  try {
    await navigator.clipboard.writeText(temporaryPassword.value)
    copied.value = true
  } catch {
    toast.add({ title: 'Copy failed', description: 'Select the password and copy it by hand.', color: 'warning' })
  }
}

async function fetchPlayer(opts: { silent?: boolean } = {}) {
  if (!opts.silent) loading.value = true
  try {
    player.value = await getPlayer(route.params.id as string)
    await fetchStatusHistory()
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load player', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function submitAdjustment() {
  adjusting.value = true
  try {
    await adjustPlayerBalance(route.params.id as string, {
      type: adjustForm.type,
      amount: adjustDelta.value,
      note: adjustForm.note,
    })
    toast.add({ title: 'Balance adjusted', color: 'success' })
    showAdjust.value = false
    adjustForm.amount = 0
    adjustForm.note = ''
    // Both, as submitGrant does: a bonus adjustment moves the wallet and the
    // lots together, and refreshing one of them is what made the
    // reconciliation strip cry drift at a ledger that was fine.
    await Promise.all([fetchPlayer(), fetchGrants()])
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to adjust', color: 'error' })
  } finally {
    adjusting.value = false
  }
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-ET', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function txColor(type: string) {
  if (type.includes('WIN') || type.includes('BONUS') || type === 'REFUND' || type === 'DEPOSIT') return 'success'
  if (type.includes('ENTRY') || type === 'WITHDRAWAL') return 'error'
  return 'neutral'
}

watch(activeTab, (tab) => {
  if (tab === 'bonuses' && !grantsLoaded.value) fetchGrants()
})

let clock: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  fetchPlayer()
  clock = setInterval(() => { now.value = Date.now() }, 60_000)
})

onUnmounted(() => {
  if (clock) clearInterval(clock)
})
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex items-center gap-3">
      <NuxtLink to="/players">
        <UButton icon="i-heroicons:arrow-left" color="neutral" variant="ghost" size="sm" />
      </NuxtLink>
      <h1 class="text-2xl font-bold text-white tracking-tight">Player Detail</h1>
      <UBadge
        v-if="player"
        :color="STATUS_STYLE[currentStatus]?.color ?? 'neutral'"
        variant="soft"
        size="sm"
      >
        {{ STATUS_STYLE[currentStatus]?.label ?? currentStatus }}
      </UBadge>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" /> Loading...
    </div>

    <template v-else-if="player">
      <!-- Info Cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Username</p>
          <p class="font-bold text-white text-lg">{{ player.username }}</p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Phone</p>
          <p class="font-bold text-white/60 font-mono">{{ player.phone ?? '—' }}</p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Real Balance</p>
          <p class="font-bold text-yellow-500 text-lg">{{ Number(player.wallet?.realBalance ?? 0).toFixed(2) }} <span class="text-xs text-white/30">ETB</span></p>
        </div>
        <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Bonus Balance</p>
          <p class="font-bold text-cyan-400 text-lg">{{ Number(player.wallet?.bonusBalance ?? 0).toFixed(2) }} <span class="text-xs text-white/30">ETB</span></p>
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex gap-1 border-b border-(--surface-border)">
        <button
          v-for="tab in (['overview', 'bonuses'] as const)"
          :key="tab"
          class="px-4 min-h-11 text-sm font-semibold capitalize transition-colors border-b-2 -mb-px"
          :class="activeTab === tab
            ? 'text-yellow-500 border-yellow-500'
            : 'text-white/60 border-transparent hover:text-white/80'"
          @click="activeTab = tab"
        >
          {{ tab }}
          <span v-if="tab === 'bonuses' && grantsLoaded && !grantsFailed" class="ml-1 text-xs text-white/60">({{ activeLots.length }})</span>
        </button>
      </div>

      <!-- Stats -->
      <div v-if="activeTab === 'overview' && player.stats" class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <button
          class="p-4 rounded-2xl border text-left transition-all"
          :class="activeFilter === 'games' ? 'border-yellow-500/60 ring-1 ring-yellow-500/40' : 'border-(--surface-border) hover:border-white/20'"
          style="background:var(--surface-raised);"
          @click="toggleFilter('games')"
        >
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Games Played</p>
          <p class="font-bold text-white text-lg">{{ player.stats.gamesPlayed }}</p>
          <p class="text-[10px] text-white/20 mt-0.5">{{ player.stats.totalWagered.toFixed(2) }} ETB wagered</p>
        </button>
        <button
          class="p-4 rounded-2xl border text-left transition-all"
          :class="activeFilter === 'wins' ? 'border-yellow-500/60 ring-1 ring-yellow-500/40' : 'border-(--surface-border) hover:border-white/20'"
          style="background:var(--surface-raised);"
          @click="toggleFilter('wins')"
        >
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Games Won</p>
          <p class="font-bold text-white text-lg">{{ player.stats.gamesWon }}</p>
          <p class="text-[10px] text-white/20 mt-0.5">{{ player.stats.totalWon.toFixed(2) }} ETB won</p>
        </button>
        <button
          class="p-4 rounded-2xl border text-left transition-all"
          :class="activeFilter === 'deposits' ? 'border-emerald-500/60 ring-1 ring-emerald-500/40' : 'border-(--surface-border) hover:border-white/20'"
          style="background:var(--surface-raised);"
          @click="toggleFilter('deposits')"
        >
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Total Deposited</p>
          <p class="font-bold text-emerald-400 text-lg">{{ player.stats.totalDeposited.toFixed(2) }} <span class="text-xs text-white/30">ETB</span></p>
          <p class="text-[10px] text-white/20 mt-0.5">{{ player.stats.depositCount }} deposits</p>
        </button>
        <button
          class="p-4 rounded-2xl border text-left transition-all"
          :class="activeFilter === 'withdrawals' ? 'border-red-500/60 ring-1 ring-red-500/40' : 'border-(--surface-border) hover:border-white/20'"
          style="background:var(--surface-raised);"
          @click="toggleFilter('withdrawals')"
        >
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Total Withdrawn</p>
          <p class="font-bold text-red-400 text-lg">{{ player.stats.totalWithdrawn.toFixed(2) }} <span class="text-xs text-white/30">ETB</span></p>
          <p class="text-[10px] text-white/20 mt-0.5">{{ player.stats.withdrawalCount }} withdrawals</p>
        </button>
      </div>

      <!-- Actions -->
      <div v-if="activeTab === 'overview'" class="flex gap-2">
        <!-- openAdjust, not a bare `showAdjust = true`: the modal is shared with
             the Bonuses tab's deduct action, and opening it without resetting
             that mode would silently arm a deduction. -->
        <UButton icon="i-heroicons:adjustments-horizontal" label="Adjust Balance" color="primary" variant="soft" @click="openAdjust" />
        <UButton v-if="isAdmin && player.role === 'PLAYER'" icon="i-heroicons:key" label="Reset password" color="warning" variant="soft" @click="openReset" />
      </div>

      <!-- Transaction History -->
      <div v-if="activeTab === 'overview'">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-base font-bold text-white">
            {{ activeFilter ? { games: 'Game Entries', wins: 'Prize Wins', deposits: 'Deposits', withdrawals: 'Withdrawals' }[activeFilter] : 'Recent Transactions' }}
            <span class="text-white/30 font-normal text-sm ml-1">({{ filteredTransactions.length }})</span>
          </h2>
          <UButton v-if="activeFilter" icon="i-heroicons:x-mark" label="Clear filter" color="neutral" variant="ghost" size="xs" @click="activeFilter = null" />
        </div>
        <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="border-b border-(--surface-border) bg-(--surface-overlay)">
                <tr>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase">Type</th>
                  <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase">Amount</th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase">Status</th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase">Note</th>
                  <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase">Date</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                <tr v-if="!filteredTransactions.length">
                  <td colspan="5" class="px-4 py-8 text-center text-white/30">No transactions</td>
                </tr>
                <tr v-for="tx in filteredTransactions" :key="tx.id" class="hover:bg-white/3">
                  <td class="px-4 py-3">
                    <UBadge :color="txColor(tx.type)" variant="soft" :label="tx.type" size="xs" />
                  </td>
                  <td class="px-4 py-3 text-right font-mono font-bold" :class="txColor(tx.type) === 'success' ? 'text-emerald-400' : 'text-red-400'">
                    {{ Number(tx.amount).toFixed(2) }}
                  </td>
                  <td class="px-4 py-3">
                    <UBadge :color="tx.status === 'APPROVED' ? 'success' : tx.status === 'REJECTED' ? 'error' : 'warning'" variant="soft" :label="tx.status" size="xs" />
                  </td>
                  <td class="px-4 py-3 text-white/40 text-xs max-w-48 truncate">{{ tx.note ?? '—' }}</td>
                  <td class="px-4 py-3 text-white/40 text-xs">{{ formatDate(tx.createdAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Account status -->
      <div v-if="activeTab === 'overview'" class="p-4 rounded-2xl border border-(--surface-border) shadow-lg space-y-4" style="background:var(--surface-raised);">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Account status</p>
            <p class="font-bold text-white">{{ STATUS_STYLE[currentStatus]?.label ?? currentStatus }}</p>
          </div>
          <div class="flex gap-2">
            <UButton v-if="currentStatus !== 'RESTRICTED'" size="sm" color="warning" variant="soft" @click="openStatus('RESTRICTED')">Restrict</UButton>
            <UButton v-if="currentStatus !== 'SUSPENDED'" size="sm" color="error" variant="soft" @click="openStatus('SUSPENDED')">Suspend</UButton>
            <UButton v-if="currentStatus !== 'ACTIVE'" size="sm" color="success" variant="soft" @click="openStatus('ACTIVE')">Reinstate</UButton>
          </div>
        </div>

        <p class="text-xs text-white/40 leading-relaxed">
          <span class="text-white/60 font-semibold">Restricted</span> holds deposits, withdrawals and joining
          games while leaving the player able to log in and reach support.
          <span class="text-white/60 font-semibold">Suspended</span> refuses login outright.
        </p>

        <div v-if="statusHistory.length" class="border-t border-(--surface-border) pt-3 space-y-2">
          <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest">History</p>
          <div v-for="row in statusHistory" :key="row.id" class="text-xs text-white/50 flex flex-wrap items-baseline gap-x-2">
            <span class="font-mono text-white/30">{{ new Date(row.createdAt).toLocaleString() }}</span>
            <span class="text-white/70">{{ row.from }} &rarr; {{ row.to }}</span>
            <span>{{ row.reason }}</span>
            <span v-if="row.category" class="text-white/30">({{ row.category }})</span>
            <span v-if="!row.actorId" class="text-white/30">&middot; automatic</span>
            <span v-if="row.expiresAt" class="text-white/30">&middot; lifts {{ new Date(row.expiresAt).toLocaleString() }}</span>
          </div>
        </div>
      </div>

      <!-- Bonuses tab -->
      <template v-if="activeTab === 'bonuses'">
        <div v-if="grantsLoading && !grantsLoaded" class="flex items-center justify-center py-16 text-zinc-500">
          <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" /> Loading bonus lots...
        </div>

        <template v-else>
          <!-- Lots nobody managed to read cannot disagree with the wallet, so the
               verdict below is withheld rather than guessed at. -->
          <div
            v-if="grantsFailed"
            class="p-4 rounded-2xl border border-amber-400/40 shadow-lg flex flex-wrap items-center gap-x-3 gap-y-2"
            style="background:var(--surface-raised);"
          >
            <UIcon name="i-heroicons:exclamation-triangle" class="w-[18px] h-[18px] shrink-0 text-amber-400" />
            <span class="text-[13px] text-white/80">
              Bonus lots could not be loaded, so wallet
              <strong class="text-white font-semibold tabular-nums">{{ fmt(walletBonus) }}</strong>
              has nothing to reconcile against.
            </span>
            <UButton
              class="min-h-11 ml-auto"
              size="sm"
              color="neutral"
              variant="soft"
              label="Retry"
              :loading="grantsLoading"
              @click="fetchGrants"
            />
          </div>

          <!-- Reconciliation: the wallet number against the lots that justify it -->
          <div
            v-else
            class="p-4 rounded-2xl border shadow-lg flex flex-wrap items-center gap-x-6 gap-y-2"
            :class="ledgerAgrees ? 'border-(--surface-border)' : 'border-red-500/40'"
            style="background:var(--surface-raised);"
          >
            <div class="flex items-center gap-2">
              <UIcon
                :name="ledgerAgrees ? 'i-heroicons:check-circle' : 'i-heroicons:exclamation-triangle'"
                class="w-[18px] h-[18px] shrink-0"
                :class="ledgerAgrees ? 'text-emerald-400' : 'text-red-400'"
              />
              <span class="text-[13px] text-white/80">
                Wallet <strong class="text-white font-semibold tabular-nums">{{ fmt(walletBonus) }}</strong>
                {{ ledgerAgrees ? 'matches active lots' : 'disagrees with active lots' }}
                <strong
                  class="font-semibold tabular-nums"
                  :class="ledgerAgrees ? 'text-white' : 'text-red-400'"
                >{{ fmt(activeLotSum) }}</strong>
              </span>
            </div>
            <div class="hidden sm:block w-px h-5 bg-white/15" />
            <span class="text-[13px] text-white/80">
              Lifetime bonus received
              <strong class="text-white font-semibold tabular-nums">{{ fmt(lifetimeGranted) }} ETB</strong>
            </span>
            <div class="hidden sm:block w-px h-5 bg-white/15" />
            <span class="text-[13px] text-white/80">
              Expired unused
              <strong class="font-semibold tabular-nums" :class="expiredUnused > 0 ? 'text-red-400' : 'text-white'">
                {{ fmt(expiredUnused) }} ETB
              </strong>
            </span>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] gap-4 items-start">
            <!-- Active lots and history -->
            <div class="space-y-3">
              <h2 class="text-base font-bold text-white">Active bonus lots</h2>
              <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
                <div class="overflow-x-auto">
                  <table class="w-full text-sm">
                    <thead class="border-b border-(--surface-border) bg-(--surface-overlay)">
                      <tr>
                        <th class="text-left px-4 py-3 text-white/60 font-semibold text-xs uppercase">Source</th>
                        <th class="text-right px-4 py-3 text-white/60 font-semibold text-xs uppercase">Granted</th>
                        <th class="text-right px-4 py-3 text-white/60 font-semibold text-xs uppercase">Remaining</th>
                        <th class="text-left px-4 py-3 text-white/60 font-semibold text-xs uppercase">Expires</th>
                        <th class="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-white/5">
                      <tr v-if="!activeLots.length">
                        <td colspan="5" class="px-4 py-8 text-center text-white/60">
                          {{ grantsFailed ? 'Bonus lots could not be loaded' : 'No active bonus lots' }}
                        </td>
                      </tr>
                      <tr v-for="lot in activeLots" :key="lot.id" class="hover:bg-white/3">
                        <td class="px-4 py-3">
                          <div class="flex items-center gap-2.5">
                            <div
                              class="w-7 h-7 rounded-lg shrink-0 flex items-center justify-center"
                              :class="sourceMeta(lot).tint"
                            >
                              <UIcon :name="sourceMeta(lot).icon" class="w-[15px] h-[15px]" />
                            </div>
                            <div class="min-w-0">
                              <p class="text-white truncate">{{ lotName(lot) }}</p>
                              <p class="text-xs text-white/60">
                                {{ sourceMeta(lot).label }} &middot; {{ formatDate(lot.createdAt) }}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td class="px-4 py-3 text-right font-mono text-white/80">{{ fmt(lot.amount) }}</td>
                        <td class="px-4 py-3 text-right font-mono font-bold text-white">{{ fmt(lot.remaining) }}</td>
                        <td class="px-4 py-3">
                          <UBadge
                            :color="expiryUrgent(lot.expiresAt) ? 'error' : 'neutral'"
                            variant="soft"
                            size="sm"
                            :label="expiryLabel(lot.expiresAt)"
                          />
                        </td>
                        <td class="px-4 py-3 text-right">
                          <UButton
                            color="neutral"
                            variant="ghost"
                            size="sm"
                            class="min-h-11 px-3"
                            label="Extend"
                            @click="openExtend(lot)"
                          />
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <h2 class="text-base font-bold text-white pt-2">Bonus history</h2>
              <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
                <div class="overflow-x-auto">
                  <table class="w-full text-sm">
                    <thead class="border-b border-(--surface-border) bg-(--surface-overlay)">
                      <tr>
                        <th class="text-left px-4 py-3 text-white/60 font-semibold text-xs uppercase">Source</th>
                        <th class="text-right px-4 py-3 text-white/60 font-semibold text-xs uppercase">Amount</th>
                        <th class="text-left px-4 py-3 text-white/60 font-semibold text-xs uppercase">Outcome</th>
                        <th class="text-left px-4 py-3 text-white/60 font-semibold text-xs uppercase">Date</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-white/5">
                      <tr v-if="!closedLots.length">
                        <td colspan="4" class="px-4 py-8 text-center text-white/60">
                          {{ grantsFailed ? 'Bonus lots could not be loaded' : 'No closed bonus lots yet' }}
                        </td>
                      </tr>
                      <tr v-for="lot in closedLots" :key="lot.id" class="hover:bg-white/3">
                        <td class="px-4 py-3">
                          <p class="text-white/90">{{ lotName(lot) }}</p>
                          <p class="text-xs text-white/60">{{ sourceMeta(lot).label }}</p>
                        </td>
                        <td class="px-4 py-3 text-right font-mono text-white/90">{{ fmt(lot.amount) }}</td>
                        <td class="px-4 py-3">
                          <UBadge :color="outcome(lot).color" variant="soft" size="sm" :label="outcome(lot).label" />
                        </td>
                        <td class="px-4 py-3 text-white/60 text-xs">{{ formatDate(lot.createdAt) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <p v-if="closedLots.length" class="text-xs text-white/60">
                {{ closedLots.length === 1 ? '1 closed lot' : `${closedLots.length} closed lots` }}
                totalling {{ fmt(closedTotal) }} ETB granted (refund lots excluded), plus the
                {{ fmt(activeLotSum) }} ETB still active above.
              </p>
            </div>

            <!-- Manual grant -->
            <div class="space-y-3">
              <h2 class="text-base font-bold text-white">Grant bonus manually</h2>
              <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg space-y-4" style="background:var(--surface-raised);">
                <UFormField label="Amount (ETB)">
                  <UInput v-model.number="grantForm.amount" type="number" min="0" step="0.01" class="w-full" :ui="{ base: 'min-h-11' }" />
                </UFormField>

                <UFormField label="Expires after">
                  <div class="flex flex-wrap gap-2">
                    <button
                      v-for="preset in EXPIRY_PRESETS"
                      :key="preset.label"
                      type="button"
                      class="min-h-11 px-4 rounded-lg text-xs font-bold uppercase tracking-wide border transition-colors"
                      :class="grantForm.hours === preset.hours
                        ? 'bg-yellow-500/15 border-yellow-500/50 text-yellow-500'
                        : 'bg-white/5 border-white/12 text-white/70 hover:text-white'"
                      @click="grantForm.hours = preset.hours"
                    >
                      {{ preset.label }}
                    </button>
                  </div>
                </UFormField>

                <UFormField label="Reason" required>
                  <USelect
                    v-model="grantForm.reason"
                    :items="GRANT_REASONS"
                    placeholder="Pick a reason"
                    class="w-full"
                    :ui="{ base: 'min-h-11' }"
                  />
                </UFormField>

                <UFormField label="Note" hint="Required, written to the audit log" required>
                  <UTextarea
                    v-model="grantForm.note"
                    :rows="3"
                    placeholder="e.g. Ticket #4182 — room crashed mid-game, entry not refunded"
                    class="w-full"
                  />
                </UFormField>

                <div class="flex gap-2.5 items-start p-3 rounded-xl bg-amber-400/8 border border-amber-400/25">
                  <UIcon name="i-heroicons:lock-closed" class="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <p class="text-xs leading-relaxed text-white/80">
                    Admin only. This grant is recorded against
                    <strong class="text-white font-semibold">{{ user?.username ?? 'the signed-in admin' }}</strong>
                    and appears in the player's bonus history immediately.
                  </p>
                </div>

                <UButton
                  color="primary"
                  class="w-full justify-center min-h-11"
                  :loading="granting"
                  :disabled="!grantReady || !isAdmin"
                  :label="`Grant ${fmt(grantForm.amount)} ETB`"
                  @click="submitGrant"
                />
                <p v-if="!isAdmin" class="text-xs text-white/60">
                  Your role cannot grant bonus — ask an administrator.
                </p>

                <div class="flex items-center gap-2">
                  <div class="flex-1 h-px bg-white/10" />
                  <span class="text-xs font-bold uppercase tracking-widest text-white/60">or</span>
                  <div class="flex-1 h-px bg-white/10" />
                </div>

                <UButton
                  color="error"
                  variant="soft"
                  class="w-full justify-center min-h-11"
                  label="Deduct bonus"
                  @click="openBonusDeduction"
                />
              </div>
            </div>
          </div>
        </template>
      </template>

    </template>

    <!-- Adjust Balance Modal -->
    <UModal v-model:open="showAdjust" :title="adjustTitle" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Balance Type">
            <USelect
              v-model="adjustForm.type"
              :items="[{ label: 'Real Balance', value: 'real' }, { label: 'Bonus Balance', value: 'bonus' }]"
              :disabled="adjustMode === 'deduct'"
              class="w-full"
              value-key="value"
            />
          </UFormField>
          <UFormField :label="adjustMode === 'deduct' ? 'Amount to deduct (ETB)' : 'Amount (use negative to deduct)'">
            <UInput v-model.number="adjustForm.amount" type="number" class="w-full" />
          </UFormField>
          <UFormField label="Note (required for audit trail)">
            <UInput v-model="adjustForm.note" placeholder="Reason for adjustment..." class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="showAdjust = false" />
          <UButton
            :color="adjustIsDeduction ? 'error' : 'primary'"
            :loading="adjusting"
            :disabled="!adjustForm.note || adjustForm.amount === 0"
            :label="adjustActionLabel"
            @click="submitAdjustment"
          />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="showStatus">
      <template #content>
        <div class="p-6 space-y-4">
          <h3 class="text-lg font-bold text-white">
            {{ statusTarget === 'ACTIVE' ? 'Reinstate account' : statusTarget === 'RESTRICTED' ? 'Restrict account' : 'Suspend account' }}
          </h3>

          <UFormField label="Reason" hint="Recorded permanently and shown in the history" required>
            <UTextarea v-model="statusForm.reason" :rows="3" placeholder="e.g. duplicate receipts across three accounts" class="w-full" />
          </UFormField>

          <template v-if="statusTarget !== 'ACTIVE'">
            <UFormField label="Category">
              <USelect v-model="statusForm.category" :items="STATUS_CATEGORIES" placeholder="Optional" class="w-full" />
            </UFormField>
            <UFormField label="Lift automatically at" hint="Leave empty to hold until someone lifts it">
              <UInput v-model="statusForm.expiresAt" type="datetime-local" class="w-full" />
            </UFormField>
          </template>

          <div class="flex justify-end gap-2 pt-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="showStatus = false" />
            <UButton color="primary" :loading="savingStatus" label="Confirm" @click="submitStatus" />
          </div>
        </div>
      </template>
    </UModal>

    <!-- Extend a bonus lot -->
    <UModal v-model:open="showExtend" title="Extend bonus expiry" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <p v-if="extendTarget" class="text-sm text-white/70">
            <strong class="text-white font-semibold">{{ lotName(extendTarget) }}</strong> &middot;
            {{ fmt(extendTarget.remaining) }} ETB remaining, {{ expiryLabel(extendTarget.expiresAt).toLowerCase() }}.
          </p>
          <UFormField label="New validity, counted from now">
            <div class="flex flex-wrap gap-2">
              <button
                v-for="preset in EXPIRY_PRESETS"
                :key="preset.label"
                type="button"
                class="min-h-11 px-4 rounded-lg text-xs font-bold uppercase tracking-wide border transition-colors"
                :class="extendHours === preset.hours
                  ? 'bg-yellow-500/15 border-yellow-500/50 text-yellow-500'
                  : 'bg-white/5 border-white/12 text-white/70 hover:text-white'"
                @click="extendHours = preset.hours"
              >
                {{ preset.label }}
              </button>
            </div>
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" class="min-h-11" label="Cancel" @click="showExtend = false" />
          <UButton color="primary" class="min-h-11" :loading="extending" label="Extend" @click="submitExtend" />
    <!-- Not dismissible while the password is on screen: a stray click on the
         overlay would lose it for good and force a second reset. -->
    <UModal v-model:open="showReset" :dismissible="!temporaryPassword">
      <template #content>
        <div class="p-6 space-y-4">
          <template v-if="!temporaryPassword">
            <h3 class="text-lg font-bold text-white">Reset password for {{ player?.username ?? 'this player' }}</h3>

            <UAlert color="warning" variant="subtle" icon="i-heroicons:shield-exclamation" title="Verify the player's identity first">
              <template #description>
                <ul class="list-disc pl-4 space-y-1 mt-1">
                  <li>
                    They are contacting support from the registered phone number<span v-if="player?.phone"> ({{ player.phone }})</span>, or
                  </li>
                  <li>they quote the transaction ID of one of their recent deposits.</li>
                </ul>
                <p class="mt-2">Whoever receives this password controls the account and its balance.</p>
              </template>
            </UAlert>

            <p class="text-sm text-white/60 leading-relaxed">
              The player is signed out on every device and given a temporary password. They must choose a new
              password the next time they sign in.
            </p>

            <UCheckbox v-model="identityVerified" label="I have verified this player's identity" />

            <div class="flex justify-end gap-2 pt-2">
              <UButton color="neutral" variant="ghost" label="Cancel" @click="showReset = false" />
              <UButton color="warning" :loading="resetting" :disabled="!identityVerified" label="Reset password" @click="submitReset" />
            </div>
          </template>

          <template v-else>
            <h3 class="text-lg font-bold text-white">Temporary password</h3>

            <div class="flex items-center gap-2">
              <code
                class="flex-1 text-center text-2xl font-mono font-bold tracking-[0.3em] text-yellow-400 py-3 rounded-xl border border-(--surface-border) select-all"
                style="background:var(--surface-overlay);"
              >{{ temporaryPassword }}</code>
              <UButton
                :icon="copied ? 'i-heroicons:check' : 'i-heroicons:clipboard-document'"
                :label="copied ? 'Copied' : 'Copy'"
                color="primary"
                variant="soft"
                @click="copyTemporaryPassword"
              />
            </div>

            <UAlert
              color="error"
              variant="subtle"
              icon="i-heroicons:exclamation-triangle"
              title="This password will not be shown again"
              description="Give it only to the verified player, now. They must change it the next time they sign in."
            />

            <div class="flex justify-end pt-2">
              <UButton color="primary" label="Done" @click="showReset = false" />
            </div>
          </template>
        </div>
      </template>
    </UModal>

  </div>
</template>
