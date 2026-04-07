<script setup lang="ts">
interface WithdrawalTransaction {
  id: string
  amount: number
  status: string
  createdAt: string
  note?: string
  user: { username: string; phone: string; serial?: number }
}

const { getWithdrawals, approveTransaction, declineTransaction } = useAdminApi()
const toast = useToast()

const formatUserId = (serial?: number) => {
  if (!serial) return '---'
  return serial.toString().padStart(5, '0')
}

const columns = [
  { accessorKey: 'id', header: 'TX ID' },
  { accessorKey: 'user.serial', header: 'Player ID' },
  { accessorKey: 'user.username', header: 'Username' },
  { accessorKey: 'user.phone', header: 'TeleBirr' },
  { accessorKey: 'amount', header: 'Amount' },
  { accessorKey: 'note', header: 'Bank info' },
  { accessorKey: 'createdAt', header: 'Requested' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'actions', header: 'Actions' }
]

// ── Data ───────────────────────────────────────────────────────────────────
const withdrawals = ref<WithdrawalTransaction[]>([])
const loading = ref(false)
const page = ref(1)
const totalPages = ref(1)
const LIMIT = 20

// ── Modals ──────────────────────────────────────────────────────────────────
const showConfirmModal = ref(false)
const pendingAction = ref<{ id: string; type: 'approve' | 'reject' } | null>(null)
const declineNote = ref('')
const viewMode = ref<'table' | 'card'>('table')

// ── Filters ─────────────────────────────────────────────────────────────────
const filterSearch = ref('')
const filterUserSerial = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterMinAmount = ref('')
const filterMaxAmount = ref('')
const filterStatus = ref('PENDING_REVIEW')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const statusOptions = [
  { label: 'Pending Review', value: 'PENDING_REVIEW' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Rejected', value: 'REJECTED' },
  { label: 'All', value: '__ALL__' },
]

// ── Stats ───────────────────────────────────────────────────────────────────
const approvedSum = ref(0)
const pendingCount = computed(() =>
  withdrawals.value.filter(w => w.status === 'PENDING_REVIEW').length
)

// ── Fetch ───────────────────────────────────────────────────────────────────
const refreshWithdrawals = async () => {
  loading.value = true
  try {
    const result: any = await getWithdrawals({
      status: filterStatus.value === '__ALL__' ? undefined : filterStatus.value,
      search: filterSearch.value || undefined,
      userSerial: filterUserSerial.value ? Number(filterUserSerial.value) : undefined,
      from: filterFrom.value || undefined,
      to: filterTo.value || undefined,
      minAmount: filterMinAmount.value ? Number(filterMinAmount.value) : undefined,
      maxAmount: filterMaxAmount.value ? Number(filterMaxAmount.value) : undefined,
      page: page.value,
      limit: LIMIT,
    })
    withdrawals.value = result?.data ?? result ?? []
    totalPages.value = result?.pagination?.totalPages ?? 1
    approvedSum.value = 0
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch withdrawals', color: 'error' })
  } finally {
    loading.value = false
  }
}

const onSearch = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; refreshWithdrawals() }, 400)
}

const resetFilters = () => {
  filterSearch.value = ''
  filterUserSerial.value = ''
  filterFrom.value = ''
  filterTo.value = ''
  filterMinAmount.value = ''
  filterMaxAmount.value = ''
  filterStatus.value = 'PENDING_REVIEW'
  page.value = 1
  refreshWithdrawals()
}

watch([page, filterStatus], refreshWithdrawals)
onMounted(refreshWithdrawals)

// ── Actions ──────────────────────────────────────────────────────────────────
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

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}
</script>

