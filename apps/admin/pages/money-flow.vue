<script setup lang="ts">
const { getMoneyFlow } = useAdminApi()
const toast = useToast()

// ── State ──────────────────────────────────────────────────────────────────
const loading = ref(false)
const rows = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const LIMIT = 30
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / LIMIT)))

const summary = ref({
  totalDeposited: 0,
  totalWagered: 0,
  totalPrizesOut: 0,
  houseKept: 0,
  refundsIssued: 0,
})

// ── Filters ────────────────────────────────────────────────────────────────
const filterDirection = ref('__ALL__')
const filterSearch = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterTypes = ref<string[]>([])
let searchTimer: ReturnType<typeof setTimeout> | null = null

const TYPE_OPTIONS = [
  'DEPOSIT', 'WITHDRAWAL', 'GAME_ENTRY', 'PRIZE_WIN',
  'COMMISSION', 'BOT_PRIZE_WIN', 'REFUND', 'ADMIN_REAL_ADJUSTMENT',
  'PROVIDER_BET', 'PROVIDER_BET_RESULT',
]

const directionOptions = [
  { label: 'All Directions', value: '__ALL__' },
  { label: 'IN (received)', value: 'IN' },
  { label: 'OUT (paid)', value: 'OUT' },
]

// ── Fetch ──────────────────────────────────────────────────────────────────
const fetch = async () => {
  loading.value = true
  try {
    const result = await getMoneyFlow({
      page: page.value,
      limit: LIMIT,
      direction: filterDirection.value === '__ALL__' ? undefined : filterDirection.value as 'IN' | 'OUT',
      types: filterTypes.value.length ? filterTypes.value : undefined,
      from: filterFrom.value || undefined,
      to: filterTo.value || undefined,
      search: filterSearch.value || undefined,
    })
    rows.value = result.rows
    total.value = result.total
    summary.value = result.summary
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load money flow', color: 'error' })
  } finally {
    loading.value = false
  }
}

const onSearch = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; fetch() }, 400)
}

const resetFilters = () => {
  filterDirection.value = '__ALL__'
  filterSearch.value = ''
  filterFrom.value = ''
  filterTo.value = ''
  filterTypes.value = []
  page.value = 1
  fetch()
}

const filterByType = (type: string) => {
  filterTypes.value = [type]
  page.value = 1
  fetch()
}

watch([page, filterDirection, filterFrom, filterTo], fetch)
onMounted(fetch)

// ── Helpers ────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  n.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const typeColor = (type: string) => {
  if (['DEPOSIT', 'COMMISSION', 'PRIZE_WIN'].includes(type)) return 'success'
  if (['WITHDRAWAL', 'REFUND', 'REFUND_ISSUED'].includes(type)) return 'error'
  if (['GAME_ENTRY', 'BOT_PRIZE_WIN'].includes(type)) return 'warning'
  if (type.startsWith('PROVIDER')) return 'info'
  return 'neutral'
}

const sourceColor = (source: string) => {
  if (source === 'House Wallet') return 'text-yellow-400'
  if (source === 'Provider') return 'text-blue-400'
  return 'text-white/60'
}

const columns = [
  { accessorKey: 'createdAt', header: 'Date' },
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'direction', header: 'Dir.' },
  { accessorKey: 'amount', header: 'Amount' },
  { accessorKey: 'playerName', header: 'Player' },
  { accessorKey: 'gameId', header: 'Game' },
  { accessorKey: 'source', header: 'Source' },
  { accessorKey: 'balanceAfter', header: 'Balance After' },
]
</script>

