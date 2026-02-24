<script setup lang="ts">
interface WithdrawalTransaction {
  id: string
  amount: number
  status: string
  createdAt: string
  note?: string
  user: { username: string; phone: string }
}

const { getWithdrawals, approveTransaction, declineTransaction } = useAdminApi()
const toast = useToast()

const columns = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'user.username', header: 'Username' },
  { accessorKey: 'user.phone', header: 'TeleBirr Number' },
  { accessorKey: 'amount', header: 'Amount (ETB)' },
  { accessorKey: 'note', header: 'Bank/Account' },
  { accessorKey: 'createdAt', header: 'Requested' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'actions', header: 'Actions' }
]

const withdrawals = ref<WithdrawalTransaction[]>([])
const loading = ref(false)
const showConfirmModal = ref(false)
const pendingAction = ref<{ id: string; type: 'approve' | 'reject' } | null>(null)
const declineNote = ref('')

// Stats
const approvedSum = ref(0)
const pendingCount = computed(() =>
  withdrawals.value.filter(w => w.status === 'PENDING_REVIEW').length
)

const refreshWithdrawals = async () => {
  loading.value = true
  try {
    const [list, stats] = await Promise.all([
      getWithdrawals(),
      useAdminApi().getStats(),
    ])
    withdrawals.value = list
    approvedSum.value = stats.approvedWithdrawalSum ?? 0
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch withdrawals', color: 'error' })
  } finally {
    loading.value = false
  }
}

const confirmAction = (id: string, type: 'approve' | 'reject') => {
  pendingAction.value = { id, type }
  declineNote.value = ''
  showConfirmModal.value = true
}

const executeAction = async () => {
  if (!pendingAction.value) return
  const { id, type } = pendingAction.value

  try {
    if (type === 'approve') {
      await approveTransaction(id)
      toast.add({ title: 'Marked as Transferred ✅', description: 'Player has been notified', color: 'success' })
    } else {
      await declineTransaction(id, declineNote.value || undefined)
      toast.add({ title: 'Rejected', description: 'Balance refunded to player wallet', color: 'warning' })
    }
    showConfirmModal.value = false
    refreshWithdrawals()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Action failed', color: 'error' })
  }
}

onMounted(refreshWithdrawals)
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">Withdrawals Management</h1>
        <p class="text-sm text-zinc-500 mt-0.5">Review and process player withdrawal requests</p>
      </div>
      <UButton icon="i-heroicons-arrow-path" color="neutral" variant="ghost" @click="refreshWithdrawals">Refresh</UButton>
    </div>

    <!-- Summary stats -->
    <div class="grid grid-cols-2 gap-4">
      <div class="rounded-2xl border border-white/8 p-5 text-center" style="background:#111827;">
        <div class="text-2xl font-bold text-amber-400">{{ pendingCount }}</div>
        <div class="text-xs text-zinc-500 mt-1 uppercase tracking-wide">Awaiting Transfer</div>
      </div>
      <div class="rounded-2xl border border-white/8 p-5 text-center" style="background:#111827;">
        <div class="text-2xl font-bold text-emerald-400">{{ approvedSum.toFixed(2) }} ETB</div>
        <div class="text-xs text-zinc-500 mt-1 uppercase tracking-wide">Total Transferred (all time)</div>
      </div>
    </div>

    <UAlert
      icon="i-heroicons-information-circle"
      color="warning"
      variant="soft"
      title="Manual Settlement"
      description="Send funds via TeleBirr to the player's phone number shown below, then click 'Mark Transferred'. Rejecting a request refunds the balance back to the player."
    />

    <div class="rounded-2xl border border-white/8 overflow-hidden" style="background:#111827;">
      <UTable :columns="columns" :data="withdrawals" :loading="loading">
        <template #id-cell="{ row }">
          <span class="font-mono text-xs text-zinc-400">{{ (row.original as unknown as WithdrawalTransaction).id.slice(0, 8) }}…</span>
        </template>
        <template #user.username-cell="{ row }">
          <span class="font-semibold text-zinc-200">{{ (row.original as unknown as WithdrawalTransaction).user.username }}</span>
        </template>
        <template #user.phone-cell="{ row }">
          <span class="font-mono text-sm font-bold text-cyan-400">{{ (row.original as unknown as WithdrawalTransaction).user.phone }}</span>
        </template>
        <template #amount-cell="{ row }">
          <strong class="text-lg text-amber-400">{{ Number((row.original as unknown as WithdrawalTransaction).amount).toFixed(2) }} ETB</strong>
        </template>
        <template #createdAt-cell="{ row }">
          <span class="text-zinc-400 text-xs">{{ new Date((row.original as unknown as WithdrawalTransaction).createdAt).toLocaleString() }}</span>
        </template>
        <template #status-cell="{ row }">
          <UBadge
            :color="(row.original as unknown as WithdrawalTransaction).status === 'PENDING_REVIEW' ? 'warning' : (row.original as unknown as WithdrawalTransaction).status === 'APPROVED' ? 'success' : 'error'"
            variant="soft"
          >
            {{ (row.original as unknown as WithdrawalTransaction).status }}
          </UBadge>
        </template>
        <template #actions-cell="{ row }">
          <div
            v-if="(row.original as unknown as WithdrawalTransaction).status === 'PENDING_REVIEW'"
            class="flex items-center gap-2"
          >
            <UButton size="xs" color="success" variant="soft" icon="i-heroicons-check"
              @click="confirmAction((row.original as unknown as WithdrawalTransaction).id, 'approve')"
            >Mark Transferred</UButton>
            <UButton size="xs" color="error" variant="soft" icon="i-heroicons-x-mark"
              @click="confirmAction((row.original as unknown as WithdrawalTransaction).id, 'reject')"
            >Reject</UButton>
          </div>
          <span v-else class="text-zinc-600 text-xs">Processed</span>
        </template>
      </UTable>
    </div>

    <!-- Confirm Modal -->
    <UModal v-model:open="showConfirmModal" :title="pendingAction?.type === 'approve' ? 'Confirm Transfer' : 'Reject Withdrawal'" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-3">
          <p v-if="pendingAction?.type === 'approve'" class="text-sm text-zinc-400">
            Confirm that you have physically transferred the funds to the player's TeleBirr account.
          </p>
          <template v-else>
            <p class="text-sm text-zinc-400">The withdrawal will be rejected and the balance returned to the player's wallet.</p>
            <UInput v-model="declineNote" placeholder="Reason for rejection (optional)" />
          </template>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="showConfirmModal = false">Cancel</UButton>
        <UButton :color="pendingAction?.type === 'approve' ? 'success' : 'error'" @click="executeAction">
          {{ pendingAction?.type === 'approve' ? 'Confirm' : 'Reject & Refund' }}
        </UButton>
      </template>
    </UModal>
  </div>
</template>