<template>
  <div class="space-y-6 pb-20 md:pb-0">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-4">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Withdrawals</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Review and process player withdrawal requests</p>
      </div>
      <div class="flex items-center gap-2">
        <UButtonGroup size="sm">
          <UButton
            :variant="viewMode === 'table' ? 'solid' : 'ghost'"
            color="neutral"
            icon="i-heroicons:table-cells"
            @click="viewMode = 'table'"
          />
          <UButton
            :variant="viewMode === 'card' ? 'solid' : 'ghost'"
            color="neutral"
            icon="i-heroicons:squares-2x2"
            @click="viewMode = 'card'"
          />
        </UButtonGroup>
        <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" label="Refresh" @click="refreshWithdrawals" />
      </div>
    </div>

    <!-- Summary stats -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="group relative overflow-hidden rounded-3xl border border-white/5 p-6 bg-(--surface-raised) shadow-2xl transition-all hover:bg-white/5">
        <div class="absolute -right-4 -top-4 w-24 h-24 bg-yellow-500/10 rounded-full blur-2xl group-hover:bg-yellow-500/20 transition-colors" />
        <div class="relative z-10 flex items-center justify-between">
          <div>
            <div class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Awaiting Transfer</div>
            <div class="text-3xl font-black text-yellow-500 tracking-tighter">{{ pendingCount }}</div>
          </div>
          <UIcon name="i-heroicons:clock" class="w-10 h-10 text-yellow-500/30" />
        </div>
      </div>
      <div class="group relative overflow-hidden rounded-3xl border border-white/5 p-6 bg-(--surface-raised) shadow-2xl transition-all hover:bg-white/5">
        <div class="absolute -right-4 -top-4 w-24 h-24 bg-emerald-500/10 rounded-full blur-2xl group-hover:bg-emerald-500/20 transition-colors" />
        <div class="relative z-10 flex items-center justify-between">
          <div>
            <div class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Total Transferred</div>
            <div class="text-3xl font-black text-emerald-400 tracking-tighter">{{ approvedSum.toFixed(2) }} <span class="text-xs font-medium text-white/30">ETB</span></div>
          </div>
          <UIcon name="i-heroicons:banknotes" class="w-10 h-10 text-emerald-500/30" />
        </div>
      </div>
    </div>

    <!-- Filter Toolbar -->
    <div class="flex flex-wrap gap-3 bg-white/5 p-3 rounded-2xl border border-white/5 shadow-inner">
      <UInput
        v-model="filterSearch"
        icon="i-heroicons:magnifying-glass"
        placeholder="Search username or phone…"
        class="flex-1 min-w-48"
        @input="onSearch"
      />
      <UInput
        v-model="filterUserSerial"
        placeholder="User ID"
        class="w-28"
        @input="onSearch"
      />
      <UInput v-model="filterFrom" type="date" class="w-40" @change="page = 1; refreshWithdrawals()" />
      <UInput v-model="filterTo" type="date" class="w-40" @change="page = 1; refreshWithdrawals()" />
      <UInput
        v-model="filterMinAmount"
        type="number"
        placeholder="Min ETB"
        class="w-28"
        @input="onSearch"
      />
      <UInput
        v-model="filterMaxAmount"
        type="number"
        placeholder="Max ETB"
        class="w-28"
        @input="onSearch"
      />
      <USelect
        v-model="filterStatus"
        :items="statusOptions"
        value-key="value"
        class="w-44"
      />
      <UButton color="neutral" variant="ghost" icon="i-heroicons:x-mark" @click="resetFilters">Reset</UButton>
    </div>

    <div v-if="filterStatus === 'PENDING_REVIEW'" class="mt-2">
      <UAlert
        icon="i-heroicons:information-circle"
        color="warning"
        variant="soft"
        class="py-1.5"
        title="Manual Settlement"
        description="Send funds via TeleBirr to the phone shown, then click 'Mark Transferred'."
      />
    </div>

    <!-- Table View -->
    <div v-if="viewMode === 'table'" class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
      <UTable :columns="columns" :data="withdrawals" :loading="loading">
        <template #id-cell="{ row }">
          <div class="flex items-center gap-1 group">
            <span class="font-mono text-[10px] text-zinc-500 truncate w-16">{{ (row.original as unknown as WithdrawalTransaction).id.split('-')[0] }}</span>
            <UButton icon="i-heroicons:clipboard-document" variant="ghost" color="neutral" size="xs" class="opacity-0 group-hover:opacity-100 transition-opacity p-0.5" @click="copyToClipboard((row.original as unknown as WithdrawalTransaction).id)" />
          </div>
        </template>
        <template #user.serial-cell="{ row }">
          <span class="font-mono text-xs font-bold text-primary tracking-tighter">
            {{ formatUserId((row.original as unknown as WithdrawalTransaction).user.serial) }}
          </span>
        </template>
        <template #user.username-cell="{ row }">
          <span class="font-semibold text-zinc-200">{{ (row.original as unknown as WithdrawalTransaction).user.username }}</span>
        </template>
        <template #user.phone-cell="{ row }">
          <div class="flex items-center gap-1.5 px-1 py-0.5 rounded-lg hover:bg-white/5 transition-colors group">
            <span class="font-mono text-sm font-bold text-cyan-400">{{ (row.original as unknown as WithdrawalTransaction).user.phone }}</span>
            <UButton
              icon="i-heroicons:clipboard-document"
              variant="ghost" color="primary" size="xs"
              class="opacity-50 hover:opacity-100 transition-opacity p-1"
              @click="copyToClipboard((row.original as unknown as WithdrawalTransaction).user.phone)"
            />
          </div>
        </template>
        <template #amount-cell="{ row }">
          <strong class="text-lg text-yellow-500 font-bold px-1 rounded-md">{{ Number((row.original as unknown as WithdrawalTransaction).amount).toFixed(2) }} ETB</strong>
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
            <UButton size="xs" color="success" variant="soft" icon="i-heroicons:check"
              @click="confirmAction((row.original as unknown as WithdrawalTransaction).id, 'approve')"
            >Mark Transferred</UButton>
            <UButton size="xs" color="error" variant="soft" icon="i-heroicons:x-mark"
              @click="confirmAction((row.original as unknown as WithdrawalTransaction).id, 'reject')"
            >Reject</UButton>
          </div>
          <span v-else class="text-zinc-600 text-xs">Processed</span>
        </template>
      </UTable>
    </div>

    <!-- Card View -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      <div v-if="loading" class="col-span-full flex justify-center py-12">
        <UIcon name="i-heroicons:arrow-path" class="w-8 h-8 animate-spin text-white/20" />
      </div>
      <div v-else-if="!withdrawals.length" class="col-span-full text-center py-12 text-white/30 bg-white/5 rounded-3xl border border-white/5">
        <UIcon name="i-heroicons:banknotes" class="w-12 h-12 mx-auto mb-3 opacity-20" />
        <p class="text-lg font-medium">No withdrawals found</p>
      </div>
      <div
        v-for="w in withdrawals" :key="w.id"
        class="relative p-5 rounded-3xl border border-white/5 bg-(--surface-raised) shadow-lg"
      >
        <div class="flex justify-between items-start mb-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold text-primary font-mono bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">
                #{{ formatUserId(w.user.serial) }}
              </span>
              <h3 class="font-bold text-zinc-100">{{ w.user.username }}</h3>
            </div>
            <p class="text-[10px] text-white/30 font-mono mt-1">{{ w.id.split('-')[0] }}</p>
          </div>
          <UBadge
            :color="w.status === 'PENDING_REVIEW' ? 'warning' : w.status === 'APPROVED' ? 'success' : 'error'"
            variant="soft" size="xs"
          >
            {{ w.status }}
          </UBadge>
        </div>

        <div class="space-y-2 mb-4">
          <div class="flex justify-between items-center text-xs">
            <span class="text-white/30">TeleBirr</span>
            <div class="flex items-center gap-1 group">
              <span class="font-bold text-cyan-400 font-mono">{{ w.user.phone }}</span>
              <UButton icon="i-heroicons:clipboard-document" variant="ghost" color="primary" size="xs" class="p-0.5" @click="copyToClipboard(w.user.phone)" />
            </div>
          </div>
          <div class="flex justify-between items-center">
            <span class="text-xs text-white/30">Amount</span>
            <span class="text-lg font-black text-yellow-500">{{ Number(w.amount).toFixed(2) }} <span class="text-[10px] font-normal opacity-50">ETB</span></span>
          </div>
          <div v-if="w.note" class="text-[10px] text-white/40 italic bg-white/5 p-1.5 rounded-lg border border-white/5">
            {{ w.note }}
          </div>
        </div>

        <div class="pt-3 border-t border-white/5 flex flex-col gap-2">
          <div class="text-[10px] text-white/20 font-medium">Requested {{ new Date(w.createdAt).toLocaleString() }}</div>
          <div v-if="w.status === 'PENDING_REVIEW'" class="flex gap-2">
            <UButton size="xs" color="success" block icon="i-heroicons:check" @click="confirmAction(w.id, 'approve')">Approve</UButton>
            <UButton size="xs" color="error" variant="ghost" icon="i-heroicons:x-mark" @click="confirmAction(w.id, 'reject')" />
          </div>
        </div>
      </div>
    </div>
    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex items-center justify-between px-1 mt-3">
      <p class="text-sm text-white/40">Page {{ page }} of {{ totalPages }}</p>
      <div class="flex gap-2">
        <UButton size="xs" color="neutral" variant="soft" :disabled="page <= 1" @click="page--">Prev</UButton>
        <UButton size="xs" color="neutral" variant="soft" :disabled="page >= totalPages" @click="page++">Next</UButton>
      </div>
    </div>

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
