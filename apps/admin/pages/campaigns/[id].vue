<script setup lang="ts">
definePageMeta({ layout: 'default' })

const route = useRoute()
const {
  getCampaign,
  submitCampaign,
  approveCampaign,
  launchCampaign,
  stopCampaign,
} = useAdminApi()
const toast = useToast()

const id = route.params.id as string
const campaign = ref<any>(null)
const loading = ref(true)
const busy = ref(false)

const showApprove = ref(false)
const approvalNote = ref('')

async function load() {
  loading.value = true
  try {
    campaign.value = await getCampaign(id)
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to load', color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(load)

/** Poll while running so progress is visible without a manual refresh. */
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    if (campaign.value?.status === 'RUNNING') load()
  }, 5000)
})
onUnmounted(() => timer && clearInterval(timer))

const grantsMoney = computed(() => !!campaign.value?.actions?.bonus?.amount)
const bonusAmount = computed(() => Number(campaign.value?.actions?.bonus?.amount ?? 0))

const worstCase = computed(() => {
  if (!grantsMoney.value || !campaign.value) return 0
  return Math.min(
    bonusAmount.value * campaign.value.maxRecipients,
    Number(campaign.value.maxTotalBonus),
  )
})

const progress = computed(() => {
  const c = campaign.value
  if (!c?.snapshotSize) return 0
  return Math.round(((c.sentCount + c.skippedCount + c.failedCount) / c.snapshotSize) * 100)
})

