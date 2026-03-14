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
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to load tournaments', color: 'error' })
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
    toast.add({ title: 'Tournament Created', color: 'success' })
    showCreateModal.value = false
    Object.assign(newTournament, { title: '', entryFee: 100, maxPlayers: 16, houseEdgePct: 10, scheduledAt: '' })
    await fetchTournaments()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to create tournament', color: 'error' })
  }
}

async function startTournament(id: string) {
  try {
    await apiFetch(`/tournaments/${id}/start`, { method: 'POST' })
    toast.add({ title: '🏆 Tournament Started!', color: 'success' })
    await fetchTournaments()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to start tournament', color: 'error' })
  }
}

async function cancelTournament(id: string) {
  if (!confirm('Cancel this tournament? All entry fees will be refunded.')) return
  try {
    await apiFetch(`/tournaments/${id}/cancel`, { method: 'POST' })
    toast.add({ title: 'Tournament Cancelled', description: 'All entry fees refunded.', color: 'warning' })
    await fetchTournaments()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to cancel', color: 'error' })
  }
}

function statusColor(status: string): 'success' | 'warning' | 'info' | 'neutral' | 'error' {
  switch (status) {
    case TournamentStatus.REGISTRATION: return 'success'
    case TournamentStatus.IN_PROGRESS: return 'warning'
    case TournamentStatus.COMPLETED: return 'info'
    case TournamentStatus.CANCELLED: return 'neutral'
    default: return 'neutral'
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
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">🏆 Tournaments</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Manage tournament events and prizes</p>
      </div>
      <UButton icon="i-heroicons:plus" color="primary" @click="showCreateModal = true">
        Create Tournament
      </UButton>
    </div>

    <!-- Filter + refresh -->
    <div class="flex gap-2 flex-wrap">
      <USelect
        v-model="selectedStatus"
        :items="statusOptions"
        value-key="value"
        class="w-48"
      />
      <UButton color="neutral" variant="ghost" icon="i-heroicons:arrow-path" :loading="loading" @click="fetchTournaments">
        Refresh
      </UButton>
    </div>

    <!-- Stats Cards -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-white tracking-tight">{{ tournaments.length }}</div>
        <div class="text-xs text-white/40 mt-1 uppercase tracking-widest font-bold">Total</div>
      </div>
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-emerald-400 tracking-tight">
          {{ tournaments.filter(t => t.status === TournamentStatus.REGISTRATION).length }}
        </div>
        <div class="text-xs text-white/40 mt-1 uppercase tracking-widest font-bold">Open Registration</div>
      </div>
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-yellow-500 tracking-tight">
          {{ tournaments.filter(t => t.status === TournamentStatus.IN_PROGRESS).length }}
        </div>
        <div class="text-xs text-white/40 mt-1 uppercase tracking-widest font-bold">Live</div>
      </div>
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-cyan-400 tracking-tight">
          {{ tournaments.reduce((s, t) => s + t.currentPlayers, 0) }}
        </div>
        <div class="text-xs text-white/40 mt-1 uppercase tracking-widest font-bold">Total Participants</div>
      </div>
    </div>

    <!-- Table -->
    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-(--surface-border)" style="background:var(--surface-overlay);">
            <tr>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Title</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Status</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Entry Fee</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Players</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Prize Pool</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Created</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr v-if="loading">
              <td colspan="7" class="px-4 py-12 text-center text-zinc-500">
                <div class="flex justify-center"><UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin" /></div>
              </td>
            </tr>
            <tr v-else-if="!filtered.length">
              <td colspan="7" class="px-4 py-12 text-center text-zinc-600">
                <UIcon name="i-heroicons:trophy" class="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No tournaments found</p>
              </td>
            </tr>
            <tr v-for="t in filtered" :key="t.id" class="hover:bg-white/3 transition-colors">
              <td class="px-4 py-3 font-medium text-zinc-200">{{ t.title }}</td>
              <td class="px-4 py-3">
                <UBadge :color="statusColor(t.status)" variant="soft">{{ statusLabel(t.status) }}</UBadge>
              </td>
              <td class="px-4 py-3 text-zinc-300">{{ Number(t.entryFee).toLocaleString() }} ETB</td>
              <td class="px-4 py-3">
                <span class="font-bold text-yellow-500">
                  {{ Number(t.prizePool).toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} ETB
                </span>
              </td>
              <td class="px-4 py-3 text-white/40 text-xs font-medium">{{ new Date(t.createdAt).toLocaleDateString() }}</td>
              <td class="px-4 py-3 text-right">
                <div class="flex gap-2 justify-end">
                  <UButton
                    v-if="t.status === TournamentStatus.REGISTRATION"
                    size="xs" color="success" variant="soft" icon="i-heroicons:play"
                    @click="startTournament(t.id)"
                  >Start</UButton>
                  <UButton
                    v-if="t.status !== TournamentStatus.COMPLETED && t.status !== TournamentStatus.CANCELLED"
                    size="xs" color="error" variant="soft" icon="i-heroicons:x-mark"
                    @click="cancelTournament(t.id)"
                  >Cancel</UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Create Modal -->
    <UModal v-model:open="showCreateModal" title="Create Tournament" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-4">
          <div>
            <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Title</label>
            <UInput v-model="newTournament.title" placeholder="e.g. Summer Bingo Championship" />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Entry Fee (ETB)</label>
              <UInput v-model.number="newTournament.entryFee" type="number" min="0" />
            </div>
            <div>
              <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Max Players</label>
              <UInput v-model.number="newTournament.maxPlayers" type="number" min="2" max="128" />
            </div>
          </div>
          <div>
            <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">House Edge %</label>
            <UInput v-model.number="newTournament.houseEdgePct" type="number" min="0" max="50" />
          </div>
          <div>
            <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Scheduled Start (optional)</label>
            <UInput v-model="newTournament.scheduledAt" type="datetime-local" />
          </div>

          <!-- Prize pool estimate -->
          <div class="rounded-xl border border-yellow-500/20 p-4 text-sm" style="background:var(--surface-overlay);">
            <div class="font-bold text-yellow-500 mb-1 uppercase tracking-widest text-[10px]">Prize Pool Estimate</div>
            <div class="text-white/50 text-xs">
              {{ newTournament.maxPlayers || 0 }} players × {{ newTournament.entryFee || 0 }} ETB — {{ newTournament.houseEdgePct || 0 }}% house edge:
            </div>
            <div class="text-yellow-500 font-bold text-xl mt-1 tracking-tight">
              ~{{ (newTournament.maxPlayers * newTournament.entryFee * (1 - newTournament.houseEdgePct / 100)).toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} <span class="text-[10px] text-white/40">ETB</span>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showCreateModal = false">Cancel</UButton>
        <UButton
          color="primary"
          :disabled="!newTournament.title || newTournament.entryFee < 0"
          @click="createTournament"
        >Create Tournament</UButton>
      </template>
    </UModal>
  </div>
</template>
