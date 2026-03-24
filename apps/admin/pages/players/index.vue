<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getUsers } = useAdminApi()
const toast = useToast()

const players = ref<any[]>([])
const loading = ref(false)
const page = ref(1)
const limit = 20
const totalPages = ref(1)
const totalPlayers = ref(0)
const searchQuery = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

async function fetchPlayers() {
  loading.value = true
  try {
    const result = await getUsers({
      page: page.value,
      limit,
      search: searchQuery.value || undefined,
      role: 'PLAYER',
    }) as any
    players.value = result?.data ?? []
    if (result?.pagination) {
      totalPages.value = result.pagination.totalPages
      totalPlayers.value = result.pagination.total
    }
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load players', color: 'error' })
  } finally {
    loading.value = false
  }
}

function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; fetchPlayers() }, 400)
}

watch(page, fetchPlayers)
onMounted(fetchPlayers)

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-ET', { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Players</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">{{ totalPlayers.toLocaleString() }} registered players</p>
      </div>
      <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" label="Refresh" @click="fetchPlayers" />
    </div>

    <div class="bg-white/5 p-3 rounded-2xl border border-white/5">
      <UInput
        v-model="searchQuery"
        icon="i-heroicons:magnifying-glass"
        placeholder="Search by username or phone..."
        class="w-full max-w-md"
        @input="onSearch"
      />
    </div>

    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-(--surface-border) bg-(--surface-overlay)">
            <tr>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">ID</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Username</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Phone</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Real Balance</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Bonus Balance</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Joined</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr v-if="loading">
              <td colspan="7" class="px-4 py-12 text-center text-white/40">
                <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin" />
              </td>
            </tr>
            <tr v-else-if="!players.length">
              <td colspan="7" class="px-4 py-12 text-center text-white/30">No players found</td>
            </tr>
            <tr v-for="p in players" :key="p.id" class="hover:bg-white/3 transition-colors">
              <td class="px-4 py-3 text-white/30 font-mono text-xs">{{ String(p.serial).padStart(5, '0') }}</td>
              <td class="px-4 py-3 font-semibold text-zinc-200">
                <NuxtLink :to="`/players/${p.id}`" class="hover:text-yellow-500 transition-colors">{{ p.username }}</NuxtLink>
              </td>
              <td class="px-4 py-3 text-white/40 font-mono text-xs">{{ p.phone ?? '—' }}</td>
              <td class="px-4 py-3 text-right font-mono text-yellow-500 font-bold">
                {{ Number(p.wallet?.realBalance ?? 0).toFixed(2) }}
              </td>
              <td class="px-4 py-3 text-right font-mono text-cyan-400 font-bold">
                {{ Number(p.wallet?.bonusBalance ?? 0).toFixed(2) }}
              </td>
              <td class="px-4 py-3 text-white/40 text-xs">{{ formatDate(p.createdAt) }}</td>
              <td class="px-4 py-3 text-right">
                <NuxtLink :to="`/players/${p.id}`">
                  <UButton size="xs" color="neutral" variant="ghost" icon="i-heroicons:eye" label="View" />
                </NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="totalPages > 1" class="flex items-center justify-between px-4 py-4">
      <span class="text-sm text-white/40">Page {{ page }} of {{ totalPages }}</span>
      <div class="flex gap-2">
        <UButton size="sm" color="neutral" variant="ghost" icon="i-heroicons:chevron-left" :disabled="page <= 1" @click="page--" label="Prev" />
        <UButton size="sm" color="neutral" variant="ghost" icon="i-heroicons:chevron-right" :disabled="page >= totalPages" @click="page++" label="Next" />
      </div>
    </div>
  </div>
</template>
