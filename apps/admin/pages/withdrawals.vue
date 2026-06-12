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
const viewMode = ref<'table' | 'card'>('card')
const filtersOpen = ref(false)

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

const statusLabel = (v: string) => statusOptions.find(o => o.value === v)?.label ?? v

const activeChips = computed(() => {
  const chips: { label: string; clear: () => void }[] = []
  if (filterStatus.value && filterStatus.value !== '__ALL__')
    chips.push({ label: `Status: ${statusLabel(filterStatus.value)}`, clear: () => { filterStatus.value = '__ALL__'; page.value = 1; refreshWithdrawals() } })
  if (filterSearch.value)
    chips.push({ label: `Search: ${filterSearch.value}`, clear: () => { filterSearch.value = ''; page.value = 1; refreshWithdrawals() } })
  if (filterUserSerial.value)
    chips.push({ label: `User ID: ${filterUserSerial.value}`, clear: () => { filterUserSerial.value = ''; page.value = 1; refreshWithdrawals() } })
  if (filterFrom.value)
    chips.push({ label: `From: ${filterFrom.value}`, clear: () => { filterFrom.value = ''; page.value = 1; refreshWithdrawals() } })
  if (filterTo.value)
    chips.push({ label: `To: ${filterTo.value}`, clear: () => { filterTo.value = ''; page.value = 1; refreshWithdrawals() } })
  if (filterMinAmount.value)
    chips.push({ label: `Min: ${filterMinAmount.value} ETB`, clear: () => { filterMinAmount.value = ''; page.value = 1; refreshWithdrawals() } })
  if (filterMaxAmount.value)
    chips.push({ label: `Max: ${filterMaxAmount.value} ETB`, clear: () => { filterMaxAmount.value = ''; page.value = 1; refreshWithdrawals() } })
  return chips
})

function exportCSV() {
  const rows = withdrawals.value
  if (!rows.length) return
  const headers = ['ID', 'User', 'Amount', 'Status', 'Date']
  const lines = rows.map((w: any) => [w.id, w.user?.username ?? '', w.amount, w.status, w.createdAt].join(','))
  const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'withdrawals.csv'; a.click()
  URL.revokeObjectURL(url)
}

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
    <!-- Header + controls -->
    <div class="flex items-center gap-3 flex-wrap">
      <h1 class="text-2xl font-bold text-white tracking-tight flex-1">Withdrawals</h1>
      <div class="flex items-center gap-2 shrink-0">
        <UButtonGroup size="sm">
          <UButton :variant="viewMode === 'table' ? 'solid' : 'ghost'" color="neutral" icon="i-heroicons:table-cells" @click="viewMode = 'table'" />
          <UButton :variant="viewMode === 'card' ? 'solid' : 'ghost'" color="neutral" icon="i-heroicons:squares-2x2" @click="viewMode = 'card'" />
        </UButtonGroup>
        <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" size="sm" @click="refreshWithdrawals" />
      </div>
    </div>

    <!-- Filter bar -->
    <div class="space-y-2">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[11px] font-semibold text-white/35 uppercase tracking-widest shrink-0">Active Filters:</span>
        <div class="flex items-center gap-1.5 flex-wrap flex-1 min-w-0">
          <span
            v-for="chip in activeChips"
            :key="chip.label"
            class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-[11px] font-medium text-amber-300 whitespace-nowrap"
          >
            {{ chip.label }}
            <button class="opacity-60 hover:opacity-100 transition-opacity" @click="chip.clear">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </span>
          <span v-if="!activeChips.length" class="text-[11px] text-white/20">None</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button class="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11px] font-medium text-white/50 hover:text-white border border-white/10 hover:border-white/20 bg-white/5 hover:bg-white/8 transition-all" @click="exportCSV">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export
          </button>
          <button
            class="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11px] font-semibold transition-all"
            :class="filtersOpen
              ? 'bg-amber-500 text-black border border-amber-500'
              : 'text-white/70 hover:text-white border border-white/15 hover:border-amber-500/50 bg-white/5 hover:bg-amber-500/10'"
            @click="filtersOpen = !filtersOpen"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
            Filter
          </button>
        </div>
      </div>

      <!-- Collapsible filter panel -->
      <div v-show="filtersOpen" class="flex flex-wrap gap-2.5 bg-white/4 p-3 rounded-xl border border-white/8">
        <UInput v-model="filterSearch" icon="i-heroicons:magnifying-glass" placeholder="Search username or phone…" size="sm" class="flex-1 min-w-44" @input="onSearch" />
        <UInput v-model="filterUserSerial" placeholder="User ID" size="sm" class="w-24" @input="onSearch" />
        <UInput v-model="filterFrom" type="date" size="sm" class="w-36" @change="page = 1; refreshWithdrawals()" />
        <UInput v-model="filterTo" type="date" size="sm" class="w-36" @change="page = 1; refreshWithdrawals()" />
        <UInput v-model="filterMinAmount" type="number" placeholder="Min ETB" size="sm" class="w-24" @input="onSearch" />
        <UInput v-model="filterMaxAmount" type="number" placeholder="Max ETB" size="sm" class="w-24" @input="onSearch" />
        <USelect v-model="filterStatus" :items="statusOptions" value-key="value" size="sm" class="w-36" />
        <UButton color="neutral" variant="ghost" size="sm" icon="i-heroicons:x-mark" @click="resetFilters">Reset</UButton>
      </div>
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
            :color="(row.original as unknown as WithdrawalTransaction).status === 'APPROVED' ? 'success' : (row.original as unknown as WithdrawalTransaction).status === 'REJECTED' ? 'error' : 'neutral'"
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
            :color="w.status === 'APPROVED' ? 'success' : w.status === 'REJECTED' ? 'error' : 'neutral'"
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