function money(v: any) {
  return Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

async function act(fn: () => Promise<unknown>, success: string) {
  busy.value = true
  try {
    await fn()
    toast.add({ title: success, color: 'success' })
    await load()
  } catch (err: any) {
    toast.add({ title: 'Failed', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    busy.value = false
  }
}

async function doApprove() {
  if (grantsMoney.value && !approvalNote.value.trim()) return
  await act(() => approveCampaign(id, approvalNote.value.trim() || undefined), 'Campaign approved')
  showApprove.value = false
  approvalNote.value = ''
}
</script>

<template>
  <div class="p-4 md:p-6 space-y-6 max-w-4xl">
    <div v-if="loading"><USkeleton class="h-40 w-full" /></div>

    <template v-else-if="campaign">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <UButton icon="i-heroicons:arrow-left" variant="ghost" color="neutral" to="/campaigns" />
          <div class="min-w-0">
            <h1 class="text-xl font-semibold truncate">{{ campaign.name }}</h1>
            <p class="text-sm text-(--ui-text-muted)">
              {{ campaign.segment?.name }} ·
              <UBadge size="xs" variant="soft" :label="campaign.status" />
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <UButton
            v-if="campaign.status === 'DRAFT'"
            label="Submit for approval"
            color="primary"
            :loading="busy"
            @click="act(() => submitCampaign(id), 'Submitted')"
          />
          <UButton
            v-if="campaign.status === 'PENDING_APPROVAL'"
            label="Approve"
            color="primary"
            :loading="busy"
            @click="showApprove = true"
          />
          <UButton
            v-if="campaign.status === 'APPROVED'"
            label="Launch"
            color="primary"
            :loading="busy"
            @click="act(() => launchCampaign(id), 'Campaign launched')"
          />
          <UButton
            v-if="['RUNNING', 'APPROVED', 'PENDING_APPROVAL'].includes(campaign.status)"
            label="Stop"
            color="error"
            variant="subtle"
            :loading="busy"
            @click="act(() => stopCampaign(id), 'Campaign stopped')"
          />
        </div>
      </div>

      <!-- Money exposure stays visible at every stage, not only at approval. -->
      <UAlert v-if="grantsMoney" color="warning" variant="subtle" icon="i-heroicons:banknotes">
        <template #description>
          <div class="flex flex-wrap gap-x-6 gap-y-1">
            <span>Per player: <strong>{{ money(bonusAmount) }} ETB</strong></span>
            <span>Worst case: <strong>{{ money(worstCase) }} ETB</strong></span>
            <span>Granted so far: <strong class="tabular-nums">{{ money(campaign.grantedTotal) }} ETB</strong></span>
          </div>
        </template>
      </UAlert>

      <UCard v-if="campaign.status === 'RUNNING' || campaign.snapshotSize">
        <template #header>
          <div class="flex items-center justify-between">
            <h2 class="font-medium">Progress</h2>
            <span class="text-sm text-(--ui-text-muted) tabular-nums">{{ progress }}%</span>
          </div>
        </template>
        <UProgress :model-value="progress" class="mb-4" />
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
          <div>
            <div class="text-2xl font-semibold tabular-nums">{{ campaign.snapshotSize ?? '—' }}</div>
            <div class="text-xs text-(--ui-text-muted)">Recipients</div>
          </div>
          <div>
            <div class="text-2xl font-semibold tabular-nums text-(--ui-success)">{{ campaign.sentCount }}</div>
            <div class="text-xs text-(--ui-text-muted)">Delivered</div>
          </div>
          <div>
            <div class="text-2xl font-semibold tabular-nums">{{ campaign.skippedCount }}</div>
            <div class="text-xs text-(--ui-text-muted)">Skipped</div>
          </div>
          <div>
            <div class="text-2xl font-semibold tabular-nums" :class="campaign.failedCount ? 'text-(--ui-error)' : ''">
              {{ campaign.failedCount }}
            </div>
            <div class="text-xs text-(--ui-text-muted)">Failed</div>
          </div>
        </div>

        <template v-if="campaign.breakdown?.length" #footer>
          <div class="flex flex-wrap gap-2 text-xs">
            <UBadge
              v-for="row in campaign.breakdown"
              :key="row.status"
              variant="soft"
              color="neutral"
              :label="`${row.status}: ${row._count}`"
            />
          </div>
        </template>
      </UCard>

      <UCard>
        <template #header><h2 class="font-medium">Audit</h2></template>
        <dl class="grid gap-x-6 gap-y-2 sm:grid-cols-2 text-sm">
          <div><dt class="text-(--ui-text-muted)">Created by</dt><dd>{{ campaign.createdByUsername ?? '—' }}</dd></div>
          <div><dt class="text-(--ui-text-muted)">Approved by</dt><dd>{{ campaign.approvedByUsername ?? '—' }}</dd></div>
          <div><dt class="text-(--ui-text-muted)">Approved at</dt><dd>{{ campaign.approvedAt ? new Date(campaign.approvedAt).toLocaleString() : '—' }}</dd></div>
          <div><dt class="text-(--ui-text-muted)">Recipient cap</dt><dd>{{ campaign.maxRecipients?.toLocaleString() }}</dd></div>
          <div v-if="campaign.approvalNote" class="sm:col-span-2">
            <dt class="text-(--ui-text-muted)">Approval note</dt>
            <dd>{{ campaign.approvalNote }}</dd>
          </div>
        </dl>
      </UCard>
    </template>

    <!-- Approval dialog. For money campaigns the exposure is restated here, at the
         moment of commitment, and a note is mandatory. -->
    <UModal v-model:open="showApprove">
      <template #content>
        <UCard>
          <template #header><h3 class="font-medium">Approve campaign</h3></template>

          <div class="space-y-4">
            <UAlert v-if="grantsMoney" color="warning" variant="subtle">
              <template #description>
                You are authorising up to
                <strong class="text-base">{{ money(worstCase) }} ETB</strong>
                of bonus credit to be paid to as many as
                {{ campaign?.maxRecipients?.toLocaleString() }} players.
                This cannot be undone automatically.
              </template>
            </UAlert>

            <UFormField
              :label="grantsMoney ? 'Approval note (required)' : 'Approval note'"
              :required="grantsMoney"
            >
              <UTextarea
                v-model="approvalNote"
                :rows="2"
                placeholder="Why this campaign is approved"
                class="w-full"
              />
            </UFormField>

            <p class="text-xs text-(--ui-text-muted)">
              You cannot approve a campaign you created or last edited.
            </p>
          </div>

          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton label="Cancel" color="neutral" variant="ghost" @click="showApprove = false" />
              <UButton
                label="Approve"
                color="primary"
                :loading="busy"
                :disabled="grantsMoney && !approvalNote.trim()"
                @click="doApprove"
              />
            </div>
          </template>
        </UCard>
      </template>
    </UModal>
  </div>
</template>
