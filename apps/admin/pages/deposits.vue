<script setup lang="ts">
interface DepositTransaction {
  id: string
  amount: number
  status: string
  createdAt: string
  receiptUrl: string | null
  note?: string
  paymentTransactionId?: string | null
  senderName?: string | null
  senderAccount?: string | null
  user: { username: string; phone: string }
}

const { getPendingDeposits, approveTransaction, declineTransaction } = useAdminApi()
const toast = useToast()

const DECLINE_REASONS = [
  'Transaction ID mismatch',
  'Invalid receipt',
  'Unrelated image',
  'Corrupted file',
  'Sender name mismatch',
  'Amount mismatch',
]

const columns = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'user.username', header: 'User' },
  { accessorKey: 'user.phone', header: 'Phone' },
  { accessorKey: 'amount', header: 'Amount (ETB)' },
  { accessorKey: 'paymentTransactionId', header: 'Txn ID' },
  { accessorKey: 'senderName', header: 'Sender Name' },
  { accessorKey: 'senderAccount', header: 'TeleBirr No.' },
  { accessorKey: 'createdAt', header: 'Submitted' },
  { accessorKey: 'receipt', header: 'Receipt' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'actions', header: 'Actions' }
]

const pendingDeposits = ref<DepositTransaction[]>([])
const loading = ref(false)
const declineNote = ref('')
const customReason = ref('')
const showDeclineModal = ref(false)
const selectedDeclineId = ref<string | null>(null)

// Stats
const approvedSum = ref(0)
const declinedSum = ref(0)
const pendingCount = computed(() => pendingDeposits.value.length)

const refreshDeposits = async () => {
  loading.value = true
  try {
    const [deposits, stats] = await Promise.all([
      getPendingDeposits(),
      useAdminApi().getStats(),
    ])
    pendingDeposits.value = deposits
    approvedSum.value = stats.approvedDepositSum ?? 0
    declinedSum.value = stats.declinedDepositSum ?? 0
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
  customReason.value = ''
  showDeclineModal.value = true
}

const handleDecline = async () => {
  if (!selectedDeclineId.value) return
  const reason = customReason.value.trim() || declineNote.value
  try {
    await declineTransaction(selectedDeclineId.value, reason || undefined)
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

// Age helper — returns minutes elapsed since createdAt
const ageMinutes = (createdAt: string) => {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000)
}

onMounted(refreshDeposits)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold text-gray-900">Pending Deposits</h1>
      <UButton icon="i-heroicons-arrow-path" variant="ghost" @click="refreshDeposits">Refresh</UButton>
    </div>

    <!-- Summary stats -->
    <div class="grid grid-cols-3 gap-4">
      <UCard class="text-center">
        <div class="text-2xl font-bold text-yellow-500">{{ pendingCount }}</div>
        <div class="text-xs text-gray-500 mt-1">Pending</div>
      </UCard>
      <UCard class="text-center">
        <div class="text-2xl font-bold text-green-600">{{ approvedSum.toFixed(2) }} ETB</div>
        <div class="text-xs text-gray-500 mt-1">Approved (all time)</div>
      </UCard>
      <UCard class="text-center">
        <div class="text-2xl font-bold text-red-500">{{ declinedSum.toFixed(2) }} ETB</div>
        <div class="text-xs text-gray-500 mt-1">Declined (all time)</div>
      </UCard>
    </div>

    <UCard>
      <UTable :columns="columns" :rows="pendingDeposits" :loading="loading">
        <template #id-cell="{ row }">
          <span class="font-mono text-xs">{{ (row.original as unknown as DepositTransaction).id.slice(0, 8) }}…</span>
        </template>
        <template #paymentTransactionId-cell="{ row }">
          <span class="font-mono text-xs font-semibold">
            {{ (row.original as unknown as DepositTransaction).paymentTransactionId ?? '—' }}
          </span>
        </template>
        <template #senderName-cell="{ row }">
          {{ (row.original as unknown as DepositTransaction).senderName ?? '—' }}
        </template>
        <template #senderAccount-cell="{ row }">
          <span class="font-mono text-xs">{{ (row.original as unknown as DepositTransaction).senderAccount ?? '—' }}</span>
        </template>
        <template #amount-cell="{ row }">
          <strong>{{ Number((row.original as unknown as DepositTransaction).amount).toFixed(2) }}</strong>
        </template>
        <template #createdAt-cell="{ row }">
          <div class="flex flex-col gap-0.5">
            <span>{{ new Date((row.original as unknown as DepositTransaction).createdAt).toLocaleString() }}</span>
            <UBadge
              v-if="ageMinutes((row.original as unknown as DepositTransaction).createdAt) > 15"
              color="error"
              variant="soft"
              size="xs"
            >⚠ Late submission ({{ ageMinutes((row.original as unknown as DepositTransaction).createdAt) }}m)</UBadge>
          </div>
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
          <p class="text-sm text-gray-600">Select a reason or type a custom one. The player will be notified.</p>
          <div class="grid grid-cols-2 gap-2">
            <UButton
              v-for="reason in DECLINE_REASONS"
              :key="reason"
              size="xs"
              :color="declineNote === reason ? 'error' : 'neutral'"
              :variant="declineNote === reason ? 'soft' : 'ghost'"
              @click="declineNote = reason; customReason = ''"
            >
              {{ reason }}
            </UButton>
          </div>
          <UInput v-model="customReason" placeholder="Custom reason (optional)" @input="declineNote = ''" />
          <p v-if="declineNote || customReason" class="text-xs text-gray-500">
            Reason: <strong>{{ customReason || declineNote }}</strong>
          </p>
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
