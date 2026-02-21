<script setup lang="ts">
const { getPendingDeposits, approveTransaction, declineTransaction } = useAdminApi()
const toast = useToast()

const columns = [
  { accessorKey: 'id', header: 'Transaction ID' },
  { accessorKey: 'user.username', header: 'User' },
  { accessorKey: 'amount', header: 'Amount (ETB)' },
  { accessorKey: 'createdAt', header: 'Timestamp' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'actions', header: 'Actions' }
]

const pendingDeposits = ref<any[]>([])
const loading = ref(false)

const refreshDeposits = async () => {
  loading.value = true
  try {
    pendingDeposits.value = await getPendingDeposits()
  } catch (error) {
    toast.add({ title: 'Error', description: 'Failed to fetch deposits', color: 'error' })
  } finally {
    loading.value = false
  }
}

const handleApprove = async (id: string) => {
  try {
    await approveTransaction(id)
    toast.add({ title: 'Approved', color: 'success' })
    refreshDeposits()
  } catch (error) {
    toast.add({ title: 'Error', description: 'Failed to approve', color: 'error' })
  }
}

const handleDecline = async (id: string) => {
  try {
    await declineTransaction(id)
    toast.add({ title: 'Declined', color: 'warning' })
    refreshDeposits()
  } catch (error) {
    toast.add({ title: 'Error', description: 'Failed to decline', color: 'error' })
  }
}

// Receipt Modal State
const isReceiptOpen = ref(false)
const selectedReceipt = ref('')

const openReceipt = (url: string) => {
  selectedReceipt.value = url
  isReceiptOpen.value = true
}

onMounted(refreshDeposits)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold text-gray-900">Pending Deposits</h1>
    </div>

    <UCard>
      <UTable :columns="columns" :rows="pendingDeposits" :loading="loading">
        <template #createdAt-cell="{ row }">
          {{ new Date(row.original.createdAt).toLocaleString() }}
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="row.original.status === 'PENDING_REVIEW' ? 'warning' : 'neutral'" variant="soft">{{ row.original.status }}</UBadge>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-2">
            <UButton size="xs" color="neutral" variant="ghost" icon="i-heroicons-photo" title="View Receipt" @click="openReceipt(row.original.receiptUrl)" />
            <UButton size="xs" color="success" variant="soft" icon="i-heroicons-check" @click="handleApprove(row.original.id)">Approve</UButton>
            <UButton size="xs" color="error" variant="soft" icon="i-heroicons-x-mark" @click="handleDecline(row.original.id)">Decline</UButton>
          </div>
        </template>
      </UTable>
    </UCard>

    <!-- Receipt Modal -->
    <UModal v-model="isReceiptOpen">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-base font-semibold leading-6 text-gray-900 dark:text-white">
              Transfer Receipt Proof
            </h3>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" class="-my-1" @click="isReceiptOpen = false" />
          </div>
        </template>

        <div class="p-4 flex justify-center bg-gray-100 rounded">
          <img :src="selectedReceipt" alt="Receipt" class="max-w-full max-h-[70vh] object-contain shadow-lg" />
        </div>
      </UCard>
    </UModal>
  </div>
</template>
