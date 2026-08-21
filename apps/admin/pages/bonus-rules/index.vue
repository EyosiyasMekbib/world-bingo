<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getBonusRules, createBonusRule, toggleBonusRule, getBonusReconciliation } = useAdminApi()
const toast = useToast()

const rules = ref<any[]>([])
const loading = ref(true)
const showCreate = ref(false)
const creating = ref(false)

const mismatches = ref<Array<{ userId: string; cachedBalance: number; lotSum: number }>>([])
const reconciling = ref(false)
const reconciliationStatus = ref<'checking' | 'clean' | 'drift' | 'error'>('checking')

const form = reactive({
  name: '',
  type: 'DAILY_DEPOSIT' as 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT',
  threshold: 500,
  rewardType: 'FIXED' as 'FIXED' | 'PERCENTAGE',
  rewardValue: 50,
  maxReward: null as number | null,
  validityHours: 24,
  startsAt: '',
  endsAt: '',
})

const typeOptions = [
  { label: 'Daily deposit', value: 'DAILY_DEPOSIT' },
  { label: 'Weekly deposit', value: 'WEEKLY_DEPOSIT' },
]

const rewardTypeOptions = [
  { label: 'Fixed amount (ETB)', value: 'FIXED' },
  { label: 'Percentage of bucket total', value: 'PERCENTAGE' },
]

const rewardValueLabel = computed(() =>
  form.rewardType === 'PERCENTAGE' ? 'Reward Percentage (%)' : 'Reward Amount (ETB)'
)

