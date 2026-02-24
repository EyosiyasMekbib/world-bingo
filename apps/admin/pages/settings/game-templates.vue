<script setup lang="ts">
interface GameTemplate {
  id: string
  title: string
  ticketPrice: number
  maxPlayers: number
  minPlayers: number
  houseEdgePct: number
  pattern: string
  countdownSecs: number
  active: boolean
  createdAt: string
  _count?: { games: number }
}

const { getGameTemplates, createGameTemplate, updateGameTemplate, deleteGameTemplate } = useAdminApi()
const toast = useToast()

const patternOptions = ['ANY_LINE', 'DIAGONAL', 'FULL_CARD', 'X_PATTERN', 'CORNERS']

const templates = ref<GameTemplate[]>([])
const loading = ref(false)
const showCreateModal = ref(false)
const showDeleteConfirm = ref(false)
const selectedTemplateId = ref<string | null>(null)
const creating = ref(false)
const createError = ref('')

const newTemplate = reactive({
  title: '',
  ticketPrice: 20,
  maxPlayers: 70,
  minPlayers: 2,
  houseEdgePct: 10,
  pattern: 'ANY_LINE',
  countdownSecs: 60,
})

const refreshTemplates = async () => {
  loading.value = true
  try {
    const result = await getGameTemplates()
    templates.value = Array.isArray(result) ? result : []
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch templates', color: 'error' })
  } finally {
    loading.value = false
  }
}

const handleCreate = async () => {
  creating.value = true
  createError.value = ''
  try {
    await createGameTemplate({ ...newTemplate })
    toast.add({ title: 'Template Created ✅', description: 'A WAITING game will be created automatically', color: 'success' })
    showCreateModal.value = false
    newTemplate.title = ''
    newTemplate.ticketPrice = 20
    newTemplate.maxPlayers = 70
    newTemplate.minPlayers = 2
    newTemplate.houseEdgePct = 10
    newTemplate.pattern = 'ANY_LINE'
    newTemplate.countdownSecs = 60
    refreshTemplates()
  } catch (e: any) {
    createError.value = e?.data?.message ?? e?.message ?? 'Failed to create template'
  } finally {
    creating.value = false
  }
}

const toggleActive = async (template: GameTemplate) => {
  try {
    await updateGameTemplate(template.id, { active: !template.active })
    toast.add({
      title: template.active ? 'Template Deactivated' : 'Template Activated ✅',
      color: template.active ? 'warning' : 'success',
    })
    refreshTemplates()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to update', color: 'error' })
  }
}

const confirmDelete = (id: string) => {
  selectedTemplateId.value = id
  showDeleteConfirm.value = true
}

const handleDelete = async () => {
  if (!selectedTemplateId.value) return
  try {
    await deleteGameTemplate(selectedTemplateId.value)
    toast.add({ title: 'Template Deleted', color: 'warning' })
    showDeleteConfirm.value = false
    refreshTemplates()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to delete', color: 'error' })
  }
}

const columns = [
  { accessorKey: 'title', header: 'Title' },
  { accessorKey: 'ticketPrice', header: 'Price (ETB)' },
  { accessorKey: 'players', header: 'Min / Max Players' },
  { accessorKey: 'pattern', header: 'Pattern' },
  { accessorKey: 'houseEdgePct', header: 'House %' },
  { accessorKey: 'countdownSecs', header: 'Countdown' },
  { accessorKey: 'active', header: 'Status' },
  { accessorKey: 'waitingGames', header: 'Waiting Games' },
  { accessorKey: 'actions', header: 'Actions' },
]

