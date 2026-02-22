<script setup lang="ts">
import type { TournamentDto } from '@world-bingo/shared-types'
import { TournamentStatus } from '@world-bingo/shared-types'

const { apiFetch } = useAdminAuth()
const toast = useToast()

const tournaments = ref<TournamentDto[]>([])
const loading = ref(false)
const showCreateModal = ref(false)

const newTournament = reactive({
  title: '',
  entryFee: 100,
  maxPlayers: 16,
  houseEdgePct: 10,
  scheduledAt: '',
})

const statusOptions = [
  { label: 'All', value: '' },
  { label: 'Registration', value: TournamentStatus.REGISTRATION },
  { label: 'In Progress', value: TournamentStatus.IN_PROGRESS },
  { label: 'Completed', value: TournamentStatus.COMPLETED },
  { label: 'Cancelled', value: TournamentStatus.CANCELLED },
]
const selectedStatus = ref('')

const filtered = computed(() =>
  selectedStatus.value
    ? tournaments.value.filter((t) => t.status === selectedStatus.value)
    : tournaments.value,
)

const columns = [
  { accessorKey: 'title', header: 'Title' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'entryFee', header: 'Entry Fee (ETB)' },
  { accessorKey: 'players', header: 'Players' },
  { accessorKey: 'prizePool', header: 'Prize Pool (ETB)' },
  { accessorKey: 'rounds', header: 'Rounds' },
  { accessorKey: 'createdAt', header: 'Created' },
  { accessorKey: 'actions', header: 'Actions' },
]

async function fetchTournaments() {
  loading.value = true
  try {
    const data = await apiFetch<TournamentDto[]>('/tournaments')
    tournaments.value = data
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to load tournaments', color: 'red' })
  } finally {
    loading.value = false
  }
}

async function createTournament() {
  try {
    await apiFetch<TournamentDto>('/tournaments', {
      method: 'POST',
      body: {
        title: newTournament.title,
        entryFee: Number(newTournament.entryFee),
        maxPlayers: Number(newTournament.maxPlayers),
        houseEdgePct: Number(newTournament.houseEdgePct),
        scheduledAt: newTournament.scheduledAt || undefined,
      },
    })
    toast.add({ title: 'Tournament Created', color: 'green' })
    showCreateModal.value = false
    Object.assign(newTournament, { title: '', entryFee: 100, maxPlayers: 16, houseEdgePct: 10, scheduledAt: '' })
    await fetchTournaments()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to create tournament', color: 'red' })
  }
}

async function startTournament(id: string) {
  try {
    await apiFetch(`/tournaments/${id}/start`, { method: 'POST' })
    toast.add({ title: '🏆 Tournament Started!', color: 'green' })
    await fetchTournaments()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to start tournament', color: 'red' })
  }
}

async function cancelTournament(id: string) {
  if (!confirm('Cancel this tournament? All entry fees will be refunded.')) return
  try {
    await apiFetch(`/tournaments/${id}/cancel`, { method: 'POST' })
    toast.add({ title: 'Tournament Cancelled', description: 'All entry fees refunded.', color: 'amber' })
    await fetchTournaments()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to cancel', color: 'red' })
  }
}

function statusColor(status: string): 'green' | 'red' | 'amber' | 'gray' | 'blue' {
  switch (status) {
    case TournamentStatus.REGISTRATION: return 'green'
    case TournamentStatus.IN_PROGRESS: return 'red'
    case TournamentStatus.COMPLETED: return 'blue'
    case TournamentStatus.CANCELLED: return 'gray'
    default: return 'gray'
  }
}

function statusLabel(status: string) {
  switch (status) {
    case TournamentStatus.REGISTRATION: return 'Registration'
    case TournamentStatus.IN_PROGRESS: return 'In Progress'
    case TournamentStatus.COMPLETED: return 'Completed'
    case TournamentStatus.CANCELLED: return 'Cancelled'
    default: return status
  }
}

onMounted(fetchTournaments)
</script>

