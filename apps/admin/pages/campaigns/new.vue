<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getSegments, createCampaign } = useAdminApi()
const toast = useToast()
const router = useRouter()

const segments = ref<any[]>([])
const loading = ref(true)
const saving = ref(false)

const form = reactive({
  name: '',
  segmentId: '',
  sendMessage: true,
  title: '',
  body: '',
  grantBonus: false,
  bonusAmount: 0,
  maxRecipients: 1000,
  maxPerPlayer: 50,
  maxTotalBonus: 5000,
})

onMounted(async () => {
  try {
    segments.value = await getSegments()
  } finally {
    loading.value = false
  }
})

const selectedSegment = computed(() => segments.value.find((s) => s.id === form.segmentId))

/**
 * Worst-case spend, shown before anything is approved.
 *
 * The number that matters is not "how much per player" — it is what leaves the
 * business if this runs to completion. It is bounded by BOTH the recipient cap and
 * the total cap, so it reflects what the guardrails will actually permit rather
 * than the optimistic reading.
 */
const totalAtRisk = computed(() => {
  if (!form.grantBonus || !form.bonusAmount) return 0
  const byRecipients = form.bonusAmount * form.maxRecipients
  return Math.min(byRecipients, form.maxTotalBonus)
})

const capBinding = computed(() => {
  if (!form.grantBonus || !form.bonusAmount) return null
  return form.bonusAmount * form.maxRecipients > form.maxTotalBonus ? 'total' : 'recipients'
})

const canSave = computed(() => {
  if (!form.name.trim() || !form.segmentId) return false
  if (form.sendMessage && (!form.title.trim() || !form.body.trim())) return false
  if (form.grantBonus && form.bonusAmount <= 0) return false
  return form.sendMessage || form.grantBonus
})

async function save() {
  if (!canSave.value) return
  saving.value = true
  try {
    const actions: any = {}
    if (form.sendMessage) actions.message = { title: form.title.trim(), body: form.body.trim() }
    if (form.grantBonus) actions.bonus = { amount: form.bonusAmount }

    const campaign: any = await createCampaign({
      name: form.name.trim(),
      segmentId: form.segmentId,
      actions,
      maxRecipients: form.maxRecipients,
      maxTotalBonus: form.grantBonus ? form.maxTotalBonus : 0,
      maxPerPlayer: form.grantBonus ? form.maxPerPlayer : 0,
    })
    toast.add({ title: 'Campaign created as draft', color: 'success' })
    router.push(`/campaigns/${campaign.id}`)
  } catch (err: any) {
    toast.add({ title: 'Could not create', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="p-4 md:p-6 space-y-6 max-w-3xl">
    <div class="flex items-center gap-2">
      <UButton icon="i-heroicons:arrow-left" variant="ghost" color="neutral" to="/campaigns" />
      <h1 class="text-xl font-semibold">New campaign</h1>
    </div>

    <UCard>
      <div class="space-y-4">
        <UFormField label="Name" required>
          <UInput v-model="form.name" placeholder="e.g. August win-back" class="w-full" />
        </UFormField>

        <UFormField label="Audience" required>
          <USelect
            v-model="form.segmentId"
            :items="segments.map((s) => ({ label: `${s.name}${s.cachedCount != null ? ` (${s.cachedCount})` : ''}`, value: s.id }))"
            value-key="value"
            placeholder="Choose a segment"
            :loading="loading"
            class="w-full"
          />
        </UFormField>
        <p v-if="selectedSegment" class="text-xs font-mono text-(--ui-text-muted) -mt-2">
          {{ selectedSegment.summary }}
        </p>
      </div>
    </UCard>

    <UCard>
      <template #header><h2 class="font-medium">What it does</h2></template>

      <div class="space-y-5">
        <div class="space-y-3">
          <UCheckbox v-model="form.sendMessage" label="Send an in-app message" />
          <template v-if="form.sendMessage">
            <UFormField label="Title">
              <UInput v-model="form.title" placeholder="We miss you!" class="w-full" />
            </UFormField>
            <UFormField label="Message">
              <UTextarea v-model="form.body" :rows="3" placeholder="Come back for a game today." class="w-full" />
            </UFormField>
          </template>
        </div>

        <div class="pt-4 border-t border-(--ui-border) space-y-3">
          <UCheckbox v-model="form.grantBonus" label="Grant bonus credit (real money)" />

          <template v-if="form.grantBonus">
            <div class="grid gap-3 sm:grid-cols-3">
              <UFormField label="Per player (ETB)">
                <UInput v-model.number="form.bonusAmount" type="number" min="1" class="w-full" />
              </UFormField>
              <UFormField label="Max recipients">
                <UInput v-model.number="form.maxRecipients" type="number" min="1" class="w-full" />
              </UFormField>
              <UFormField label="Total cap (ETB)">
                <UInput v-model.number="form.maxTotalBonus" type="number" min="0" class="w-full" />
              </UFormField>
            </div>

            <!-- The number that must be impossible to miss. -->
            <UAlert color="warning" variant="subtle" icon="i-heroicons:banknotes">
              <template #description>
                <div class="space-y-1">
                  <div class="text-base">
                    Up to <strong class="tabular-nums">{{ totalAtRisk.toLocaleString() }} ETB</strong>
                    will leave the business if this runs to completion.
                  </div>
                  <div class="text-xs">
                    {{ form.bonusAmount.toLocaleString() }} ETB ×
                    {{ form.maxRecipients.toLocaleString() }} recipients, capped at
                    {{ form.maxTotalBonus.toLocaleString() }} ETB total —
                    <strong>{{ capBinding === 'total' ? 'the total cap' : 'the recipient cap' }}</strong>
                    is the binding limit.
                  </div>
                  <div class="text-xs">
                    Bonus credit is play-only, but treat it as cash: not every route
                    that converts it back to withdrawable balance is closed yet.
                  </div>
                </div>
              </template>
            </UAlert>
          </template>
        </div>
      </div>
    </UCard>

    <div class="flex items-center justify-end gap-2">
      <UButton label="Cancel" color="neutral" variant="ghost" to="/campaigns" />
      <UButton
        label="Create draft"
        color="primary"
        :loading="saving"
        :disabled="!canSave"
        @click="save"
      />
    </div>
    <p class="text-xs text-(--ui-text-muted) text-right -mt-4">
      Creating a draft sends nothing. It still has to be submitted and approved by someone else.
    </p>
  </div>
</template>
