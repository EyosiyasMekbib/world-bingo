<script setup lang="ts">
const route = useRoute()
const { getProviderVendors, updateVendorStatus, updateVendorAlias, getProviderGames, updateGameStatus, syncProvider, getProviderTransactions } = useAdminApi()
const toast = useToast()

const code = route.params.code as string
const activeTab = ref<'vendors' | 'games' | 'transactions'>('games')

// Vendors
const vendors = ref<any[]>([])
const vendorsLoading = ref(false)

// Games
const gamesData = ref<{ data: any[]; total: number; page: number; limit: number } | null>(null)
const gamesLoading = ref(false)
const gamesPage = ref(1)
const GAMES_PAGE_SIZE = 50
// Games tab filters: a name search plus one studio (vendor code). Both are
// server-side, so a provider with thousands of games stays browsable. The
// select needs a non-empty value for "all", hence the sentinel.
const ALL_STUDIOS = '__all__'
const gamesSearch = ref('')
const gamesVendor = ref(ALL_STUDIOS)
const gamesFiltered = computed(() => Boolean(gamesSearch.value.trim() || gamesVendor.value !== ALL_STUDIOS))
const vendorOptions = computed(() => [
  { label: 'All studios', value: ALL_STUDIOS },
  ...vendors.value.map((v) => ({ label: v.name, value: v.code })),
])

// Transactions
const txData = ref<{ data: any[]; total: number; page: number; limit: number } | null>(null)
const txLoading = ref(false)
const txPage = ref(1)

const syncing = ref(false)

const fetchVendors = async () => {
  vendorsLoading.value = true
  try {
    vendors.value = await getProviderVendors(code)
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load vendors', color: 'error' })
  } finally {
    vendorsLoading.value = false
  }
}

const fetchGames = async (page = 1) => {
  gamesLoading.value = true
  gamesPage.value = page
  try {
    gamesData.value = await getProviderGames(code, {
      page,
      limit: GAMES_PAGE_SIZE,
      search: gamesSearch.value.trim() || undefined,
      vendor: gamesVendor.value === ALL_STUDIOS ? undefined : gamesVendor.value,
    }) as any
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load games', color: 'error' })
  } finally {
    gamesLoading.value = false
  }
}

const fetchTransactions = async (page = 1) => {
  txLoading.value = true
  txPage.value = page
  try {
    txData.value = await getProviderTransactions(code, { page, limit: 30 }) as any
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load transactions', color: 'error' })
  } finally {
    txLoading.value = false
  }
}

// Lobby de-dup alias: vendors on different providers with the same alias are
// treated as one studio, so the lobby shows only the higher-priority provider's
// copy of a title they both carry. Empty clears it (falls back to the name).
const savingAlias = ref<string | null>(null)
const saveAlias = async (vendor: any, value: string) => {
  const alias = value.trim() || null
  if (alias === (vendor.dedupAlias ?? null)) return
  savingAlias.value = vendor.id
  try {
    const updated = await updateVendorAlias(code, vendor.code, alias)
    vendor.dedupAlias = updated.dedupAlias ?? null
    toast.add({
      title: 'Updated',
      description: alias ? `${vendor.name} now de-dups as "${alias}"` : `${vendor.name} de-dups by its own name`,
      color: 'success',
    })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to update alias', color: 'error' })
  } finally {
    savingAlias.value = null
  }
}

const toggleVendor = async (vendor: any) => {
  try {
    await updateVendorStatus(code, vendor.code, !vendor.isActive)
    vendor.isActive = !vendor.isActive
  } catch {
    toast.add({ title: 'Error', description: 'Failed to update vendor', color: 'error' })
  }
}

// Filter changes restart from page 1; a search is applied on Enter or blur so
// each keystroke does not hit the API.
const applyGamesSearch = (value: string) => {
  if (value.trim() === gamesSearch.value.trim()) return
  gamesSearch.value = value
  fetchGames(1)
}
watch(gamesVendor, () => fetchGames(1))
const clearGamesFilters = () => {
  gamesSearch.value = ''
  gamesVendor.value = ALL_STUDIOS
  fetchGames(1)
}

// Where the lobby stands on a row. A manual "off" is the override that wins
// over the automatic de-dup: a disabled game never shows, whichever copy the
// de-dup would otherwise pick, and the next sync leaves it off.
const lobbyState = (game: any): { label: string; color: 'success' | 'warning' | 'neutral' | 'error' } => {
  if (!game.isActive) return game.autoHidden
    ? { label: 'Off (delisted upstream)', color: 'error' }
    : { label: 'Off', color: 'neutral' }
  if (game.vendorActive === false) return { label: 'Off (studio disabled)', color: 'neutral' }
  if (game.shadowed) return { label: 'Hidden as duplicate', color: 'warning' }
  return { label: 'Showing', color: 'success' }
}

