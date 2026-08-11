<script setup lang="ts">
import type { FeaturedGameItem } from '~/composables/useAdminApi'

const { getFeaturedGames, saveFeaturedGames, getProviders, getProviderGames } = useAdminApi()
const toast = useToast()

type CatalogGame = {
  id: string
  gameCode: string
  gameName: string
  categoryCode: string
  imageSquare: string | null
  isActive: boolean
}

type Pin = { nameKey: string; label: string; matches: number }

// Must stay identical to toNameKey() in the API and to the SQL projection —
// a pin that normalizes differently here simply stops matching.
const toNameKey = (name: string) => (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

const loading = ref(true)
const saving = ref(false)
const pins = ref<Pin[]>([])
const savedSnapshot = ref('')

const providers = ref<Array<{ code: string; name: string }>>([])
const activeProvider = ref('')

const search = ref('')
const searching = ref(false)
const results = ref<CatalogGame[]>([])

const dirty = computed(() => JSON.stringify(pins.value.map(p => p.nameKey)) !== savedSnapshot.value)
const pinnedKeys = computed(() => new Set(pins.value.map(p => p.nameKey)))

const snapshot = (items: FeaturedGameItem[]) => {
  pins.value = items.map(i => ({ nameKey: i.nameKey, label: i.label, matches: i.matches }))
  savedSnapshot.value = JSON.stringify(items.map(i => i.nameKey))
}

const fetchPins = async () => {
  loading.value = true
  try {
    const { items } = await getFeaturedGames()
    snapshot(items)
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load the priority list', color: 'error' })
  } finally {
    loading.value = false
  }
}

const fetchProviders = async () => {
  try {
    const list = await getProviders()
    providers.value = list.map((p: any) => ({ code: p.code, name: p.name }))
    activeProvider.value = list.find((p: any) => p.isPrimary)?.code ?? list[0]?.code ?? ''
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load providers', color: 'error' })
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined

const runSearch = async () => {
  const term = search.value.trim()
  if (!activeProvider.value || term.length < 2) {
    results.value = []
    return
  }
  searching.value = true
  try {
    const res = await getProviderGames(activeProvider.value, { search: term, limit: 20 })
    results.value = res.data ?? []
  } catch {
    toast.add({ title: 'Error', description: 'Search failed', color: 'error' })
  } finally {
    searching.value = false
  }
}

watch([search, activeProvider], () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 250)
})

const addGame = (game: CatalogGame) => {
  const nameKey = toNameKey(game.gameName)
  if (!nameKey || pinnedKeys.value.has(nameKey)) return
  // matches is unknown until the server re-resolves the pin on save; at least
  // this game matched, so start at 1 rather than showing a false "not in catalog".
  pins.value.push({ nameKey, label: game.gameName, matches: 1 })
}

const removePin = (index: number) => {
  pins.value.splice(index, 1)
}

const move = (index: number, delta: number) => {
  const target = index + delta
  if (target < 0 || target >= pins.value.length) return
  const [pin] = pins.value.splice(index, 1)
  pins.value.splice(target, 0, pin)
}

/* Native HTML5 drag — no extra dependency for what is a 20-row list. */
const dragIndex = ref<number | null>(null)

const onDrop = (index: number) => {
  const from = dragIndex.value
  dragIndex.value = null
  if (from === null || from === index) return
  const [pin] = pins.value.splice(from, 1)
  pins.value.splice(index, 0, pin)
}

const save = async () => {
  saving.value = true
  try {
    const { items } = await saveFeaturedGames(pins.value.map(p => ({ nameKey: p.nameKey, label: p.label })))
    snapshot(items)
    toast.add({ title: 'Saved', description: 'Lobby order updated', color: 'success' })
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.error ?? 'Failed to save', color: 'error' })
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await Promise.all([fetchPins(), fetchProviders()])
})
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Featured Games</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">
          Games at the top of the player lobby, in this order. Everything else follows alphabetically.
        </p>
      </div>
      <UButton
        icon="i-heroicons:check"
        color="primary"
        size="sm"
        :loading="saving"
        :disabled="!dirty || loading"
        @click="save"
      >
        {{ dirty ? 'Save order' : 'Saved' }}
      </UButton>
    </div>

    <!-- Search / add -->
    <div class="rounded-2xl border border-(--surface-border) p-4 space-y-3" style="background: var(--surface-raised);">
      <div class="flex items-center gap-3">
        <USelect
          v-if="providers.length > 1"
          v-model="activeProvider"
          :items="providers.map(p => ({ label: p.name, value: p.code }))"
          size="sm"
          class="w-44"
        />
        <UInput
          v-model="search"
          icon="i-heroicons:magnifying-glass"
          placeholder="Search the catalog to add a game…"
          size="sm"
          class="flex-1"
        />
      </div>

      <div v-if="searching" class="text-xs text-white/40 flex items-center gap-2">
        <UIcon name="i-heroicons:arrow-path" class="w-4 h-4 animate-spin" /> Searching…
      </div>

      <div v-else-if="results.length" class="flex flex-wrap gap-2">
        <button
          v-for="game in results"
          :key="game.id"
          type="button"
          class="flex items-center gap-2 rounded-xl border border-white/10 px-2.5 py-1.5 text-xs text-white/80 hover:border-yellow-500/40 disabled:opacity-40 disabled:hover:border-white/10"
          style="background: var(--surface-overlay);"
          :disabled="pinnedKeys.has(toNameKey(game.gameName))"
          @click="addGame(game)"
        >
          <img v-if="game.imageSquare" :src="game.imageSquare" alt="" class="w-6 h-6 rounded-md object-cover" >
          <span class="font-medium">{{ game.gameName }}</span>
          <span v-if="!game.isActive" class="text-[10px] uppercase tracking-wider text-red-400">hidden</span>
          <UIcon v-else name="i-heroicons:plus" class="w-3.5 h-3.5 text-white/40" />
        </button>
      </div>

      <p v-else-if="search.trim().length >= 2" class="text-xs text-white/30">No games match “{{ search }}”.</p>
    </div>

    <!-- The list -->
    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>

    <div v-else-if="!pins.length" class="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-white/30">
      No featured games. The lobby shows the catalog in its default order.
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="(pin, index) in pins"
        :key="pin.nameKey"
        class="flex items-center gap-3 rounded-2xl border border-(--surface-border) p-3 cursor-grab active:cursor-grabbing"
        :class="dragIndex === index ? 'opacity-50' : ''"
        style="background: var(--surface-raised);"
        draggable="true"
        @dragstart="dragIndex = index"
        @dragend="dragIndex = null"
        @dragover.prevent
        @drop.prevent="onDrop(index)"
      >
        <UIcon name="i-heroicons:bars-3" class="w-4 h-4 text-white/20 shrink-0" />
        <span class="w-7 text-center text-xs font-bold text-yellow-400/80 shrink-0">{{ index + 1 }}</span>

        <div class="flex-1 min-w-0">
          <p class="text-sm font-bold text-white truncate">{{ pin.label }}</p>
          <p class="text-xs mt-0.5" :class="pin.matches ? 'text-white/30' : 'text-amber-400/80'">
            <span v-if="pin.matches">{{ pin.matches }} catalog {{ pin.matches === 1 ? 'match' : 'matches' }}</span>
            <span v-else>Not in the catalog — kept, but nothing to order</span>
          </p>
        </div>

        <div class="flex items-center gap-1 shrink-0">
          <UButton icon="i-heroicons:chevron-up" color="neutral" variant="ghost" size="xs" :disabled="index === 0" @click="move(index, -1)" />
          <UButton icon="i-heroicons:chevron-down" color="neutral" variant="ghost" size="xs" :disabled="index === pins.length - 1" @click="move(index, 1)" />
          <UButton icon="i-heroicons:x-mark" color="error" variant="ghost" size="xs" @click="removePin(index)" />
        </div>
      </div>

      <p v-if="dirty" class="text-xs text-amber-400/80 pt-1">Unsaved changes — players still see the previous order.</p>
    </div>
  </div>
</template>
