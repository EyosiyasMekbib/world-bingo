<script setup lang="ts">
interface OrderTransaction {
  id: string
  amount: number
  type: string
  status: string
  createdAt: string
  balanceBefore?: number
  balanceAfter?: number
  user: { username: string; phone: string }
}

const { getTransactionsHistory } = useAdminApi()
const toast = useToast()

const columns = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'user.username', header: 'User' },
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'amount', header: 'Amount (ETB)' },
  { accessorKey: 'balanceAfter', header: 'Balance After' },
  { accessorKey: 'createdAt', header: 'Timestamp' },
  { accessorKey: 'status', header: 'Status' }
]

const typeOptions = [
  { label: 'All Types', value: '' },
  { label: 'Deposit', value: 'DEPOSIT' },
  { label: 'Withdrawal', value: 'WITHDRAWAL' },
  { label: 'Game Entry', value: 'GAME_ENTRY' },
  { label: 'Prize Win', value: 'PRIZE_WIN' },
  { label: 'Refund', value: 'REFUND' },
]

const history = ref<OrderTransaction[]>([])
const loading = ref(false)
const selectedType = ref('')
const page = ref(1)
const limit = 20
const total = ref(0)

const totalPages = computed(() => Math.ceil(total.value / limit))

const refreshHistory = async () => {
  loading.value = true
  try {
    const result = await getTransactionsHistory({
      type: selectedType.value || undefined,
      page: page.value,
      limit,
    })
    // API returns array or paginated object
    if (Array.isArray(result)) {
      history.value = result
      total.value = result.length
    } else {
      history.value = (result as any).data ?? result
      total.value = (result as any).pagination?.total ?? history.value.length
    }
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch history', color: 'error' })
  } finally {
    loading.value = false
  }
}

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}

watch([selectedType, page], refreshHistory)
onMounted(refreshHistory)

function exportCsv() {
  const headers = ['ID', 'User', 'Type', 'Amount', 'Status', 'Created At']
  const rows = history.value.map((t) => [
    t.id,
    t.user?.username ?? '',
    t.type,
    t.amount,
    t.status,
    new Date(t.createdAt).toISOString(),
  ])
  const csv = [headers, ...rows].map((row) => row.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `transactions-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const statusColor = (status: string) => {
  if (status === 'APPROVED') return 'success'
  if (status === 'PENDING_REVIEW') return 'warning'
  return 'error'
}

const typeColor = (type: string) => {
  if (type === 'DEPOSIT') return 'info'
  if (type === 'PRIZE_WIN' || type === 'REFUND') return 'success'
  if (type === 'WITHDRAWAL') return 'warning'
  return 'neutral'
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Orders History</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">All wallet transactions across the platform</p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <USelect v-model="selectedType" :items="typeOptions" value-key="value" class="w-40" />
        <UButton icon="i-heroicons:arrow-down-tray" color="neutral" variant="ghost" @click="exportCsv">Export CSV</UButton>
        <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" @click="refreshHistory">Refresh</UButton>
      </div>
    </div>

    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <UTable :columns="columns" :data="history" :loading="loading">
        <template #id-cell="{ row }">
          <div class="flex items-center gap-1 group">
            <span class="font-mono text-xs text-white/40">{{ (row.original as unknown as OrderTransaction).id.slice(0, 8) }}…</span>
            <UButton
              icon="i-heroicons:clipboard-document text-[10px]"
              variant="ghost" color="neutral" size="xs"
              class="opacity-0 group-hover:opacity-100 p-0.5"
              @click="copyToClipboard((row.original as unknown as OrderTransaction).id)"
            />
          </div>
        </template>
        <template #amount-cell="{ row }">
          <span class="font-bold text-yellow-500">{{ Number((row.original as unknown as OrderTransaction).amount).toFixed(2) }}</span>
        </template>
        <template #balanceAfter-cell="{ row }">
          <span class="text-xs text-white/40 font-medium">
            {{ (row.original as unknown as OrderTransaction).balanceAfter != null ? Number((row.original as unknown as OrderTransaction).balanceAfter).toFixed(2) : '—' }}
          </span>
        </template>
        <template #createdAt-cell="{ row }">
          <span class="text-white/40 text-xs font-medium">{{ new Date((row.original as unknown as OrderTransaction).createdAt).toLocaleString() }}</span>
        </template>
        <template #type-cell="{ row }">
          <UBadge :color="typeColor((row.original as unknown as OrderTransaction).type)" variant="soft">
            {{ (row.original as unknown as OrderTransaction).type }}
          </UBadge>
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="statusColor((row.original as unknown as OrderTransaction).status)" variant="soft">
            {{ (row.original as unknown as OrderTransaction).status }}
          </UBadge>
        </template>
      </UTable>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex justify-center gap-2 py-3 border-t border-(--surface-border)">
        <UButton :disabled="page <= 1" variant="ghost" icon="i-heroicons:chevron-left" @click="page--" />
        <span class="text-sm text-white/40 self-center">Page {{ page }} / {{ totalPages }}</span>
        <UButton :disabled="page >= totalPages" variant="ghost" icon="i-heroicons:chevron-right" @click="page++" />
      </div>
    </div>
  </div>
</template>
