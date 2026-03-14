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
  { label: 'All', value: '' },
  { label: 'Waiting', value: 'WAITING' },
  { label: 'Starting', value: 'STARTING' },
  { label: 'In Progress', value: 'IN_PROGRESS' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Cancelled', value: 'CANCELLED' },
]

const patternOptions = ['ANY_LINE', 'FULL_HOUSE', 'FOUR_CORNERS', 'T_SHAPE', 'X_SHAPE', 'U_SHAPE', 'DIAMOND']

const columns = [
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
const selectedStatus = ref('')
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
      status: selectedStatus.value || undefined,
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

watch([selectedStatus, page], refreshGames)
onMounted(refreshGames)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Active Games</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Create and manage bingo sessions</p>
      </div>
      <div class="flex gap-2 items-center flex-wrap">
        <USelect v-model="selectedStatus" :items="statusOptions" value-key="value" class="w-40" />
        <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" @click="refreshGames">Refresh</UButton>
        <UButton icon="i-heroicons:plus" color="primary" @click="showCreateModal = true">New Game</UButton>
      </div>
    </div>

    <!-- Table card -->
    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <UTable :columns="columns" :data="games" :loading="loading">
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
            <UButton
              v-if="(row.original as unknown as GameRow).status === 'WAITING'"
              size="xs" color="success" variant="soft" icon="i-heroicons:play"
              @click="handleStart((row.original as unknown as GameRow).id)"
            >Start</UButton>
            <UButton
              v-if="['WAITING', 'STARTING', 'IN_PROGRESS'].includes((row.original as unknown as GameRow).status)"
              size="xs" color="error" variant="soft" icon="i-heroicons:x-mark"
              @click="confirmCancel((row.original as unknown as GameRow).id)"
            >Cancel</UButton>
          </div>
        </template>
      </UTable>

      <div v-if="totalPages > 1" class="flex justify-center gap-2 py-3 border-t border-(--surface-border)">
        <UButton :disabled="page <= 1" variant="ghost" icon="i-heroicons:chevron-left" @click="page--" />
        <span class="text-sm text-white/40 self-center font-medium">Page {{ page }} / {{ totalPages }}</span>
        <UButton :disabled="page >= totalPages" variant="ghost" icon="i-heroicons:chevron-right" @click="page++" />
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
