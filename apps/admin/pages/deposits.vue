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
const viewMode = ref<'table' | 'card'>('table')

// ── Filter state ─────────────────────────────────────────────────────────────
const filterSearch = ref('')
const filterUserSerial = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterMinAmount = ref('')
const filterMaxAmount = ref('')
const filterStatus = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const page = ref(1)
const totalPages = ref(1)
const LIMIT = 20

const statusOptions = [
  { label: 'Pending Review', value: '' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Declined', value: 'REJECTED' },
]

// ── Stats ────────────────────────────────────────────────────────────────────
const approvedSum = ref(0)
const declinedSum = ref(0)
const pendingCount = computed(() => pendingDeposits.value.filter(d => d.status === 'PENDING_REVIEW').length)

// ── Fetch ────────────────────────────────────────────────────────────────────
const fetchDeposits = async () => {
  loading.value = true
  try {
    const result: any = await getPendingDeposits({
      status: filterStatus.value || undefined,
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
    // fetch summary stats separately
    const stats = await useAdminApi().getStats()
    approvedSum.value = stats.approvedDepositSum ?? 0
    declinedSum.value = stats.declinedDepositSum ?? 0
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
  filterStatus.value = ''
  page.value = 1
  fetchDeposits()
}

watch([page, filterStatus], fetchDeposits)
onMounted(fetchDeposits)

// ── Actions ───────────────────────────────────────────────────────────────────
const handleApprove = async (id: string) => {
  try {
    await approveTransaction(id)
    toast.add({ title: 'Approved ✅', description: 'Deposit credited to player wallet', color: 'success' })
    fetchDeposits()
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
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-4">
      <h1 class="text-2xl font-bold text-white tracking-tight">Deposits Confirmation</h1>
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
        <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" label="Refresh" @click="fetchDeposits" />
      </div>
    </div>

    <!-- Summary stats -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="group relative overflow-hidden rounded-3xl border border-white/5 p-5 bg-(--surface-raised) shadow-xl transition-all hover:bg-white/5">
        <div class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Pending</div>
        <div class="text-2xl font-black text-yellow-500">{{ pendingCount }}</div>
      </div>
      <div class="group relative overflow-hidden rounded-3xl border border-white/5 p-5 bg-(--surface-raised) shadow-xl transition-all hover:bg-white/5">
        <div class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Approved Sum</div>
        <div class="text-2xl font-black text-emerald-400">{{ approvedSum.toFixed(2) }} <span class="text-[10px] font-normal opacity-50">ETB</span></div>
      </div>
      <div class="group relative overflow-hidden rounded-3xl border border-white/5 p-5 bg-(--surface-raised) shadow-xl transition-all hover:bg-white/5">
        <div class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Declined Sum</div>
        <div class="text-2xl font-black text-red-500">{{ declinedSum.toFixed(2) }} <span class="text-[10px] font-normal opacity-50">ETB</span></div>
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
      <UInput
        v-model="filterFrom"
        type="date"
        class="w-40"
        @change="page = 1; fetchDeposits()"
      />
      <UInput
        v-model="filterTo"
        type="date"
        class="w-40"
        @change="page = 1; fetchDeposits()"
      />
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
        class="w-40"
      />
      <UButton color="neutral" variant="ghost" icon="i-heroicons:x-mark" @click="resetFilters">Reset</UButton>
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
            <UButton size="xs" color="success" variant="soft" icon="i-heroicons:check" @click="handleApprove((row.original as unknown as DepositTransaction).id)">Approve</UButton>
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
        <div class="flex justify-between items-start mb-4">
          <div>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-bold text-primary font-mono bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">
                #{{ formatUserId(d.user.serial) }}
              </span>
              <h3 class="font-bold text-zinc-100">{{ d.user.username }}</h3>
            </div>
            <p class="text-[10px] text-white/30 font-mono mt-1">{{ d.id.split('-')[0] }}</p>
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
          <div class="flex justify-between items-center text-xs">
            <span class="text-white/30">Reference</span>
            <span class="font-bold text-zinc-300 font-mono text-[10px] truncate max-w-30">{{ d.paymentTransactionId }}</span>
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
          <div v-if="d.status === 'PENDING_REVIEW'" class="flex gap-2">
            <UButton size="xs" color="success" block icon="i-heroicons:check" @click="handleApprove(d.id)">Approve</UButton>
            <UButton size="xs" color="error" variant="ghost" icon="i-heroicons:x-mark" @click="openDeclineModal(d.id)" />
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