<template>
  <div class="p-6 space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">🏆 Tournaments</h1>
        <p class="text-gray-400 text-sm mt-1">Manage tournament creation, lifecycle, and results</p>
      </div>
      <UButton icon="i-heroicons-plus" @click="showCreateModal = true" color="amber">
        Create Tournament
      </UButton>
    </div>

    <!-- Filter -->
    <div class="flex gap-3 flex-wrap">
      <USelectMenu
        v-model="selectedStatus"
        :options="statusOptions"
        value-attribute="value"
        option-attribute="label"
        placeholder="All Statuses"
        class="w-48"
      />
      <UButton variant="ghost" icon="i-heroicons-arrow-path" :loading="loading" @click="fetchTournaments">
        Refresh
      </UButton>
    </div>

    <!-- Stats Cards -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <UCard class="text-center">
        <div class="text-2xl font-bold text-white">{{ tournaments.length }}</div>
        <div class="text-xs text-gray-400 mt-1">Total Tournaments</div>
      </UCard>
      <UCard class="text-center">
        <div class="text-2xl font-bold text-green-400">
          {{ tournaments.filter(t => t.status === TournamentStatus.REGISTRATION).length }}
        </div>
        <div class="text-xs text-gray-400 mt-1">Open Registration</div>
      </UCard>
      <UCard class="text-center">
        <div class="text-2xl font-bold text-red-400">
          {{ tournaments.filter(t => t.status === TournamentStatus.IN_PROGRESS).length }}
        </div>
        <div class="text-xs text-gray-400 mt-1">Live</div>
      </UCard>
      <UCard class="text-center">
        <div class="text-2xl font-bold text-amber-400">
          {{ tournaments.reduce((s, t) => s + t.currentPlayers, 0) }}
        </div>
        <div class="text-xs text-gray-400 mt-1">Total Participants</div>
      </UCard>
    </div>

    <!-- Table -->
    <UCard>
      <UTable :loading="loading" :columns="columns" :rows="filtered.map(t => ({
        ...t,
        players: `${t.currentPlayers}/${t.maxPlayers}`,
        createdAt: new Date(t.createdAt).toLocaleDateString(),
      }))">
        <template #status-data="{ row }">
          <UBadge :color="statusColor(row.status)" variant="subtle">
            {{ statusLabel(row.status) }}
          </UBadge>
        </template>

        <template #entryFee-data="{ row }">
          {{ Number(row.entryFee).toLocaleString() }} ETB
        </template>

        <template #prizePool-data="{ row }">
          <span class="text-amber-400 font-bold">
            {{ Number(row.prizePool).toLocaleString('en-ET', { minimumFractionDigits: 2 }) }}
          </span>
        </template>

        <template #actions-data="{ row }">
          <div class="flex gap-2">
            <UButton
              v-if="row.status === TournamentStatus.REGISTRATION"
              size="xs"
              color="green"
              icon="i-heroicons-play"
              @click="startTournament(row.id)"
            >
              Start
            </UButton>
            <UButton
              v-if="row.status !== TournamentStatus.COMPLETED && row.status !== TournamentStatus.CANCELLED"
              size="xs"
              color="red"
              variant="ghost"
              icon="i-heroicons-x-mark"
              @click="cancelTournament(row.id)"
            >
              Cancel
            </UButton>
            <UButton
              size="xs"
              variant="ghost"
              icon="i-heroicons-chart-bar"
              :to="`/tournaments/${row.id}`"
            >
              View
            </UButton>
          </div>
        </template>
      </UTable>
    </UCard>

    <!-- Create Modal -->
    <UModal v-model="showCreateModal">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-bold">Create Tournament</h3>
            <UButton icon="i-heroicons-x-mark" variant="ghost" @click="showCreateModal = false" />
          </div>
        </template>

        <div class="space-y-4">
          <UFormGroup label="Title">
            <UInput v-model="newTournament.title" placeholder="e.g. Summer Bingo Championship" />
          </UFormGroup>
          <div class="grid grid-cols-2 gap-4">
            <UFormGroup label="Entry Fee (ETB)">
              <UInput v-model.number="newTournament.entryFee" type="number" min="0" />
            </UFormGroup>
            <UFormGroup label="Max Players">
              <UInput v-model.number="newTournament.maxPlayers" type="number" min="2" max="128" />
            </UFormGroup>
          </div>
          <UFormGroup label="House Edge %">
            <UInput v-model.number="newTournament.houseEdgePct" type="number" min="0" max="50" />
          </UFormGroup>
          <UFormGroup label="Scheduled Start (optional)">
            <UInput v-model="newTournament.scheduledAt" type="datetime-local" />
          </UFormGroup>

          <div class="bg-gray-800 rounded-lg p-3 text-sm text-gray-300">
            <div class="font-semibold mb-1">Prize Pool Estimate</div>
            <div>
              With {{ newTournament.maxPlayers }} players × {{ newTournament.entryFee }} ETB entry
              and {{ newTournament.houseEdgePct }}% house edge:<br>
              <span class="text-amber-400 font-bold">
                ~{{ (newTournament.maxPlayers * newTournament.entryFee * (1 - newTournament.houseEdgePct / 100)).toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} ETB
              </span>
            </div>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end gap-3">
            <UButton variant="ghost" @click="showCreateModal = false">Cancel</UButton>
            <UButton
              color="amber"
              :disabled="!newTournament.title || newTournament.entryFee < 0"
              @click="createTournament"
            >
              Create Tournament
            </UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </div>
</template>