onMounted(refreshTemplates)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold text-white">Game Templates</h1>
        <p class="text-sm text-zinc-500 mt-0.5">
          Preconfigured games that run automatically. Games auto-start when minimum players join after a countdown.
        </p>
      </div>
      <div class="flex gap-2 items-center">
        <UButton icon="i-heroicons-arrow-path" color="neutral" variant="ghost" @click="refreshTemplates">Refresh</UButton>
        <UButton icon="i-heroicons-plus" color="primary" @click="showCreateModal = true">New Template</UButton>
      </div>
    </div>

    <!-- Info Banner -->
    <div class="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
      <div class="flex items-start gap-3">
        <span class="text-cyan-400 text-xl">💡</span>
        <div class="text-sm text-zinc-300">
          <p class="font-medium text-cyan-400 mb-1">How Templates Work</p>
          <ul class="list-disc list-inside space-y-0.5 text-zinc-400">
            <li>Each active template always has one <strong class="text-zinc-300">WAITING</strong> game in the lobby</li>
            <li>When <strong class="text-zinc-300">min players</strong> join, a <strong class="text-zinc-300">60-second countdown</strong> begins</li>
            <li>When the countdown expires, the game <strong class="text-zinc-300">auto-starts</strong> (no manual start needed)</li>
            <li>When a game ends, a <strong class="text-zinc-300">new one is created</strong> from the same template automatically</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Table -->
    <div class="rounded-2xl border border-white/8 overflow-hidden" style="background:#111827;">
      <UTable :columns="columns" :data="templates" :loading="loading">
        <template #ticketPrice-cell="{ row }">
          <span class="font-semibold text-amber-400">{{ (row.original as unknown as GameTemplate).ticketPrice }} ETB</span>
        </template>
        <template #players-cell="{ row }">
          <span class="text-zinc-300">
            {{ (row.original as unknown as GameTemplate).minPlayers }} / {{ (row.original as unknown as GameTemplate).maxPlayers }}
          </span>
        </template>
        <template #houseEdgePct-cell="{ row }">
          <span class="text-zinc-300">{{ (row.original as unknown as GameTemplate).houseEdgePct }}%</span>
        </template>
        <template #countdownSecs-cell="{ row }">
          <span class="text-zinc-300">{{ (row.original as unknown as GameTemplate).countdownSecs }}s</span>
        </template>
        <template #active-cell="{ row }">
          <UBadge
            :color="(row.original as unknown as GameTemplate).active ? 'success' : 'neutral'"
            variant="soft"
          >
            {{ (row.original as unknown as GameTemplate).active ? 'Active' : 'Inactive' }}
          </UBadge>
        </template>
        <template #waitingGames-cell="{ row }">
          <span class="text-zinc-300">{{ (row.original as unknown as GameTemplate)._count?.games ?? 0 }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-2">
            <UButton
              size="xs"
              :color="(row.original as unknown as GameTemplate).active ? 'warning' : 'success'"
              variant="soft"
              @click="toggleActive(row.original as unknown as GameTemplate)"
            >
              {{ (row.original as unknown as GameTemplate).active ? 'Deactivate' : 'Activate' }}
            </UButton>
            <UButton
              size="xs" color="error" variant="soft" icon="i-heroicons-trash"
              @click="confirmDelete((row.original as unknown as GameTemplate).id)"
            />
          </div>
        </template>
      </UTable>
    </div>

    <!-- Create Template Modal -->
    <UModal v-model:open="showCreateModal" title="Create Game Template" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-4">
          <div>
            <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Title</label>
            <UInput v-model="newTemplate.title" placeholder="e.g. Quick 10 ETB" />
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Ticket Price (ETB)</label>
              <UInput v-model.number="newTemplate.ticketPrice" type="number" min="1" />
            </div>
            <div>
              <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Max Players</label>
              <UInput v-model.number="newTemplate.maxPlayers" type="number" min="2" max="500" />
            </div>
            <div>
              <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Min Players</label>
              <UInput v-model.number="newTemplate.minPlayers" type="number" min="2" />
            </div>
            <div>
              <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">House Edge %</label>
              <UInput v-model.number="newTemplate.houseEdgePct" type="number" min="0" max="50" />
            </div>
            <div>
              <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Countdown (seconds)</label>
              <UInput v-model.number="newTemplate.countdownSecs" type="number" min="10" max="300" />
            </div>
          </div>
          <div>
            <label class="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-1.5 block">Win Pattern</label>
            <USelect v-model="newTemplate.pattern" :items="patternOptions.map(p => ({ label: p, value: p }))" value-key="value" />
          </div>
          <p v-if="createError" class="text-red-400 text-sm">{{ createError }}</p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showCreateModal = false">Cancel</UButton>
        <UButton color="primary" :loading="creating" @click="handleCreate">Create Template</UButton>
      </template>
    </UModal>

    <!-- Delete Confirm Modal -->
    <UModal v-model:open="showDeleteConfirm" title="Delete Template?" :ui="{ footer: 'justify-end' }">
      <template #body>
        <p class="text-sm text-zinc-400">This template will be deactivated and deleted. Existing games from this template will not be affected.</p>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showDeleteConfirm = false">Back</UButton>
        <UButton color="error" @click="handleDelete">Delete</UButton>
      </template>
    </UModal>
  </div>
</template>
