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
      <h1 class="text-2xl font-semibold text-gray-900">Game Management</h1>
      <div class="flex gap-3 items-center">
        <USelect v-model="selectedStatus" :options="statusOptions" option-attribute="label" value-attribute="value" />
        <UButton icon="i-heroicons-arrow-path" variant="ghost" @click="refreshGames">Refresh</UButton>
        <UButton icon="i-heroicons-plus" color="primary" @click="showCreateModal = true">New Game</UButton>
      </div>
    </div>

    <UCard>
      <UTable :columns="columns" :rows="games" :loading="loading">
        <template #status-cell="{ row }">
          <UBadge :color="statusColor((row.original as unknown as GameRow).status)" variant="soft">
            {{ (row.original as unknown as GameRow).status }}
          </UBadge>
        </template>
        <template #players-cell="{ row }">
          {{ (row.original as unknown as GameRow)._count?.entries ?? 0 }} / {{ (row.original as unknown as GameRow).maxPlayers }}
        </template>
        <template #createdAt-cell="{ row }">
          {{ new Date((row.original as unknown as GameRow).createdAt).toLocaleString() }}
        </template>
        <template #houseEdgePct-cell="{ row }">
          {{ (row.original as unknown as GameRow).houseEdgePct }}%
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-2">
            <UButton
              v-if="(row.original as unknown as GameRow).status === 'WAITING'"
              size="xs"
              color="success"
              variant="soft"
              icon="i-heroicons-play"
              @click="handleStart((row.original as unknown as GameRow).id)"
            >Start</UButton>
            <UButton
              v-if="['WAITING', 'STARTING', 'IN_PROGRESS'].includes((row.original as unknown as GameRow).status)"
              size="xs"
              color="error"
              variant="soft"
              icon="i-heroicons-stop"
              @click="confirmCancel((row.original as unknown as GameRow).id)"
            >Cancel</UButton>
          </div>
        </template>
      </UTable>

      <div v-if="totalPages > 1" class="flex justify-center gap-2 mt-4 pb-2">
        <UButton :disabled="page <= 1" variant="ghost" icon="i-heroicons-chevron-left" @click="page--" />
        <span class="text-sm self-center">Page {{ page }} / {{ totalPages }}</span>
        <UButton :disabled="page >= totalPages" variant="ghost" icon="i-heroicons-chevron-right" @click="page++" />
      </div>
    </UCard>

    <!-- Create Game Modal -->
    <UModal v-model="showCreateModal">
      <UCard>
        <template #header>
          <h3 class="text-base font-semibold">Create New Game</h3>
        </template>
        <div class="p-4 space-y-4">
          <div>
            <label class="text-sm text-gray-600">Title</label>
            <UInput v-model="newGame.title" placeholder="e.g. Quick Bingo #1" />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-sm text-gray-600">Ticket Price (ETB)</label>
              <UInput v-model.number="newGame.ticketPrice" type="number" min="1" />
            </div>
            <div>
              <label class="text-sm text-gray-600">Max Players</label>
              <UInput v-model.number="newGame.maxPlayers" type="number" min="2" max="500" />
            </div>
            <div>
              <label class="text-sm text-gray-600">Min Players</label>
              <UInput v-model.number="newGame.minPlayers" type="number" min="2" />
            </div>
            <div>
              <label class="text-sm text-gray-600">House Edge %</label>
              <UInput v-model.number="newGame.houseEdgePct" type="number" min="0" max="50" />
            </div>
          </div>
          <div>
            <label class="text-sm text-gray-600">Win Pattern</label>
            <USelect v-model="newGame.pattern" :options="patternOptions.map(p => ({ label: p, value: p }))" option-attribute="label" value-attribute="value" />
          </div>
          <p v-if="createError" class="text-red-500 text-sm">{{ createError }}</p>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="showCreateModal = false">Cancel</UButton>
            <UButton color="primary" :loading="creating" @click="handleCreate">Create Game</UButton>
          </div>
        </template>
      </UCard>
    </UModal>

    <!-- Cancel Confirm Modal -->
    <UModal v-model="showCancelConfirm">
      <UCard>
        <template #header>
          <h3 class="text-base font-semibold">Cancel Game?</h3>
        </template>
        <div class="p-4">
          <p class="text-sm text-gray-600">The game will be cancelled and all players will be refunded. This cannot be undone.</p>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="showCancelConfirm = false">Back</UButton>
            <UButton color="error" @click="handleCancel">Confirm Cancel</UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </div>
</template>
