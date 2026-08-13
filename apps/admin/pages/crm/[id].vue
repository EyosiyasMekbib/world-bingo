<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const { getSegment, updateSegment, previewSegmentRules } = useAdminApi()
const toast = useToast()

const segmentId = route.params.id as string

const segment = ref<any>(null)
const loading = ref(true)
const saving = ref(false)

const name = ref('')
const description = ref('')
const rules = ref<any>(null)

const preview = ref<{ rows: any[]; pagination: any } | null>(null)
const previewLoading = ref(false)
const page = ref(1)

async function load() {
  loading.value = true
  try {
    const result = await getSegment(segmentId)
    segment.value = result
    name.value = result.name
    description.value = result.description ?? ''
    rules.value = result.rules
    await loadPreview()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to load', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function loadPreview() {
  if (!rules.value) return
  previewLoading.value = true
  try {
    preview.value = await previewSegmentRules(rules.value, page.value, 25)
  } catch (err: any) {
    preview.value = null
    toast.add({ title: 'Preview failed', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    previewLoading.value = false
  }
}

watch(page, loadPreview)

onMounted(load)

async function save() {
  saving.value = true
  try {
    await updateSegment(segmentId, {
      name: name.value.trim(),
      description: description.value.trim() || null,
      rules: rules.value,
    })
    toast.add({ title: 'Segment saved', color: 'success' })
    page.value = 1
    await load()
  } catch (err: any) {
    toast.add({
      title: 'Could not save',
      description: err?.data?.error ?? 'Failed to save',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

const exportUrl = computed(() => `/api/admin/crm/segments/${segmentId}/export.csv`)

function money(value: any) {
  const n = Number(value ?? 0)
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function shortDate(value: any) {
  return value ? new Date(value).toLocaleDateString() : '—'
}
</script>

<template>
  <div class="p-4 md:p-6 space-y-6">
    <div v-if="loading" class="space-y-3">
      <USkeleton class="h-10 w-64" />
      <USkeleton class="h-40 w-full" />
    </div>

    <template v-else-if="segment">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <UButton icon="i-heroicons:arrow-left" variant="ghost" color="neutral" to="/crm" />
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h1 class="text-xl font-semibold truncate">{{ segment.name }}</h1>
              <UBadge v-if="segment.isPreset" size="xs" variant="soft" color="neutral" label="Preset" />
            </div>
            <p class="text-xs font-mono text-(--ui-text-muted) truncate">{{ segment.summary }}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <UButton
            icon="i-heroicons:arrow-down-tray"
            label="Export CSV"
            color="neutral"
            variant="subtle"
            :to="exportUrl"
            external
          />
          <UButton label="Save changes" color="primary" :loading="saving" @click="save" />
        </div>
      </div>

      <!-- Editing a preset is expected — that is the point of shipping them as
           rows. Say so, rather than locking the fields. -->
      <UAlert
        v-if="segment.isPreset"
        color="neutral"
        variant="subtle"
        icon="i-heroicons:information-circle"
        description="This is a built-in segment. Editing it is fine — your changes are kept and will not be overwritten by future deploys."
      />

      <UCard>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Name">
            <UInput v-model="name" class="w-full" />
          </UFormField>
          <UFormField label="Description">
            <UInput v-model="description" class="w-full" />
          </UFormField>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-medium">Conditions</h2>
        </template>
        <SegmentBuilder v-model="rules" />
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h2 class="font-medium">Matching players</h2>
            <span v-if="preview" class="text-sm text-(--ui-text-muted) tabular-nums">
              {{ preview.pagination.total.toLocaleString() }} total
            </span>
          </div>
        </template>

        <div v-if="previewLoading" class="space-y-2">
          <USkeleton v-for="i in 5" :key="i" class="h-8 w-full" />
        </div>

        <div v-else-if="!preview?.rows.length" class="text-center py-8 text-sm text-(--ui-text-muted)">
          No players match these conditions.
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-(--ui-text-muted)">
              <tr>
                <th class="py-2 pr-4">Player</th>
                <th class="py-2 pr-4">Phone</th>
                <th class="py-2 pr-4 text-right">Deposits</th>
                <th class="py-2 pr-4 text-right">Games</th>
                <th class="py-2 pr-4 text-right">Net loss</th>
                <th class="py-2 pr-4">Last played</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in preview.rows" :key="row.userId" class="border-t border-(--ui-border)">
                <td class="py-2 pr-4">
                  <NuxtLink :to="`/players/${row.userId}`" class="hover:underline">
                    {{ row.user?.username ?? row.userId.slice(0, 8) }}
                  </NuxtLink>
                </td>
                <td class="py-2 pr-4 font-mono text-xs">{{ row.phone ?? '—' }}</td>
                <td class="py-2 pr-4 text-right tabular-nums">{{ money(row.lifetimeDeposits) }}</td>
                <td class="py-2 pr-4 text-right tabular-nums">{{ row.gamesPlayed }}</td>
                <td class="py-2 pr-4 text-right tabular-nums">{{ money(row.netLoss) }}</td>
                <td class="py-2 pr-4">{{ shortDate(row.lastPlayedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="preview && preview.pagination.totalPages > 1" #footer>
          <div class="flex items-center justify-between">
            <span class="text-sm text-(--ui-text-muted)">
              Page {{ preview.pagination.page }} of {{ preview.pagination.totalPages }}
            </span>
            <div class="flex gap-2">
              <UButton
                size="xs"
                variant="ghost"
                label="Previous"
                :disabled="page <= 1"
                @click="page--"
              />
              <UButton
                size="xs"
                variant="ghost"
                label="Next"
                :disabled="page >= preview.pagination.totalPages"
                @click="page++"
              />
            </div>
          </div>
        </template>
      </UCard>
    </template>
  </div>
</template>
