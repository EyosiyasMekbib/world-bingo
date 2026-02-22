<script setup lang="ts">
interface WithdrawalTransaction {
  id: string
  amount: number
  status: string
  createdAt: string
  user: { username: string }
}

const { getWithdrawals, approveTransaction } = useAdminApi()
const toast = useToast()

const columns = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'user.username', header: 'User' },
  { accessorKey: 'amount', header: 'Amount' },
  { accessorKey: 'createdAt', header: 'Timestamp' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'actions', header: 'Actions' }
]

const withdrawals = ref<WithdrawalTransaction[]>([])
const loading = ref(false)

const refreshWithdrawals = async () => {
  loading.value = true
  try {
    withdrawals.value = await getWithdrawals()
  } catch (error) {
    toast.add({ title: 'Error', description: 'Failed to fetch withdrawals', color: 'error' })
  } finally {
    loading.value = false
  }
}

const handleApprove = async (id: string) => {
  try {
    await approveTransaction(id)
    toast.add({ title: 'Approved', description: 'Withdrawal marked as completed', color: 'success' })
    refreshWithdrawals()
  } catch (error) {
    toast.add({ title: 'Error', description: 'Failed to approve', color: 'error' })
  }
}

onMounted(refreshWithdrawals)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold text-gray-900">Withdrawals Management</h1>
    </div>

    <UAlert
      icon="i-heroicons-information-circle"
      color="warning"
      variant="soft"
      title="Manual Settlement"
      description="Marking a request as transferred will notify the user and update their transaction history. Ensure the transfer is physically made via Telebirr first."
    />

    <UCard>
      <UTable :columns="columns" :rows="withdrawals" :loading="loading">
        <template #createdAt-cell="{ row }">
          {{ new Date((row.original as unknown as WithdrawalTransaction).createdAt).toLocaleString() }}
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="(row.original as unknown as WithdrawalTransaction).status === 'PENDING' ? 'warning' : 'neutral'" variant="soft">{{ (row.original as unknown as WithdrawalTransaction).status }}</UBadge>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-2">
            <UButton size="xs" color="success" variant="soft" icon="i-heroicons-check" @click="handleApprove((row.original as unknown as WithdrawalTransaction).id)">Mark as Transferred</UButton>
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
