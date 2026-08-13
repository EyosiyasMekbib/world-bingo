<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { createSegment } = useAdminApi()
const toast = useToast()
const router = useRouter()

const name = ref('')
const description = ref('')
const rules = ref<any>(null)
const saving = ref(false)

const canSave = computed(() => name.value.trim().length > 0 && !!rules.value)

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    const segment: any = await createSegment({
      name: name.value.trim(),
      description: description.value.trim() || null,
      rules: rules.value,
    })
    toast.add({ title: 'Segment created', color: 'success' })
    router.push(`/crm/${segment.id}`)
  } catch (err: any) {
    toast.add({
      title: 'Could not save',
      description: err?.data?.error ?? 'Failed to create segment',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="p-4 md:p-6 space-y-6 max-w-4xl">
    <div class="flex items-center gap-2">
      <UButton icon="i-heroicons:arrow-left" variant="ghost" color="neutral" to="/crm" />
      <h1 class="text-xl font-semibold">New segment</h1>
    </div>

    <UCard>
      <div class="space-y-4">
        <UFormField label="Name" required>
          <UInput v-model="name" placeholder="e.g. Lapsed high rollers" class="w-full" />
        </UFormField>

        <UFormField label="Description" hint="What this group is for">
          <UInput
            v-model="description"
            placeholder="Depositors over 5,000 ETB who have gone quiet"
            class="w-full"
          />
        </UFormField>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-medium">Conditions</h2>
      </template>

      <SegmentBuilder v-model="rules" />
    </UCard>

    <div class="flex items-center justify-end gap-2">
      <UButton label="Cancel" color="neutral" variant="ghost" to="/crm" />
      <UButton label="Create segment" color="primary" :loading="saving" :disabled="!canSave" @click="save" />
    </div>
  </div>
</template>
