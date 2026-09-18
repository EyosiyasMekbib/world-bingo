<script setup lang="ts">
const { getProviders, updateProviderStatus, updateProviderPriority, syncProvider } = useAdminApi()
const toast = useToast()

const loading = ref(true)
const syncing = ref<string | null>(null)
const providers = ref<any[]>([])

const fetchProviders = async () => {
  loading.value = true
  try {
    providers.value = await getProviders()
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load providers', color: 'error' })
  } finally {
    loading.value = false
  }
}

const statusColor = (status: string) =>
  status === 'ACTIVE' ? 'success' : status === 'MAINTENANCE' ? 'warning' : 'neutral'

const cycleStatus = async (provider: any) => {
  const next = provider.status === 'ACTIVE' ? 'INACTIVE' : provider.status === 'INACTIVE' ? 'ACTIVE' : 'INACTIVE'
  try {
    const updated = await updateProviderStatus(provider.id, next)
    const idx = providers.value.findIndex((p) => p.id === provider.id)
    if (idx !== -1) providers.value[idx] = { ...providers.value[idx], status: (updated as any).status }
    toast.add({ title: 'Updated', description: `Provider status set to ${next}`, color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to update status', color: 'error' })
  }
}

// Lobby priority: when two providers carry the same game, the lower number's
// copy is the one players see. Saved on change; the list re-sorts on reload.
const savingPriority = ref<string | null>(null)
const savePriority = async (provider: any, value: string | number) => {
  const priority = Number(value)
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
    toast.add({ title: 'Invalid priority', description: 'Use a whole number from 0 to 1000', color: 'error' })
    return
  }
  if (priority === provider.priority) return
  savingPriority.value = provider.id
  try {
    const updated = await updateProviderPriority(provider.id, priority)
    const idx = providers.value.findIndex((p) => p.id === provider.id)
    if (idx !== -1) providers.value[idx] = { ...providers.value[idx], priority: updated.priority }
    toast.add({ title: 'Updated', description: `${provider.name} priority set to ${priority}`, color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to update priority', color: 'error' })
  } finally {
    savingPriority.value = null
  }
}

const runSync = async (code: string) => {
  syncing.value = code
  try {
    await syncProvider(code)
    toast.add({ title: 'Sync complete', description: `Game catalog for ${code} updated`, color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Sync failed', color: 'error' })
  } finally {
    syncing.value = null
  }
}

onMounted(fetchProviders)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Game Providers</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Manage third-party game provider integrations</p>
        <p class="text-xs text-white/40 mt-1">
          Priority decides which provider's copy of a game the lobby shows when two providers carry the same title. Lower wins.
        </p>
      </div>
    </div>

    <div v-if="loading" class="flex justify-center py-20 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-6 h-6 animate-spin" />
    </div>

    <div v-else-if="!providers.length" class="text-center py-20 text-white/40">
      No providers configured. Add credentials in <code class="text-yellow-500">.env</code> and restart.
    </div>

    <div v-else class="grid gap-4">
      <div
        v-for="p in providers"
        :key="p.id"
        class="rounded-2xl border border-(--surface-border) p-5 flex items-center gap-4 shadow-md"
        style="background: var(--surface-raised);"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-3 flex-wrap">
            <span class="font-bold text-white text-base">{{ p.name }}</span>
            <UBadge :color="statusColor(p.status)" variant="subtle" size="xs">{{ p.status }}</UBadge>
            <span class="text-xs text-white/30 font-mono">{{ p.code }}</span>
          </div>
          <p class="text-xs text-white/40 mt-1">{{ p.currency }} · {{ p.apiBaseUrl || 'URL from env' }}</p>
          <p v-if="p.lastSyncedAt" class="text-xs text-white/30 mt-0.5">
            Last synced: {{ new Date(p.lastSyncedAt).toLocaleString() }}
          </p>
        </div>

        <div class="flex items-center gap-2 flex-shrink-0">
          <label class="flex items-center gap-1.5 text-xs text-white/50">
            Priority
            <UInput
              :model-value="p.priority"
              type="number"
              min="0"
              max="1000"
              step="1"
              size="xs"
              class="w-20"
              :loading="savingPriority === p.id"
              :aria-label="`Lobby priority for ${p.name}`"
              @change="savePriority(p, ($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="savePriority(p, ($event.target as HTMLInputElement).value)"
            />
          </label>
          <NuxtLink :to="`/providers/${p.code}`">
            <UButton size="xs" color="neutral" variant="outline" icon="i-heroicons:eye">
              Manage
            </UButton>
          </NuxtLink>
          <UButton
            size="xs"
            color="primary"
            variant="outline"
            icon="i-heroicons:arrow-path"
            :loading="syncing === p.code"
            @click="runSync(p.code)"
          >
            Sync
          </UButton>
          <UButton
            size="xs"
            :color="p.status === 'ACTIVE' ? 'error' : 'success'"
            variant="subtle"
            @click="cycleStatus(p)"
          >
            {{ p.status === 'ACTIVE' ? 'Disable' : 'Enable' }}
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
