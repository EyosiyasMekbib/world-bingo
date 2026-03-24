<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getCashbackPromotions, createCashbackPromotion, toggleCashbackPromotion, disburseCashback } = useAdminApi()
const toast = useToast()

const promotions = ref<any[]>([])
const loading = ref(true)
const showCreate = ref(false)
const creating = ref(false)
const disbursingId = ref<string | null>(null)

const form = reactive({
  name: '',
  percentage: 10,
  startsAt: '',
  endsAt: '',
})

async function fetchPromotions() {
  loading.value = true
  try {
    promotions.value = (await getCashbackPromotions()) as any[] ?? []
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load promotions', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function create() {
  creating.value = true
  try {
    await createCashbackPromotion({
      name: form.name,
      percentage: form.percentage,
      startsAt: new Date(form.startsAt).toISOString(),
      endsAt: new Date(form.endsAt).toISOString(),
    })
    toast.add({ title: 'Created', description: 'Cashback promotion created', color: 'success' })
    showCreate.value = false
    form.name = ''
    form.percentage = 10
    form.startsAt = ''
    form.endsAt = ''
    await fetchPromotions()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to create', color: 'error' })
  } finally {
    creating.value = false
  }
}

async function toggle(promo: any) {
  try {
    await toggleCashbackPromotion(promo.id, !promo.isActive)
    promo.isActive = !promo.isActive
    toast.add({ title: 'Updated', color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to toggle', color: 'error' })
  }
}

async function disburse(id: string) {
  disbursingId.value = id
  try {
    const result = await disburseCashback(id) as any
    toast.add({
      title: 'Disbursed',
      description: `${result.disbursed} players received cashback (${result.skipped} skipped). Total: ${Number(result.total).toFixed(2)} ETB`,
      color: 'success',
    })
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to disburse', color: 'error' })
  } finally {
    disbursingId.value = null
  }
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-ET', { year: 'numeric', month: 'short', day: 'numeric' })
}

onMounted(fetchPromotions)
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Cashback Promotions</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Create and manage cashback campaigns for players</p>
      </div>
      <UButton icon="i-heroicons:plus" label="New Promotion" color="primary" @click="showCreate = true" />
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" /> Loading...
    </div>

    <div v-else-if="!promotions.length" class="text-center py-16 text-white/30 bg-white/5 rounded-2xl border border-white/5">
      <UIcon name="i-heroicons:gift" class="w-12 h-12 mx-auto mb-3 opacity-20" />
      <p class="text-lg font-medium">No promotions yet</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="promo in promotions"
        :key="promo.id"
        class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
        style="background: var(--surface-raised);"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1">
            <div class="flex items-center gap-3">
              <h3 class="text-base font-bold text-white">{{ promo.name }}</h3>
              <UBadge :color="promo.isActive ? 'success' : 'neutral'" variant="soft" :label="promo.isActive ? 'Active' : 'Inactive'" />
            </div>
            <p class="text-sm text-white/40 mt-1">{{ Number(promo.percentage) }}% cashback &middot; {{ formatDate(promo.startsAt) }} — {{ formatDate(promo.endsAt) }}</p>
            <p class="text-xs text-white/30 mt-1">{{ promo._count?.disbursements ?? 0 }} disbursements</p>
          </div>
          <div class="flex items-center gap-2">
            <USwitch :model-value="promo.isActive" color="primary" @update:model-value="toggle(promo)" />
            <UButton
              size="sm"
              color="primary"
              variant="soft"
              icon="i-heroicons:banknotes"
              label="Disburse"
              :loading="disbursingId === promo.id"
              :disabled="!promo.isActive"
              @click="disburse(promo.id)"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    <UModal v-model:open="showCreate" title="Create Cashback Promotion" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name">
            <UInput v-model="form.name" placeholder="Weekend Cashback" class="w-full" />
          </UFormField>
          <UFormField label="Cashback Percentage">
            <UInput v-model.number="form.percentage" type="number" min="0.01" max="100" class="w-full" />
          </UFormField>
          <UFormField label="Period Start">
            <UInput v-model="form.startsAt" type="datetime-local" class="w-full" />
          </UFormField>
          <UFormField label="Period End">
            <UInput v-model="form.endsAt" type="datetime-local" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" @click="showCreate = false" />
          <UButton color="primary" :loading="creating" label="Create" @click="create" />
        </div>
      </template>
    </UModal>
  </div>
</template>
