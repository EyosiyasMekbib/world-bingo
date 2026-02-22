<script setup lang="ts">
interface DepositTransaction {
  id: string
  amount: number
  status: string
  createdAt: string
  receiptUrl: string | null
  note?: string
  user: { username: string; phone: string }
}

const { getPendingDeposits, approveTransaction, declineTransaction } = useAdminApi()
const toast = useToast()

const columns = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'user.username', header: 'User' },
  { accessorKey: 'user.phone', header: 'Phone' },
  { accessorKey: 'amount', header: 'Amount (ETB)' },
  { accessorKey: 'createdAt', header: 'Submitted' },
  { accessorKey: 'receipt', header: 'Receipt' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'actions', header: 'Actions' }
]

const pendingDeposits = ref<DepositTransaction[]>([])
const loading = ref(false)
const declineNote = ref('')
const showDeclineModal = ref(false)
const selectedDeclineId = ref<string | null>(null)

const refreshDeposits = async () => {
  loading.value = true
  try {
    pendingDeposits.value = await getPendingDeposits()
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch deposits', color: 'error' })
  } finally {
    loading.value = false
  }
}

const handleApprove = async (id: string) => {
  try {
    await approveTransaction(id)
    toast.add({ title: 'Approved ✅', description: 'Deposit credited to player wallet', color: 'success' })
    refreshDeposits()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to approve', color: 'error' })
  }
}

const openDeclineModal = (id: string) => {
  selectedDeclineId.value = id
  declineNote.value = ''
  showDeclineModal.value = true
}

const handleDecline = async () => {
  if (!selectedDeclineId.value) return
  try {
    await declineTransaction(selectedDeclineId.value, declineNote.value || undefined)
    toast.add({ title: 'Declined', description: 'Player has been notified', color: 'warning' })
    showDeclineModal.value = false
    refreshDeposits()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to decline', color: 'error' })
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
      <UButton icon="i-heroicons-arrow-path" variant="ghost" @click="refreshDeposits">Refresh</UButton>
    </div>

    <UCard>
      <UTable :columns="columns" :rows="pendingDeposits" :loading="loading">
        <template #id-cell="{ row }">
          <span class="font-mono text-xs">{{ (row.original as unknown as DepositTransaction).id.slice(0, 8) }}…</span>
        </template>
        <template #amount-cell="{ row }">
          <strong>{{ Number((row.original as unknown as DepositTransaction).amount).toFixed(2) }}</strong>
        </template>
        <template #createdAt-cell="{ row }">
          {{ new Date((row.original as unknown as DepositTransaction).createdAt).toLocaleString() }}
        </template>
        <template #receipt-cell="{ row }">
          <UButton
            v-if="(row.original as unknown as DepositTransaction).receiptUrl"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-heroicons-photo"
            @click="openReceipt((row.original as unknown as DepositTransaction).receiptUrl!)"
          >
            View
          </UButton>
          <span v-else class="text-gray-400 text-xs">No receipt</span>
        </template>
        <template #status-cell="{ row }">
          <UBadge color="warning" variant="soft">{{ (row.original as unknown as DepositTransaction).status }}</UBadge>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-2">
            <UButton size="xs" color="success" variant="soft" icon="i-heroicons-check" @click="handleApprove((row.original as unknown as DepositTransaction).id)">Approve</UButton>
            <UButton size="xs" color="error" variant="soft" icon="i-heroicons-x-mark" @click="openDeclineModal((row.original as unknown as DepositTransaction).id)">Decline</UButton>
          </div>
        </template>
      </UTable>
    </UCard>

    <!-- Receipt Modal -->
    <UModal v-model="isReceiptOpen">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-base font-semibold leading-6 text-gray-900 dark:text-white">Transfer Receipt</h3>
            <UButton color="neutral" variant="ghost" icon="i-heroicons-x-mark-20-solid" @click="isReceiptOpen = false" />
          </div>
        </template>
        <div class="p-4 flex justify-center bg-gray-100 rounded">
          <img :src="selectedReceipt" alt="Receipt" class="max-w-full max-h-[70vh] object-contain shadow-lg" />
        </div>
      </UCard>
    </UModal>

    <!-- Decline Modal -->
    <UModal v-model="showDeclineModal">
      <UCard>
        <template #header>
          <h3 class="text-base font-semibold">Decline Deposit</h3>
        </template>
        <div class="p-4 space-y-3">
          <p class="text-sm text-gray-600">Optionally provide a reason. The player will be notified.</p>
          <UInput v-model="declineNote" placeholder="Reason (optional)" />
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="showDeclineModal = false">Cancel</UButton>
            <UButton color="error" @click="handleDecline">Confirm Decline</UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </div>
</template>