async function fetchRules() {
  loading.value = true
  try {
    rules.value = (await getBonusRules()) as any[] ?? []
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load bonus rules', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function fetchReconciliation() {
  reconciling.value = true
  reconciliationStatus.value = 'checking'
  try {
    mismatches.value = await getBonusReconciliation()
    reconciliationStatus.value = mismatches.value.length ? 'drift' : 'clean'
  } catch {
    reconciliationStatus.value = 'error'
    toast.add({ title: 'Error', description: 'Failed to run reconciliation', color: 'error' })
  } finally {
    reconciling.value = false
  }
}

async function create() {
  if (!form.name.trim() || !form.startsAt || !form.endsAt) {
    toast.add({ title: 'Missing fields', description: 'Name, Period Start and Period End are required', color: 'error' })
    return
  }
  creating.value = true
  try {
    await createBonusRule({
      name: form.name,
      type: form.type,
      threshold: form.threshold,
      rewardType: form.rewardType,
      rewardValue: form.rewardValue,
      maxReward: form.rewardType === 'PERCENTAGE' ? form.maxReward : null,
      validityHours: form.validityHours,
      startsAt: new Date(form.startsAt).toISOString(),
      endsAt: new Date(form.endsAt).toISOString(),
    })
    toast.add({ title: 'Created', description: 'Bonus rule created', color: 'success' })
    showCreate.value = false
    form.name = ''
    form.threshold = 500
    form.rewardType = 'FIXED'
    form.rewardValue = 50
    form.maxReward = null
    form.validityHours = 24
    form.startsAt = ''
    form.endsAt = ''
    await fetchRules()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to create', color: 'error' })
  } finally {
    creating.value = false
  }
}

async function toggle(rule: any) {
  try {
    await toggleBonusRule(rule.id, !rule.isActive)
    rule.isActive = !rule.isActive
    toast.add({ title: 'Updated', color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to toggle', color: 'error' })
  }
}

const reconciliationIcon = computed(() => ({
  checking: 'i-heroicons:arrow-path',
  clean: 'i-heroicons:check-circle',
  drift: 'i-heroicons:exclamation-triangle',
  error: 'i-heroicons:x-circle',
}[reconciliationStatus.value]))

const reconciliationIconColor = computed(() => ({
  checking: 'text-white/40',
  clean: 'text-green-400',
  drift: 'text-red-400',
  error: 'text-amber-400',
}[reconciliationStatus.value]))

const reconciliationBorderClass = computed(() => ({
  checking: 'border-(--surface-border)',
  clean: 'border-(--surface-border)',
  drift: 'border-red-500/40 bg-red-500/5',
  error: 'border-amber-500/40 bg-amber-500/5',
}[reconciliationStatus.value]))

const reconciliationMessage = computed(() => {
  if (reconciliationStatus.value === 'checking') return 'Checking bonus ledger for drift...'
  if (reconciliationStatus.value === 'clean') return 'Bonus ledger reconciled — no drift detected'
  if (reconciliationStatus.value === 'drift') return `${mismatches.value.length} wallet(s) disagree with their bonus grant ledger`
  return 'Reconciliation check failed — try again'
})

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-ET', { year: 'numeric', month: 'short', day: 'numeric' })
}

function describeRule(rule: any) {
  const threshold = Number(rule.threshold).toFixed(0)
  const val = rule.rewardType === 'PERCENTAGE'
    ? `${Number(rule.rewardValue).toFixed(0)}%${rule.maxReward ? ` up to ${Number(rule.maxReward).toFixed(0)} ETB` : ''}`
    : `${Number(rule.rewardValue).toFixed(2)} ETB`
  const period = rule.type === 'DAILY_DEPOSIT' ? 'a day' : 'a week'
  return `Deposit ${threshold} ETB in ${period} → get ${val}, usable for ${rule.validityHours}h`
}

onMounted(() => {
  fetchRules()
  fetchReconciliation()
})
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Deposit Bonus Rules</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Configure daily and weekly deposit-threshold bonuses</p>
      </div>
      <UButton icon="i-heroicons:plus" label="New Rule" color="primary" @click="showCreate = true" />
    </div>

    <!-- Reconciliation widget (design spec §7) -->
    <div
      class="rounded-2xl border p-4 flex items-center justify-between"
      :class="reconciliationBorderClass"
      style="background: var(--surface-raised);"
    >
      <div class="flex items-center gap-3">
        <UIcon
          :name="reconciliationIcon"
          :class="[reconciliationIconColor, { 'animate-spin': reconciliationStatus === 'checking' }]"
          class="w-5 h-5"
        />
        <span class="text-sm text-white/70">{{ reconciliationMessage }}</span>
      </div>
      <UButton size="xs" variant="ghost" color="neutral" icon="i-heroicons:arrow-path" :loading="reconciling" label="Re-check" @click="fetchReconciliation" />
    </div>
    <div v-if="reconciliationStatus === 'drift'" class="rounded-xl border border-red-500/20 divide-y divide-red-500/10">
      <div v-for="m in mismatches" :key="m.userId" class="px-4 py-2 text-xs text-white/60 flex justify-between">
        <span>{{ m.userId }}</span>
        <span>wallet: {{ m.cachedBalance.toFixed(2) }} · lots: {{ m.lotSum.toFixed(2) }}</span>
      </div>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" /> Loading...
    </div>

    <div v-else-if="!rules.length" class="text-center py-16 text-white/30 bg-white/5 rounded-2xl border border-white/5">
      <UIcon name="i-heroicons:gift" class="w-12 h-12 mx-auto mb-3 opacity-20" />
      <p class="text-lg font-medium">No bonus rules yet</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="rule in rules"
        :key="rule.id"
        class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
        style="background: var(--surface-raised);"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1">
            <div class="flex items-center gap-3">
              <h3 class="text-base font-bold text-white">{{ rule.name }}</h3>
              <UBadge color="neutral" variant="soft" :label="rule.type === 'DAILY_DEPOSIT' ? 'Daily' : 'Weekly'" />
              <UBadge :color="rule.isActive ? 'success' : 'neutral'" variant="soft" :label="rule.isActive ? 'Active' : 'Inactive'" />
            </div>
            <p class="text-sm text-white/40 mt-1">{{ describeRule(rule) }}</p>
            <p class="text-xs text-white/30 mt-1">{{ formatDate(rule.startsAt) }} — {{ formatDate(rule.endsAt) }}</p>
          </div>
          <USwitch :model-value="rule.isActive" color="primary" @update:model-value="toggle(rule)" />
        </div>
      </div>
    </div>

    <UModal v-model:open="showCreate" title="Create Bonus Rule" :ui="{ content: 'max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name">
            <UInput v-model="form.name" placeholder="Daily 500 bonus" class="w-full" />
          </UFormField>
          <UFormField label="Type">
            <USelect v-model="form.type" :items="typeOptions" value-key="value" label-key="label" class="w-full" />
          </UFormField>
          <UFormField label="Threshold (ETB)">
            <UInput v-model.number="form.threshold" type="number" min="1" class="w-full" />
          </UFormField>
          <UFormField label="Reward Type">
            <USelect v-model="form.rewardType" :items="rewardTypeOptions" value-key="value" label-key="label" class="w-full" />
          </UFormField>
          <UFormField :label="rewardValueLabel">
            <UInput v-model.number="form.rewardValue" type="number" min="0.01" class="w-full" />
          </UFormField>
          <UFormField v-if="form.rewardType === 'PERCENTAGE'" label="Max Reward (ETB, optional)">
            <UInput v-model.number="form.maxReward" type="number" min="0" class="w-full" />
          </UFormField>
          <UFormField label="Validity (hours)">
            <UInput v-model.number="form.validityHours" type="number" min="1" max="2160" class="w-full" />
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