const toggleGame = async (game: any) => {
  const next = !game.isActive
  try {
    const updated = await updateGameStatus(code, game.gameCode, next) as any
    game.isActive = updated?.isActive ?? next
    game.autoHidden = updated?.autoHidden ?? false
    game.shadowed = updated?.shadowed ?? game.shadowed
    toast.add({
      title: next ? 'Game enabled' : 'Game disabled',
      description: next
        ? `${game.gameName} can show in the lobby again`
        : `${game.gameName} is hidden from the lobby until you switch it back on`,
      color: 'success',
    })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to update game', color: 'error' })
  }
}

const runSync = async () => {
  syncing.value = true
  try {
    await syncProvider(code)
    toast.add({ title: 'Sync complete', description: 'Game catalog updated', color: 'success' })
    await fetchGames(1)
  } catch {
    toast.add({ title: 'Error', description: 'Sync failed', color: 'error' })
  } finally {
    syncing.value = false
  }
}

onMounted(async () => {
  await Promise.all([fetchVendors(), fetchGames(), fetchTransactions()])
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center gap-3">
      <NuxtLink to="/providers" class="text-white/40 hover:text-white transition-colors">
        <UIcon name="i-heroicons:arrow-left" class="w-5 h-5" />
      </NuxtLink>
      <div class="flex-1">
        <h1 class="text-2xl font-bold text-white tracking-tight capitalize">{{ code }} Provider</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Manage vendors, games, and view transaction history</p>
      </div>
      <UButton
        icon="i-heroicons:arrow-path"
        color="primary"
        variant="outline"
        size="sm"
        :loading="syncing"
        @click="runSync"
      >
        Sync Catalog
      </UButton>
    </div>

    <!-- Tab navigation -->
    <div class="flex gap-1 border-b border-(--surface-border)">
      <button
        v-for="tab in ['games', 'vendors', 'transactions']"
        :key="tab"
        class="px-4 py-2.5 text-sm font-semibold capitalize transition-colors border-b-2 -mb-px"
        :class="activeTab === tab
          ? 'text-yellow-500 border-yellow-500'
          : 'text-white/40 border-transparent hover:text-white/70'"
        @click="activeTab = tab as any"
      >
        {{ tab }}
        <span v-if="tab === 'games' && gamesData" class="ml-1 text-xs text-white/30">({{ gamesData.total }})</span>
        <span v-if="tab === 'vendors'" class="ml-1 text-xs text-white/30">({{ vendors.length }})</span>
      </button>
    </div>

    <!-- Games tab -->
    <div v-if="activeTab === 'games'" class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <UInput
          :model-value="gamesSearch"
          icon="i-heroicons:magnifying-glass"
          size="sm"
          class="w-full sm:w-64"
          placeholder="Search games by name"
          aria-label="Search games by name"
          @change="applyGamesSearch(($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="applyGamesSearch(($event.target as HTMLInputElement).value)"
        />
        <USelect
          v-model="gamesVendor"
          :items="vendorOptions"
          size="sm"
          class="w-full sm:w-56"
          aria-label="Filter games by studio"
        />
        <UButton v-if="gamesFiltered" size="sm" variant="ghost" color="neutral" @click="clearGamesFilters">
          Clear filters
        </UButton>
        <p class="text-xs text-white/40 sm:ml-auto">
          Switch a game off to keep it out of the lobby, whichever copy the de-dup would pick.
        </p>
      </div>

      <div v-if="gamesLoading" class="flex justify-center py-12 text-zinc-500">
        <UIcon name="i-heroicons:arrow-path" class="w-6 h-6 animate-spin" />
      </div>
      <div v-else-if="!gamesData?.data.length" class="text-center py-12 text-white/40">
        <template v-if="gamesFiltered">No games match these filters.</template>
        <template v-else>No games found. Run a sync to populate the catalog.</template>
      </div>
      <div v-else>
        <div class="overflow-x-auto rounded-xl border border-(--surface-border)">
          <table class="w-full text-sm">
            <thead style="background: var(--surface-overlay);">
              <tr class="text-left text-white/50 text-xs uppercase tracking-wider">
                <th class="px-4 py-3 font-semibold">Game</th>
                <th class="px-4 py-3 font-semibold">Studio</th>
                <th class="px-4 py-3 font-semibold">Category</th>
                <th class="px-4 py-3 font-semibold">Code</th>
                <th class="px-4 py-3 font-semibold">Lobby</th>
                <th class="px-4 py-3 font-semibold text-right">Active</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5">
              <tr
                v-for="game in gamesData.data"
                :key="game.gameCode"
                class="hover:bg-white/3 transition-colors"
                style="background: var(--surface-raised);"
              >
                <td class="px-4 py-3 text-white font-medium">{{ game.gameName }}</td>
                <td class="px-4 py-3 text-white/60">{{ game.vendorName ?? game.vendorCode ?? '—' }}</td>
                <td class="px-4 py-3">
                  <UBadge color="neutral" variant="subtle" size="xs">{{ game.categoryCode }}</UBadge>
                </td>
                <td class="px-4 py-3 text-white/40 font-mono text-xs">{{ game.gameCode }}</td>
                <td class="px-4 py-3">
                  <UBadge :color="lobbyState(game).color" variant="subtle" size="xs">{{ lobbyState(game).label }}</UBadge>
                </td>
                <td class="px-4 py-3 text-right">
                  <USwitch
                    :model-value="game.isActive"
                    size="xs"
                    :aria-label="`${game.isActive ? 'Disable' : 'Enable'} ${game.gameName}`"
                    @update:model-value="toggleGame(game)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex items-center justify-between mt-3 text-sm text-white/40">
          <span>{{ gamesData.total }} games{{ gamesFiltered ? ' match' : ' total' }}</span>
          <div class="flex gap-2">
            <UButton size="xs" variant="ghost" :disabled="gamesPage <= 1" @click="fetchGames(gamesPage - 1)">Prev</UButton>
            <UButton size="xs" variant="ghost" :disabled="gamesPage * GAMES_PAGE_SIZE >= gamesData.total" @click="fetchGames(gamesPage + 1)">Next</UButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Vendors tab -->
    <div v-if="activeTab === 'vendors'">
      <div v-if="vendorsLoading" class="flex justify-center py-12 text-zinc-500">
        <UIcon name="i-heroicons:arrow-path" class="w-6 h-6 animate-spin" />
      </div>
      <div v-else-if="!vendors.length" class="text-center py-12 text-white/40">
        No vendors. Run a sync to populate.
      </div>
      <div v-else class="grid gap-3">
        <div
          v-for="v in vendors"
          :key="v.id"
          class="rounded-xl border border-(--surface-border) p-4 flex items-center gap-4"
          style="background: var(--surface-raised);"
        >
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold text-white">{{ v.name }}</p>
            <p class="text-xs text-white/40 font-mono">{{ v.code }} · {{ v.categoryCode }}</p>
          </div>
          <label class="flex items-center gap-1.5 text-xs text-white/50 flex-shrink-0">
            De-dup alias
            <UInput
              :model-value="v.dedupAlias ?? ''"
              size="xs"
              class="w-32"
              :placeholder="v.name"
              :loading="savingAlias === v.id"
              :aria-label="`Lobby de-dup alias for ${v.name}`"
              @change="saveAlias(v, ($event.target as HTMLInputElement).value)"
              @keydown.enter.prevent="saveAlias(v, ($event.target as HTMLInputElement).value)"
            />
          </label>
          <USwitch
            :model-value="v.isActive"
            size="sm"
            :aria-label="`${v.isActive ? 'Disable' : 'Enable'} ${v.name}`"
            @update:model-value="toggleVendor(v)"
          />
        </div>
      </div>
    </div>

    <!-- Transactions tab -->
    <div v-if="activeTab === 'transactions'">
      <div v-if="txLoading" class="flex justify-center py-12 text-zinc-500">
        <UIcon name="i-heroicons:arrow-path" class="w-6 h-6 animate-spin" />
      </div>
      <div v-else-if="!txData?.data.length" class="text-center py-12 text-white/40">
        No transactions recorded yet.
      </div>
      <div v-else>
        <div class="overflow-x-auto rounded-xl border border-(--surface-border)">
          <table class="w-full text-sm">
            <thead style="background: var(--surface-overlay);">
              <tr class="text-left text-white/50 text-xs uppercase tracking-wider">
                <th class="px-4 py-3 font-semibold">Time</th>
                <th class="px-4 py-3 font-semibold">Player</th>
                <th class="px-4 py-3 font-semibold">Type</th>
                <th class="px-4 py-3 font-semibold">Game</th>
                <th class="px-4 py-3 font-semibold text-right">Amount</th>
                <th class="px-4 py-3 font-semibold text-right">Balance After</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5">
              <tr
                v-for="tx in txData.data"
                :key="tx.id"
                style="background: var(--surface-raised);"
                class="hover:bg-white/3 transition-colors"
              >
                <td class="px-4 py-3 text-white/40 text-xs">{{ new Date(tx.createdAt).toLocaleString() }}</td>
                <td class="px-4 py-3 text-white/70 font-mono text-xs">{{ tx.userId.slice(0, 8) }}…</td>
                <td class="px-4 py-3">
                  <UBadge
                    :color="tx.type === 'BET' ? 'error' : tx.type.includes('WIN') || tx.type.includes('CREDIT') ? 'success' : 'neutral'"
                    variant="subtle"
                    size="xs"
                  >
{{ tx.type }}
</UBadge>
                </td>
                <td class="px-4 py-3 text-white/50 text-xs font-mono">{{ tx.gameCode }}</td>
                <td class="px-4 py-3 text-right font-mono text-xs text-white">{{ Number(tx.amount).toFixed(2) }}</td>
                <td class="px-4 py-3 text-right font-mono text-xs text-white/60">{{ Number(tx.balanceAfter).toFixed(2) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex items-center justify-between mt-3 text-sm text-white/40">
          <span>{{ txData.total }} transactions total</span>
          <div class="flex gap-2">
            <UButton size="xs" variant="ghost" :disabled="txPage <= 1" @click="fetchTransactions(txPage - 1)">Prev</UButton>
            <UButton size="xs" variant="ghost" :disabled="txPage * 30 >= txData.total" @click="fetchTransactions(txPage + 1)">Next</UButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