<template>
  <div class="space-y-8 pb-20 md:pb-0">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Money Flow</h1>
        <p class="text-sm text-white/50 mt-0.5">Full audit trail — every ETB in and out of the platform</p>
      </div>
      <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" :loading="loading" @click="fetch">
        Refresh
      </UButton>
    </div>

    <!-- ── Flow Summary Chain ────────────────────────────────────────────── -->
    <div class="rounded-2xl border border-(--surface-border) p-6 shadow-xl overflow-x-auto" style="background:var(--surface-raised);">
      <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-5">Platform-Wide Lifetime Flow</p>
      <div class="flex items-center gap-3 min-w-max">

        <button class="text-center group" @click="filterByType('DEPOSIT')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">Deposited</p>
          <p class="text-xl font-bold text-green-400 group-hover:text-green-300 transition-colors tabular-nums">
            {{ fmt(summary.totalDeposited) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

        <UIcon name="i-heroicons:arrow-right" class="w-5 h-5 text-white/20 flex-shrink-0" />

        <button class="text-center group" @click="filterByType('GAME_ENTRY')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">Wagered</p>
          <p class="text-xl font-bold text-yellow-400 group-hover:text-yellow-300 transition-colors tabular-nums">
            {{ fmt(summary.totalWagered) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

        <UIcon name="i-heroicons:arrow-right" class="w-5 h-5 text-white/20 flex-shrink-0" />

        <button class="text-center group" @click="filterByType('PRIZE_WIN')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">Prizes Out</p>
          <p class="text-xl font-bold text-red-400 group-hover:text-red-300 transition-colors tabular-nums">
            {{ fmt(summary.totalPrizesOut) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

        <UIcon name="i-heroicons:arrow-right" class="w-5 h-5 text-white/20 flex-shrink-0" />

        <button class="text-center group" @click="filterByType('COMMISSION')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">House Kept</p>
          <p class="text-xl font-bold text-blue-400 group-hover:text-blue-300 transition-colors tabular-nums">
            {{ fmt(summary.houseKept) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

        <UIcon name="i-heroicons:arrow-right" class="w-5 h-5 text-white/20 flex-shrink-0" />

        <button class="text-center group" @click="filterByType('REFUND')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">Refunds</p>
          <p class="text-xl font-bold text-orange-400 group-hover:text-orange-300 transition-colors tabular-nums">
            {{ fmt(summary.refundsIssued) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

      </div>
    </div>

    <!-- ── Filters ───────────────────────────────────────────────────────── -->
    <div class="flex flex-wrap gap-3 bg-white/5 p-3 rounded-2xl border border-white/5 shadow-inner">
      <UInput
        v-model="filterSearch"
        icon="i-heroicons:magnifying-glass"
        placeholder="Search player…"
        class="flex-1 min-w-48"
        @input="onSearch"
      />
      <UInput v-model="filterFrom" type="date" class="w-40" @change="page = 1; fetch()" />
      <UInput v-model="filterTo" type="date" class="w-40" @change="page = 1; fetch()" />
      <USelect
        v-model="filterDirection"
        :items="directionOptions"
        value-key="value"
        class="w-44"
      />
      <UButton
        v-if="filterSearch || filterFrom || filterTo || filterDirection || filterTypes.length"
        color="neutral" variant="ghost" icon="i-heroicons:x-mark"
        @click="resetFilters"
      >
        Reset
      </UButton>
    </div>

    <!-- Active type filter badge -->
    <div v-if="filterTypes.length" class="flex items-center gap-2">
      <span class="text-xs text-white/40">Showing only:</span>
      <UBadge
        v-for="t in filterTypes" :key="t"
        :color="typeColor(t)" variant="soft" size="sm"
        class="cursor-pointer"
        @click="filterTypes = filterTypes.filter(x => x !== t); page = 1; fetch()"
      >
        {{ t }} ✕
      </UBadge>
    </div>

    <!-- ── Unified Ledger ─────────────────────────────────────────────────── -->
    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <UTable :columns="columns" :data="rows" :loading="loading">

        <template #createdAt-cell="{ row }">
          <span class="text-white/50 text-xs font-mono">
            {{ new Date(row.original.createdAt).toLocaleString() }}
          </span>
        </template>

        <template #type-cell="{ row }">
          <UBadge :color="typeColor(row.original.type)" variant="soft" size="sm">
            {{ row.original.type }}
          </UBadge>
        </template>

        <template #direction-cell="{ row }">
          <span :class="row.original.direction === 'IN' ? 'text-green-400' : 'text-red-400'"
            class="text-xs font-bold">
            {{ row.original.direction === 'IN' ? '▲ IN' : '▼ OUT' }}
          </span>
        </template>

        <template #amount-cell="{ row }">
          <span class="font-bold font-mono tabular-nums"
            :class="row.original.direction === 'IN' ? 'text-green-400' : 'text-red-400'">
            {{ row.original.direction === 'IN' ? '+' : '-' }}{{ Number(row.original.amount).toFixed(2) }} ETB
          </span>
        </template>

        <template #playerName-cell="{ row }">
          <span v-if="row.original.playerName" class="text-white/70 text-sm font-medium">
            {{ row.original.playerName }}
          </span>
          <span v-else class="text-white/20">—</span>
        </template>

        <template #gameId-cell="{ row }">
          <NuxtLink
            v-if="row.original.gameId"
            to="/games"
            class="text-xs font-mono text-blue-400 hover:text-blue-300 transition-colors"
            :title="row.original.gameId"
          >
            {{ row.original.gameId.slice(0, 8) }}…
          </NuxtLink>
          <span v-else class="text-white/20">—</span>
        </template>

        <template #source-cell="{ row }">
          <span class="text-xs font-medium" :class="sourceColor(row.original.source)">
            {{ row.original.source }}
          </span>
        </template>

        <template #balanceAfter-cell="{ row }">
          <span v-if="row.original.balanceAfter !== undefined" class="font-mono text-white/50 text-sm">
            {{ Number(row.original.balanceAfter).toFixed(2) }}
          </span>
          <span v-else class="text-white/20">—</span>
        </template>

      </UTable>

      <div v-if="rows.length === 0 && !loading" class="py-16 text-center text-white/30">
        <UIcon name="i-heroicons:arrows-right-left" class="w-10 h-10 mx-auto mb-3 opacity-20" />
        <p>No transactions found</p>
      </div>
    </div>

    <!-- Pagination -->
    <div class="flex items-center justify-between px-1">
      <p class="text-sm text-white/40">{{ total }} total entries</p>
      <div class="flex items-center gap-2">
        <UButton size="xs" color="neutral" variant="soft" :disabled="page <= 1" @click="page--">Previous</UButton>
        <span class="text-sm text-white/60 font-mono">{{ page }} / {{ totalPages }}</span>
        <UButton size="xs" color="neutral" variant="soft" :disabled="page >= totalPages" @click="page++">Next</UButton>
      </div>
    </div>
  </div>
</template>
