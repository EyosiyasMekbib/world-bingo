<script setup lang="ts">
interface GameRow {
  id: string
  title: string
  status: string
  ticketPrice: number
  maxPlayers: number
  minPlayers: number
  houseEdgePct: number
  pattern: string
  createdAt: string
  endedAt?: string
  winnerId?: string
  _count?: { entries: number }
}

const { getGames, cancelGame, startGame } = useAdminApi()
const { apiFetch } = useAdminAuth()
const toast = useToast()

const statusOptions = [
  { label: 'All', value: '__ALL__' },
  { label: 'Waiting', value: 'WAITING' },
  { label: 'Starting', value: 'STARTING' },
  { label: 'In Progress', value: 'IN_PROGRESS' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Cancelled', value: 'CANCELLED' },
]

const patternOptions = ['ANY_LINE', 'FULL_HOUSE', 'FOUR_CORNERS', 'T_SHAPE', 'X_SHAPE', 'U_SHAPE', 'DIAMOND']

const columns = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'title', header: 'Title' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'ticketPrice', header: 'Price (ETB)' },
  { accessorKey: 'players', header: 'Players' },
  { accessorKey: 'pattern', header: 'Pattern' },
  { accessorKey: 'houseEdgePct', header: 'House Edge %' },
  { accessorKey: 'createdAt', header: 'Created' },
  { accessorKey: 'actions', header: 'Actions' },
]

const games = ref<GameRow[]>([])
const loading = ref(false)
const selectedStatus = ref('__ALL__')
const page = ref(1)
const total = ref(0)
const limit = 15
const showCreateModal = ref(false)
const showCancelConfirm = ref(false)
const selectedGameId = ref<string | null>(null)

const totalPages = computed(() => Math.ceil(total.value / limit))

const newGame = reactive({
  title: '',
  ticketPrice: 20,
  maxPlayers: 70,
  minPlayers: 4,
  houseEdgePct: 10,
  pattern: 'ANY_LINE',
})

const creating = ref(false)
const createError = ref('')

const refreshGames = async () => {
  loading.value = true
  try {
    const result = await getGames({
      status: selectedStatus.value === '__ALL__' ? undefined : selectedStatus.value,
      page: page.value,
      limit,
    })
    if (Array.isArray(result)) {
      games.value = result
      total.value = result.length
    } else {
      games.value = (result as any).data ?? result
      total.value = (result as any).pagination?.total ?? games.value.length
    }
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch games', color: 'error' })
  } finally {
    loading.value = false
  }
}

const handleCreate = async () => {
  creating.value = true
  createError.value = ''
  try {
    await apiFetch('/games', {
      method: 'POST',
      body: {
        title: newGame.title,
        ticketPrice: newGame.ticketPrice,
        maxPlayers: newGame.maxPlayers,
        minPlayers: newGame.minPlayers,
        houseEdgePct: newGame.houseEdgePct,
        pattern: newGame.pattern,
      },
    })
    toast.add({ title: 'Game Created ✅', color: 'success' })
    showCreateModal.value = false
    refreshGames()
  } catch (e: any) {
    createError.value = e?.data?.message ?? e?.message ?? 'Failed to create game'
  } finally {
    creating.value = false
  }
}

const handleStart = async (id: string) => {
  try {
    await startGame(id)
    toast.add({ title: 'Game Starting ▶️', color: 'success' })
    refreshGames()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to start game', color: 'error' })
  }
}

const confirmCancel = (id: string) => {
  selectedGameId.value = id
  showCancelConfirm.value = true
}

const handleCancel = async () => {
  if (!selectedGameId.value) return
  try {
    await cancelGame(selectedGameId.value)
    toast.add({ title: 'Game Cancelled', description: 'All players refunded', color: 'warning' })
    showCancelConfirm.value = false
    refreshGames()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to cancel', color: 'error' })
  }
}

const statusColor = (s: string) => {
  if (s === 'WAITING') return 'warning'
  if (s === 'IN_PROGRESS' || s === 'STARTING') return 'success'
  if (s === 'COMPLETED') return 'neutral'
  if (s === 'CANCELLED') return 'error'
  return 'neutral'
}

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}

const viewMode = ref<'table' | 'card'>('table')

watch([selectedStatus, page], refreshGames)
onMounted(refreshGames)
</script>

