<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { getCampaigns } = useAdminApi()
const toast = useToast()

const campaigns = ref<any[]>([])
const loading = ref(true)

async function load() {
  loading.value = true
  try {
    campaigns.value = await getCampaigns()
  } catch (err: any) {
    toast.add({ title: 'Error', description: err?.data?.error ?? 'Failed to load', color: 'error' })
  } finally {
    loading.value = false
  }
}
onMounted(load)

const STATUS_COLOR: Record<string, string> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  RUNNING: 'primary',
  COMPLETED: 'success',
  FAILED: 'error',
  CANCELLED: 'neutral',
}

function grantsMoney(campaign: any) {
  return !!campaign?.actions?.bonus?.amount
}

function money(v: any) {
  return Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}
</script>

<template>
  <div class="p-4 md:p-6 space-y-6">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Campaigns</h1>
        <p class="text-sm text-(--ui-text-muted)">
          Send a message to a segment, or grant bonus credit to it.
        </p>
      </div>
      <div class="flex gap-2">
        <UButton label="Segments" color="neutral" variant="subtle" to="/crm" />
        <UButton icon="i-heroicons:plus" label="New campaign" color="primary" to="/campaigns/new" />
      </div>
    </div>

    <div v-if="loading" class="space-y-3">
      <USkeleton v-for="i in 3" :key="i" class="h-16 w-full" />
    </div>

    <UCard v-else-if="!campaigns.length">
      <div class="text-center py-10 space-y-2">
        <UIcon name="i-heroicons:megaphone" class="size-10 text-(--ui-text-muted)" />
        <p class="font-medium">No campaigns yet</p>
        <UButton label="Create one" color="primary" to="/campaigns/new" />
      </div>
    </UCard>

    <UCard v-else>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-xs uppercase text-(--ui-text-muted)">
            <tr>
              <th class="py-2 pr-4">Campaign</th>
              <th class="py-2 pr-4">Segment</th>
              <th class="py-2 pr-4">Type</th>
              <th class="py-2 pr-4">Status</th>
              <th class="py-2 pr-4 text-right">Sent</th>
              <th class="py-2 pr-4 text-right">Granted</th>
              <th class="py-2 pr-4">Approved by</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in campaigns"
              :key="c.id"
              class="border-t border-(--ui-border) hover:bg-(--ui-bg-elevated) cursor-pointer"
              @click="navigateTo(`/campaigns/${c.id}`)"
            >
              <td class="py-2 pr-4 font-medium">{{ c.name }}</td>
              <td class="py-2 pr-4 text-(--ui-text-muted)">{{ c.segment?.name ?? '—' }}</td>
              <td class="py-2 pr-4">
                <UBadge
                  :color="grantsMoney(c) ? 'warning' : 'neutral'"
                  variant="soft"
                  size="xs"
                  :label="grantsMoney(c) ? 'Bonus grant' : 'Message'"
                />
              </td>
              <td class="py-2 pr-4">
                <UBadge :color="(STATUS_COLOR[c.status] as any) ?? 'neutral'" variant="soft" size="xs" :label="c.status" />
              </td>
              <td class="py-2 pr-4 text-right tabular-nums">
                {{ c.sentCount }}<span class="text-(--ui-text-muted)">/{{ c.snapshotSize ?? '—' }}</span>
              </td>
              <td class="py-2 pr-4 text-right tabular-nums">
                <span v-if="grantsMoney(c)">{{ money(c.grantedTotal) }} ETB</span>
                <span v-else class="text-(--ui-text-muted)">—</span>
              </td>
              <td class="py-2 pr-4 text-(--ui-text-muted)">{{ c.approvedByUsername ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>
  </div>
</template>
