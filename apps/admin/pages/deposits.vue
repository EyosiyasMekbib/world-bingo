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
  user: { username: string; phone: string; serial?: number }
}

const { getPendingDeposits, approveTransaction, declineTransaction } = useAdminApi()
const toast = useToast()

const formatUserId = (serial?: number) => {
  if (!serial) return '---'
  return serial.toString().padStart(5, '0')
}

const DECLINE_REASONS = [
  'Transaction ID mismatch',
  'Invalid receipt',
  'Unrelated image',
  'Corrupted file',
  'Sender name mismatch',
  'Amount mismatch',
]

const columns = [
  { accessorKey: 'id', header: 'TX ID' },
  { accessorKey: 'user.serial', header: 'Player ID' },
  { accessorKey: 'user.username', header: 'User' },
  { accessorKey: 'user.phone', header: 'Phone' },
  { accessorKey: 'amount', header: 'Amount' },
  { accessorKey: 'paymentTransactionId', header: 'Ref ID' },
  { accessorKey: 'senderName', header: 'Sender' },
  { accessorKey: 'createdAt', header: 'Time' },
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
const showApproveModal = ref(false)
const selectedApproveId = ref<string | null>(null)
const approveLoading = ref(false)
const viewMode = ref<'table' | 'card'>('card')
const filtersOpen = ref(false)

// ── Filter state ─────────────────────────────────────────────────────────────
const filterSearch = ref('')
const filterUserSerial = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterMinAmount = ref('')
const filterMaxAmount = ref('')
const filterStatus = ref('PENDING_REVIEW')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const page = ref(1)
const totalPages = ref(1)
const LIMIT = 20

const statusOptions = [
  { label: 'All', value: '__ALL__' },
  { label: 'Pending Review', value: 'PENDING_REVIEW' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Declined', value: 'REJECTED' },
]

const statusLabel = (v: string) => statusOptions.find(o => o.value === v)?.label ?? v

const activeChips = computed(() => {
  const chips: { label: string; clear: () => void }[] = []
  if (filterStatus.value && filterStatus.value !== '__ALL__')
    chips.push({ label: `Status: ${statusLabel(filterStatus.value)}`, clear: () => { filterStatus.value = '__ALL__'; page.value = 1; fetchDeposits() } })
  if (filterSearch.value)
    chips.push({ label: `Search: ${filterSearch.value}`, clear: () => { filterSearch.value = ''; page.value = 1; fetchDeposits() } })
  if (filterUserSerial.value)
    chips.push({ label: `User ID: ${filterUserSerial.value}`, clear: () => { filterUserSerial.value = ''; page.value = 1; fetchDeposits() } })
  if (filterFrom.value)
    chips.push({ label: `From: ${filterFrom.value}`, clear: () => { filterFrom.value = ''; page.value = 1; fetchDeposits() } })
  if (filterTo.value)
    chips.push({ label: `To: ${filterTo.value}`, clear: () => { filterTo.value = ''; page.value = 1; fetchDeposits() } })
  if (filterMinAmount.value)
    chips.push({ label: `Min: ${filterMinAmount.value} ETB`, clear: () => { filterMinAmount.value = ''; page.value = 1; fetchDeposits() } })
  if (filterMaxAmount.value)
    chips.push({ label: `Max: ${filterMaxAmount.value} ETB`, clear: () => { filterMaxAmount.value = ''; page.value = 1; fetchDeposits() } })
  return chips
})

function exportCSV() {
  const rows = pendingDeposits.value
  if (!rows.length) return
  const headers = ['ID', 'User', 'Amount', 'Status', 'Date']
  const lines = rows.map((d: any) => [d.id, d.user?.username ?? '', d.amount, d.status, d.createdAt].join(','))
  const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = 'deposits.csv'; a.click()
  URL.revokeObjectURL(url)
}

// ── Stats ────────────────────────────────────────────────────────────────────
const approvedSum = ref(0)
const declinedSum = ref(0)
const pendingCount = computed(() => pendingDeposits.value.filter(d => d.status === 'PENDING_REVIEW').length)

// ── Fetch ────────────────────────────────────────────────────────────────────
const fetchDeposits = async () => {
  loading.value = true
  try {
    const result: any = await getPendingDeposits({
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
    pendingDeposits.value = result?.data ?? result ?? []
    totalPages.value = result?.pagination?.totalPages ?? 1
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch deposits', color: 'error' })
  } finally {
    loading.value = false
  }
}

const onSearch = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; fetchDeposits() }, 400)
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
  fetchDeposits()
}

watch([page, filterStatus], fetchDeposits)
onMounted(fetchDeposits)

// ── Actions ───────────────────────────────────────────────────────────────────
const openApproveModal = (id: string) => {
  selectedApproveId.value = id
  showApproveModal.value = true
}

const confirmApprove = async () => {
  if (!selectedApproveId.value) return
  approveLoading.value = true
  try {
    await approveTransaction(selectedApproveId.value)
    toast.add({ title: 'Approved ✅', description: 'Deposit credited to player wallet', color: 'success' })
    showApproveModal.value = false
    fetchDeposits()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Failed to approve', color: 'error' })
  } finally {
    approveLoading.value = false
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
    fetchDeposits()
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

const ageMinutes = (createdAt: string) => {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000)
}

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}
</script>

<template>
  <div class="space-y-6 pb-20 md:pb-0">
    <!-- Header + Filter bar combined -->
    <div class="flex items-center gap-3 flex-wrap">
      <h1 class="text-2xl font-bold text-white tracking-tight flex-1">Deposits Confirmation</h1>
      <div class="flex items-center gap-2 shrink-0">
        <UButtonGroup size="sm">
          <UButton :variant="viewMode === 'table' ? 'solid' : 'ghost'" color="neutral" icon="i-heroicons:table-cells" @click="viewMode = 'table'" />
          <UButton :variant="viewMode === 'card' ? 'solid' : 'ghost'" color="neutral" icon="i-heroicons:squares-2x2" @click="viewMode = 'card'" />
        </UButtonGroup>
        <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" size="sm" @click="fetchDeposits" />
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
        <UInput v-model="filterFrom" type="date" size="sm" class="w-36" @change="page = 1; fetchDeposits()" />
        <UInput v-model="filterTo" type="date" size="sm" class="w-36" @change="page = 1; fetchDeposits()" />
        <UInput v-model="filterMinAmount" type="number" placeholder="Min ETB" size="sm" class="w-24" @input="onSearch" />
        <UInput v-model="filterMaxAmount" type="number" placeholder="Max ETB" size="sm" class="w-24" @input="onSearch" />
        <USelect v-model="filterStatus" :items="statusOptions" value-key="value" size="sm" class="w-36" @change="page = 1; fetchDeposits()" />
        <UButton color="neutral" variant="ghost" size="sm" icon="i-heroicons:x-mark" @click="resetFilters">Reset</UButton>
      </div>
    </div>

    <!-- Table View -->
    <div v-if="viewMode === 'table'" class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl bg-(--surface-raised)">
      <UTable :columns="columns" :data="pendingDeposits" :loading="loading">
        <template #id-cell="{ row }">
          <div class="flex items-center gap-1 group">
            <span class="font-mono text-[10px] text-white/30 truncate w-16">{{ (row.original as unknown as DepositTransaction).id.split('-')[0] }}</span>
            <UButton
              icon="i-heroicons:clipboard-document"
              variant="ghost" color="neutral" size="xs"
              class="opacity-0 group-hover:opacity-100 transition-opacity p-0.5"
              @click="copyToClipboard((row.original as unknown as DepositTransaction).id)"
            />
          </div>
        </template>
        <template #user.serial-cell="{ row }">
          <span class="font-mono text-xs font-bold text-primary tracking-tighter">
            {{ formatUserId((row.original as unknown as DepositTransaction).user.serial) }}
          </span>
        </template>
        <template #paymentTransactionId-cell="{ row }">
          <div class="flex items-center gap-1.5 px-1 py-0.5 rounded-lg hover:bg-white/5 transition-colors group">
            <span class="font-mono text-xs font-semibold text-zinc-200">
              {{ (row.original as unknown as DepositTransaction).paymentTransactionId ?? '—' }}
            </span>
            <UButton
              v-if="(row.original as unknown as DepositTransaction).paymentTransactionId"
              icon="i-heroicons:clipboard-document"
              variant="ghost" color="primary" size="xs"
              class="opacity-50 hover:opacity-100 transition-opacity p-1"
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
            <UButton size="xs" color="success" variant="soft" icon="i-heroicons:check" @click="openApproveModal((row.original as unknown as DepositTransaction).id)">Approve</UButton>
            <UButton size="xs" color="error" variant="soft" icon="i-heroicons:x-mark" @click="openDeclineModal((row.original as unknown as DepositTransaction).id)">Decline</UButton>
          </div>
        </template>
      </UTable>
    </div>

    <!-- Card View -->
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      <div v-if="loading" class="col-span-full flex justify-center py-12">
        <UIcon name="i-heroicons:arrow-path" class="w-8 h-8 animate-spin text-white/20" />
      </div>
      <div v-else-if="!pendingDeposits.length" class="col-span-full text-center py-12 text-white/30 bg-white/5 rounded-3xl border border-white/5">
        <UIcon name="i-heroicons:banknotes" class="w-12 h-12 mx-auto mb-3 opacity-20" />
        <p class="text-lg font-medium">No deposits found</p>
      </div>
      <div
        v-for="d in pendingDeposits" :key="d.id"
        class="relative p-5 rounded-3xl border border-white/5 bg-(--surface-raised) shadow-lg"
      >
        <!-- Transaction ID — top of card -->
        <div class="txid-row">
          <span class="txid-text">{{ d.paymentTransactionId ?? '—' }}</span>
          <button
            class="txid-copy"
            :title="'Copy ' + d.paymentTransactionId"
            @click.stop="copyToClipboard(d.paymentTransactionId)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
        </div>

        <div class="flex justify-between items-start mb-4 mt-3">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold text-primary font-mono bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">
                #{{ formatUserId(d.user.serial) }}
              </span>
              <h3 class="font-bold text-zinc-100">{{ d.user.username }}</h3>
            </div>
          </div>
          <UBadge
            :color="d.status === 'PENDING_REVIEW' ? 'warning' : d.status === 'APPROVED' ? 'success' : 'error'"
            variant="soft" size="xs"
          >
            {{ d.status }}
          </UBadge>
        </div>

        <div class="space-y-2 mb-4">
          <div class="flex justify-between items-center">
            <span class="text-xs text-white/30">Amount</span>
            <span class="text-lg font-black text-yellow-500">{{ Number(d.amount).toFixed(2) }} <span class="text-[10px] font-normal opacity-50">ETB</span></span>
          </div>
          <div v-if="d.receiptUrl" class="mt-2">
            <UButton variant="soft" color="neutral" size="xs" block icon="i-heroicons:eye" @click="openReceipt(d.receiptUrl)">View Receipt</UButton>
          </div>
        </div>

        <div class="pt-3 border-t border-white/5 flex flex-col gap-2">
          <div class="flex justify-between items-center">
            <span class="text-[10px] text-white/20 font-medium">Age: {{ ageMinutes(d.createdAt) }}m</span>
            <span class="text-[10px] text-white/20">{{ new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
          </div>
          <div v-if="d.status === 'PENDING_REVIEW'" class="action-btns">
            <button class="action-btn action-btn--approve" @click="openApproveModal(d.id)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Approve
            </button>
            <button class="action-btn action-btn--decline" @click="openDeclineModal(d.id)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Decline
            </button>
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

    <!-- Receipt Modal -->
    <UModal v-model:open="isReceiptOpen" title="Transfer Receipt" :ui="{ content: 'max-w-2xl' }">
      <template #body>
        <div class="flex justify-center rounded-xl p-2" style="background:var(--surface-overlay);">
          <img :src="selectedReceipt" alt="Receipt" class="max-w-full max-h-[70vh] object-contain shadow-2xl rounded-lg" />
        </div>
      </template>
    </UModal>

    <!-- Approve Confirmation Modal -->
    <UModal v-model:open="showApproveModal" title="Confirm Approval" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="flex flex-col items-center gap-4 py-2">
          <div class="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center">
            <UIcon name="i-heroicons:check-circle" class="w-8 h-8 text-green-400" />
          </div>
          <div class="text-center">
            <p class="text-base font-semibold text-white">Approve this deposit?</p>
            <p class="text-sm text-white/50 mt-1">The amount will be credited to the player's wallet immediately.</p>
          </div>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" :disabled="approveLoading" @click="showApproveModal = false">Cancel</UButton>
        <UButton color="success" :loading="approveLoading" icon="i-heroicons:check" @click="confirmApprove">Confirm Approve</UButton>
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

<style scoped>
/* Transaction ID header */
.txid-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 8px 12px;
}

.txid-text {
  flex: 1;
  font-family: ui-monospace, 'Cascadia Code', monospace;
  font-size: 13px;
  font-weight: 700;
  color: #e2e8f0;
  letter-spacing: 0.03em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.txid-copy {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.txid-copy:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.action-btns {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 36px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  border: none;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
  letter-spacing: 0.01em;
}

.action-btn:active { transform: scale(0.97); }

.action-btn--approve {
  background: #22c55e;
  color: #000;
}
.action-btn--approve:hover { opacity: 0.88; }

.action-btn--decline {
  background: #ef4444;
  color: #fff;
}
.action-btn--decline:hover { opacity: 0.88; }
</style>
