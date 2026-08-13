<script setup lang="ts">
definePageMeta({ layout: 'default' })

const {
  getSegments,
  seedSegmentPresets,
  getCrmFreshness,
  refreshCrmMetrics,
  deleteSegment,
} = useAdminApi()
const toast = useToast()

const segments = ref<any[]>([])
const loading = ref(true)
const seeding = ref(false)
const refreshing = ref(false)
const freshness = ref<{ refreshedAt: string | null; rowCount: number } | null>(null)

async function load() {
  loading.value = true
  try {
    const [list, fresh] = await Promise.all([getSegments(), getCrmFreshness()])
    segments.value = list
    freshness.value = fresh
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to load segments', color: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(load)

/**
 * Segment counts are only as current as the rollup behind them. Showing the age
 * prominently is deliberate — a marketer about to act on "412 churned players"
 * needs to know whether that number is four minutes or four days old.
 */
const freshnessLabel = computed(() => {
  if (!freshness.value?.refreshedAt) return 'never built'
  const ms = Date.now() - new Date(freshness.value.refreshedAt).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
})

const isStale = computed(() => {
  if (!freshness.value?.refreshedAt) return true
  return Date.now() - new Date(freshness.value.refreshedAt).getTime() > 30 * 60 * 1000
})

async function seedPresets() {
  seeding.value = true
  try {
    const result = await seedSegmentPresets()
    toast.add({
      title: 'Presets ready',
      description: `${result.created} created, ${result.skipped} already existed`,
      color: 'success',
    })
    await load()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed', color: 'error' })
  } finally {
    seeding.value = false
  }
}

async function rebuild() {
  refreshing.value = true
  try {
    await refreshCrmMetrics(true)
    toast.add({ title: 'Metrics rebuilt', color: 'success' })
    await load()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed', color: 'error' })
  } finally {
    refreshing.value = false
  }
}

async function remove(segment: any) {
  if (!confirm(`Delete segment "${segment.name}"?`)) return
  try {
    await deleteSegment(segment.id)
    toast.add({ title: 'Segment deleted', color: 'success' })
    await load()
  } catch (err: any) {
    toast.add({ title: 'Cannot delete', description: err?.data?.error ?? 'Failed', color: 'error' })
  }
}

const config = useRuntimeConfig()
function exportUrl(id: string) {
  return `/api/admin/crm/segments/${id}/export.csv`
}
</script>

<template>
  <div class="p-4 md:p-6 space-y-6">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Player Segments</h1>
        <p class="text-sm text-(--ui-text-muted)">
          Group players by behaviour, then export the list or act on it.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UButton
          icon="i-heroicons:sparkles"
          label="Add presets"
          color="neutral"
          variant="subtle"
          :loading="seeding"
          @click="seedPresets"
        />
        <UButton icon="i-heroicons:plus" label="New segment" color="primary" to="/crm/new" />
      </div>
    </div>

    <!-- Staleness is a first-class element, not a footnote. -->
    <UAlert
      :color="isStale ? 'warning' : 'neutral'"
      variant="subtle"
      :icon="isStale ? 'i-heroicons:exclamation-triangle' : 'i-heroicons:clock'"
    >
      <template #description>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            Metrics for <strong>{{ freshness?.rowCount?.toLocaleString() ?? 0 }}</strong> players,
            last built <strong>{{ freshnessLabel }}</strong>.
          </span>
          <UButton
            size="xs"
            variant="link"
            :loading="refreshing"
            label="Rebuild now"
            @click="rebuild"
          />
        </div>
      </template>
    </UAlert>

    <div v-if="loading" class="space-y-3">
      <USkeleton v-for="i in 4" :key="i" class="h-20 w-full" />
    </div>

    <UCard v-else-if="!segments.length">
      <div class="text-center py-10 space-y-3">
        <UIcon name="i-heroicons:funnel" class="size-10 text-(--ui-text-muted)" />
        <p class="font-medium">No segments yet</p>
        <p class="text-sm text-(--ui-text-muted)">
          Start with the eight built-in segments, then clone and tweak them.
        </p>
        <UButton label="Add presets" color="primary" :loading="seeding" @click="seedPresets" />
      </div>
    </UCard>

    <div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <UCard v-for="segment in segments" :key="segment.id" class="flex flex-col">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="font-semibold truncate">{{ segment.name }}</h3>
              <UBadge v-if="segment.isPreset" size="xs" variant="soft" color="neutral" label="Preset" />
            </div>
            <p v-if="segment.description" class="text-sm text-(--ui-text-muted) mt-1">
              {{ segment.description }}
            </p>
          </div>
          <div class="text-right shrink-0">
            <div class="text-2xl font-semibold tabular-nums">
              {{ segment.cachedCount?.toLocaleString() ?? '—' }}
            </div>
            <div class="text-xs text-(--ui-text-muted)">players</div>
          </div>
        </div>

        <!-- The rule, in words. Rendered from the same whitelist the server
             compiles, so what you read is what will be targeted. -->
        <p class="mt-3 text-xs font-mono text-(--ui-text-muted) break-words">
          {{ segment.summary }}
        </p>

        <template #footer>
          <div class="flex items-center justify-between gap-2">
            <UButton size="xs" variant="ghost" label="Open" :to="`/crm/${segment.id}`" />
            <div class="flex items-center gap-1">
              <UButton
                size="xs"
                variant="ghost"
                icon="i-heroicons:arrow-down-tray"
                label="CSV"
                :to="exportUrl(segment.id)"
                external
              />
              <UButton
                v-if="!segment.isPreset"
                size="xs"
                variant="ghost"
                color="error"
                icon="i-heroicons:trash"
                @click="remove(segment)"
              />
            </div>
          </div>
        </template>
      </UCard>
    </div>
  </div>
</template>
