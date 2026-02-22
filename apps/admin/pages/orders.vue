<script setup lang="ts">
interface OrderTransaction {
  id: string
  amount: number
  type: string
  status: string
  createdAt: string
  user: { username: string }
}

const { getTransactionsHistory } = useAdminApi()
const toast = useToast()

const columns = [
  { accessorKey: 'id', header: 'Transaction ID' },
  { accessorKey: 'user.username', header: 'User' },
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'amount', header: 'Amount (ETB)' },
  { accessorKey: 'createdAt', header: 'Timestamp' },
  { accessorKey: 'status', header: 'Status' }
]

const history = ref<OrderTransaction[]>([])
const loading = ref(false)

const refreshHistory = async () => {
  loading.value = true
  try {
    history.value = await getTransactionsHistory()
  } catch (error) {
    toast.add({ title: 'Error', description: 'Failed to fetch history', color: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(refreshHistory)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold text-gray-900">Orders History</h1>
    </div>

    <UCard>
      <UTable :columns="columns" :rows="history" :loading="loading">
        <template #createdAt-cell="{ row }">
          {{ new Date((row.original as unknown as OrderTransaction).createdAt).toLocaleString() }}
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="(row.original as unknown as OrderTransaction).status === 'APPROVED' ? 'success' : 'error'" variant="soft">{{ (row.original as unknown as OrderTransaction).status }}</UBadge>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