<template>
  <div class="space-y-6 pb-20 md:pb-0">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Active Games</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Create and manage bingo sessions</p>
      </div>
      <div class="flex items-center gap-2">
        <UButtonGroup size="sm">
          <UButton
            :variant="viewMode === 'table' ? 'solid' : 'ghost'"
            color="neutral"
            icon="i-heroicons:table-cells"
            @click="viewMode = 'table'"
          />
          <UButton
            :variant="viewMode === 'card' ? 'solid' : 'ghost'"
            color="neutral"
            icon="i-heroicons:squares-2x2"
            @click="viewMode = 'card'"
          />
        </UButtonGroup>
        <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" label="Refresh" @click="refreshGames" />
        <UButton icon="i-heroicons:plus" color="primary" @click="showCreateModal = true">New Game</UButton>
      </div>
    </div>

    <!-- Toolbar Filters -->
    <div class="flex items-center gap-3 flex-wrap bg-white/5 p-3 rounded-2xl border border-white/5 shadow-inner">
      <USelect
        v-model="selectedStatus"
        :items="statusOptions"
        icon="i-heroicons:funnel"
        placeholder="Filter by Status"
        class="w-full sm:w-60"
        value-key="value"
      />
    </div>

    <!-- Table View -->
    <div v-if="viewMode === 'table'" class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
      <UTable :columns="columns" :data="games" :loading="loading">
        <template #id-cell="{ row }">
          <div class="flex items-center gap-1 group">
            <span class="font-mono text-[10px] text-white/30 truncate w-16">{{ (row.original as unknown as GameRow).id.split('-')[0] }}</span>
            <UButton icon="i-heroicons:clipboard-document" variant="ghost" color="neutral" size="xs" class="opacity-0 group-hover:opacity-100 transition-opacity p-0.5" @click="copyToClipboard((row.original as unknown as GameRow).id)" />
          </div>
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="statusColor((row.original as unknown as GameRow).status)" variant="soft">
            {{ (row.original as unknown as GameRow).status }}
          </UBadge>
        </template>
        <template #players-cell="{ row }">
          <span class="text-white/70 font-medium">
            {{ (row.original as unknown as GameRow)._count?.entries ?? 0 }} / {{ (row.original as unknown as GameRow).maxPlayers }}
          </span>
        </template>
        <template #createdAt-cell="{ row }">
          <span class="text-white/40 text-xs font-medium">{{ new Date((row.original as unknown as GameRow).createdAt).toLocaleString() }}</span>
        </template>
        <template #houseEdgePct-cell="{ row }">
          <span class="text-white/60 font-medium">{{ (row.original as unknown as GameRow).houseEdgePct }}%</span>
        </template>
        <template #ticketPrice-cell="{ row }">
          <span class="font-bold text-yellow-500">{{ (row.original as unknown as GameRow).ticketPrice }} ETB</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-2">
            <UButton v-if="(row.original as unknown as GameRow).status === 'WAITING'" size="xs" color="success" variant="soft" icon="i-heroicons:play" @click="handleStart((row.original as unknown as GameRow).id)">Start</UButton>
            <UButton v-if="['WAITING', 'STARTING', 'IN_PROGRESS'].includes((row.original as unknown as GameRow).status)" size="xs" color="error" variant="soft" icon="i-heroicons:x-mark" @click="confirmCancel((row.original as unknown as GameRow).id)">Cancel</UButton>
          </div>
        </template>
      </UTable>

      <div v-if="totalPages > 1" class="flex justify-center gap-2 py-3 border-t border-(--surface-border)">
        <UButton :disabled="page <= 1" variant="ghost" icon="i-heroicons:chevron-left" @click="page--" />
        <span class="text-sm text-white/40 self-center font-medium">Page {{ page }} / {{ totalPages }}</span>
        <UButton :disabled="page >= totalPages" variant="ghost" icon="i-heroicons:chevron-right" @click="page++" />
      </div>
    </div>

    <!-- Card View -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      <div v-if="loading" class="col-span-full flex justify-center py-12">
        <UIcon name="i-heroicons:arrow-path" class="w-8 h-8 animate-spin text-white/20" />
      </div>
      <div v-else-if="!games.length" class="col-span-full text-center py-12 text-white/30 bg-white/5 rounded-3xl border border-white/5">
        <UIcon name="i-heroicons:puzzle-piece" class="w-12 h-12 mx-auto mb-3 opacity-20" />
        <p class="text-lg font-medium">No sessions scheduled</p>
      </div>
      <div
        v-for="g in games" :key="g.id"
        class="relative p-5 rounded-3xl border border-white/5 bg-(--surface-raised) shadow-lg"
      >
        <div class="flex justify-between items-start mb-4">
          <div class="flex-1">
            <h3 class="font-bold text-zinc-100 truncate pr-2">{{ g.title }}</h3>
            <p class="text-[10px] text-white/30 font-mono">{{ g.id.split('-')[0] }}</p>
          </div>
          <UBadge :color="statusColor(g.status)" variant="soft" size="xs">{{ g.status }}</UBadge>
        </div>

        <div class="space-y-3 mb-5">
          <div class="flex justify-between items-baseline">
            <span class="text-[10px] text-white/30 uppercase tracking-widest font-bold">Ticket</span>
            <span class="text-xl font-black text-yellow-500">{{ g.ticketPrice }} <span class="text-[10px] font-normal opacity-50">ETB</span></span>
          </div>
          <div class="flex items-center justify-between text-xs">
            <span class="text-white/40">Participants</span>
            <div class="flex flex-col items-end">
              <span class="font-bold text-zinc-200">{{ g._count?.entries ?? 0 }} / {{ g.maxPlayers }}</span>
              <div class="w-24 h-1 bg-white/5 rounded-full mt-1 overflow-hidden">
                <div class="h-full bg-primary" :style="{ width: `${((g._count?.entries ?? 0) / g.maxPlayers) * 100}%` }" />
              </div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2 text-[10px] text-white/40 pt-1">
            <div>Pattern: <span class="text-white/60 font-bold tracking-tight">{{ g.pattern }}</span></div>
            <div class="text-right">Edge: <span class="text-white/60 font-bold">{{ g.houseEdgePct }}%</span></div>
          </div>
        </div>

        <div class="pt-3 border-t border-white/5 flex gap-2">
          <UButton v-if="g.status === 'WAITING'" size="xs" color="success" block icon="i-heroicons:play" @click="handleStart(g.id)">Start</UButton>
          <UButton v-if="['WAITING', 'STARTING', 'IN_PROGRESS'].includes(g.status)" size="xs" color="error" variant="soft" icon="i-heroicons:x-mark" @click="confirmCancel(g.id)">Cancel</UButton>
        </div>
      </div>
    </div>

    <!-- Create Game Modal -->
    <UModal v-model:open="showCreateModal" title="Create New Game" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-4">
          <div>
            <label class="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 block">Title</label>
            <UInput v-model="newGame.title" placeholder="e.g. Quick Bingo #1" />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 block">Ticket Price (ETB)</label>
              <UInput v-model.number="newGame.ticketPrice" type="number" min="1" />
            </div>
            <div>
              <label class="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 block">Max Capacity</label>
              <UInput v-model.number="newGame.maxPlayers" type="number" min="2" max="500" />
            </div>
            <div>
              <label class="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 block">Min Start Count</label>
              <UInput v-model.number="newGame.minPlayers" type="number" min="2" />
            </div>
            <div>
              <label class="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 block">House Commission %</label>
              <UInput v-model.number="newGame.houseEdgePct" type="number" min="0" max="50" />
            </div>
          </div>
          <div>
            <label class="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 block">Winning Pattern</label>
            <USelect v-model="newGame.pattern" :items="patternOptions.map(p => ({ label: p, value: p }))" value-key="value" />
          </div>
          <p v-if="createError" class="text-red-400 text-sm">{{ createError }}</p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showCreateModal = false">Cancel</UButton>
        <UButton color="primary" :loading="creating" @click="handleCreate">Create Game</UButton>
      </template>
    </UModal>

    <!-- Cancel Confirm Modal -->
    <UModal v-model:open="showCancelConfirm" title="Cancel Game?" :ui="{ footer: 'justify-end' }">
      <template #body>
        <p class="text-sm text-zinc-400">The game will be cancelled and all players will be refunded. This cannot be undone.</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showCancelConfirm = false">Back</UButton>
        <UButton color="error" @click="handleCancel">Confirm Cancel</UButton>
      </template>
    </UModal>
  </div>
</template>
