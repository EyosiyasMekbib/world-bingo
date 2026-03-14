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

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}

onMounted(refreshDeposits)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-bold text-white">Pending Deposits</h1>
      <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" @click="refreshDeposits">Refresh</UButton>
    </div>

    <!-- Summary stats -->
    <div class="grid grid-cols-3 gap-4">
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-yellow-500">{{ pendingCount }}</div>
        <div class="text-xs text-white/50 mt-1 uppercase tracking-wide">Pending</div>
      </div>
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-emerald-400">{{ approvedSum.toFixed(2) }} ETB</div>
        <div class="text-xs text-white/50 mt-1 uppercase tracking-wide">Approved</div>
      </div>
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-red-500">{{ declinedSum.toFixed(2) }} ETB</div>
        <div class="text-xs text-white/50 mt-1 uppercase tracking-wide">Declined</div>
      </div>
    </div>

    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <UTable :columns="columns" :data="pendingDeposits" :loading="loading">
        <template #id-cell="{ row }">
          <div class="flex items-center gap-1 group">
            <span class="font-mono text-xs text-white/40">{{ (row.original as unknown as DepositTransaction).id.slice(0, 8) }}…</span>
            <UButton
              icon="i-heroicons:clipboard-document text-[10px]"
              variant="ghost" color="neutral" size="xs"
              class="opacity-0 group-hover:opacity-100 p-0.5"
              @click="copyToClipboard((row.original as unknown as DepositTransaction).id)"
            />
          </div>
        </template>
        <template #paymentTransactionId-cell="{ row }">
          <div class="flex items-center gap-1.5 group">
            <span class="font-mono text-xs font-semibold text-zinc-200">
              {{ (row.original as unknown as DepositTransaction).paymentTransactionId ?? '—' }}
            </span>
            <UButton
              v-if="(row.original as unknown as DepositTransaction).paymentTransactionId"
              icon="i-heroicons:clipboard-document text-xs"
              variant="ghost" color="primary" size="xs"
              class="opacity-0 group-hover:opacity-100 p-1"
              @click="copyToClipboard((row.original as unknown as DepositTransaction).paymentTransactionId!)"
            />
          </div>
        </template>
        <template #senderName-cell="{ row }">
          <span class="text-zinc-300">{{ (row.original as unknown as DepositTransaction).senderName ?? '—' }}</span>
        </template>
        <template #senderAccount-cell="{ row }">
          <span class="font-mono text-xs text-zinc-300">{{ (row.original as unknown as DepositTransaction).senderAccount ?? '—' }}</span>
        </template>
        <template #amount-cell="{ row }">
          <strong class="text-yellow-500 font-bold">{{ Number((row.original as unknown as DepositTransaction).amount).toFixed(2) }}</strong>
        </template>
        <template #createdAt-cell="{ row }">
          <div class="flex flex-col gap-0.5">
            <span class="text-zinc-300 text-xs">{{ new Date((row.original as unknown as DepositTransaction).createdAt).toLocaleString() }}</span>
            <UBadge
              v-if="ageMinutes((row.original as unknown as DepositTransaction).createdAt) > 15"
              color="error" variant="soft" size="xs"
            >⚠ Late ({{ ageMinutes((row.original as unknown as DepositTransaction).createdAt) }}m)</UBadge>
          </div>
        </template>
        <template #receipt-cell="{ row }">
          <UButton
            v-if="(row.original as unknown as DepositTransaction).receiptUrl"
            size="xs" color="neutral" variant="ghost" icon="i-heroicons:photo"
            @click="openReceipt((row.original as unknown as DepositTransaction).receiptUrl!)"
          >View</UButton>
          <span v-else class="text-zinc-600 text-xs">No receipt</span>
        </template>
        <template #status-cell="{ row }">
          <UBadge color="warning" variant="soft">{{ (row.original as unknown as DepositTransaction).status }}</UBadge>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-2">
            <UButton size="xs" color="success" variant="soft" icon="i-heroicons:check" @click="handleApprove((row.original as unknown as DepositTransaction).id)">Approve</UButton>
            <UButton size="xs" color="error" variant="soft" icon="i-heroicons:x-mark" @click="openDeclineModal((row.original as unknown as DepositTransaction).id)">Decline</UButton>
          </div>
        </template>
      </UTable>
    </div>

    <!-- Receipt Modal -->
    <UModal v-model:open="isReceiptOpen" title="Transfer Receipt" :ui="{ content: 'max-w-2xl' }">
      <template #body>
        <div class="flex justify-center rounded-xl p-2" style="background:var(--surface-overlay);">
          <img :src="selectedReceipt" alt="Receipt" class="max-w-full max-h-[70vh] object-contain shadow-2xl rounded-lg" />
        </div>
      </template>
    </UModal>

    <!-- Decline Modal -->
    <UModal v-model:open="showDeclineModal" title="Decline Deposit" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-zinc-400">Select a reason or type a custom one. The player will be notified.</p>
          <div class="grid grid-cols-2 gap-2">
            <UButton
              v-for="reason in DECLINE_REASONS"
              :key="reason"
              size="xs"
              :color="declineNote === reason ? 'error' : 'neutral'"
              :variant="declineNote === reason ? 'soft' : 'ghost'"
              @click="declineNote = reason; customReason = ''"
            >{{ reason }}</UButton>
          </div>
          <UInput v-model="customReason" placeholder="Custom reason (optional)" @input="declineNote = ''" />
          <p v-if="declineNote || customReason" class="text-xs text-zinc-500">
            Reason: <strong class="text-zinc-200">{{ customReason || declineNote }}</strong>
          </p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showDeclineModal = false">Cancel</UButton>
        <UButton color="error" @click="handleDecline">Confirm Decline</UButton>
      </template>
    </UModal>
  </div>
</template>
