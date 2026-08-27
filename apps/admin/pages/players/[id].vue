<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const { getPlayer, adjustPlayerBalance, restrictPlayer, suspendPlayer, reinstatePlayer, getPlayerStatusHistory } = useAdminApi()
const toast = useToast()

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

// ── Account status ────────────────────────────────────────────────────
const STATUS_CATEGORIES = ['RECEIPT_FRAUD', 'CHARGEBACK', 'BONUS_ABUSE', 'MULTI_ACCOUNT', 'OTHER']

const statusHistory = ref<any[]>([])
const showStatus = ref(false)
const savingStatus = ref(false)
/** Which transition the dialog is about: 'RESTRICTED' | 'SUSPENDED' | 'ACTIVE'. */
const statusTarget = ref<'RESTRICTED' | 'SUSPENDED' | 'ACTIVE'>('RESTRICTED')

const statusForm = reactive({ reason: '', category: '', expiresAt: '' })

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
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

async function fetchPlayer() {
  loading.value = true
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
      amount: adjustForm.amount,
      note: adjustForm.note,
    })
    toast.add({ title: 'Balance adjusted', color: 'success' })
    showAdjust.value = false
    adjustForm.amount = 0
    adjustForm.note = ''
    await fetchPlayer()
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

onMounted(fetchPlayer)
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

      <!-- Stats -->
      <div v-if="player.stats" class="grid grid-cols-2 md:grid-cols-4 gap-4">
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
      <div class="flex gap-2">
        <UButton icon="i-heroicons:adjustments-horizontal" label="Adjust Balance" color="primary" variant="soft" @click="showAdjust = true" />
      </div>

      <!-- Transaction History -->
      <div>
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
      <div class="p-4 rounded-2xl border border-(--surface-border) shadow-lg space-y-4" style="background:var(--surface-raised);">
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

    </template>

    <!-- Adjust Balance Modal -->
    <UModal v-model:open="showAdjust" title="Adjust Player Balance" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Balance Type">
            <USelect
              v-model="adjustForm.type"
              :items="[{ label: 'Real Balance', value: 'real' }, { label: 'Bonus Balance', value: 'bonus' }]"
              class="w-full"
              value-key="value"
            />
          </UFormField>
          <UFormField label="Amount (use negative to deduct)">
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
          <UButton color="primary" :loading="adjusting" :disabled="!adjustForm.note || adjustForm.amount === 0" label="Apply" @click="submitAdjustment" />
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

  </div>
</template>
