<script setup lang="ts">
const { getPaymentMethods, createPaymentMethod, updatePaymentMethod, deletePaymentMethod } = useAdminApi()
const toast = useToast()

type PaymentMethod = {
  id: string
  code: string
  name: string
  type: 'DEPOSIT' | 'WITHDRAWAL'
  merchantAccount: string | null
  instructions: string | null
  icon: string | null
  enabled: boolean
  sortOrder: number
}

const loading = ref(true)
const methods = ref<PaymentMethod[]>([])

const modalOpen = ref(false)
const saving = ref(false)
const editingId = ref<string | null>(null)

const form = reactive({
  code: '',
  name: '',
  type: 'DEPOSIT' as 'DEPOSIT' | 'WITHDRAWAL',
  merchantAccount: '',
  instructions: '',
  icon: '',
  enabled: true,
  sortOrder: 0,
})

const deleteConfirmId = ref<string | null>(null)
const showDeleteConfirm = ref(false)
const deleting = ref(false)
const toggling = ref<string | null>(null)

const fetchMethods = async () => {
  loading.value = true
  try {
    methods.value = await getPaymentMethods()
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load payment methods', color: 'error' })
  } finally {
    loading.value = false
  }
}

const openAdd = () => {
  editingId.value = null
  form.code = ''
  form.name = ''
  form.type = 'DEPOSIT'
  form.merchantAccount = ''
  form.instructions = ''
  form.icon = ''
  form.enabled = true
  form.sortOrder = 0
  modalOpen.value = true
}

const openEdit = (m: PaymentMethod) => {
  editingId.value = m.id
  form.code = m.code
  form.name = m.name
  form.type = m.type
  form.merchantAccount = m.merchantAccount ?? ''
  form.instructions = m.instructions ?? ''
  form.icon = m.icon ?? ''
  form.enabled = m.enabled
  form.sortOrder = m.sortOrder
  modalOpen.value = true
}

const saveMethod = async () => {
  if (!form.code || !form.name) {
    toast.add({ title: 'Validation', description: 'Code and name are required', color: 'warning' })
    return
  }
  saving.value = true
  try {
    const payload = {
      code: form.code,
      name: form.name,
      type: form.type,
      merchantAccount: form.merchantAccount || null,
      instructions: form.instructions || null,
      icon: form.icon || null,
      enabled: form.enabled,
      sortOrder: form.sortOrder,
    }
    if (editingId.value) {
      await updatePaymentMethod(editingId.value, payload)
      toast.add({ title: 'Updated', description: `${form.name} updated`, color: 'success' })
    } else {
      await createPaymentMethod(payload)
      toast.add({ title: 'Created', description: `${form.name} added`, color: 'success' })
    }
    modalOpen.value = false
    await fetchMethods()
  } catch (e: any) {
    const msg = e?.data?.error ?? 'Failed to save payment method'
    toast.add({ title: 'Error', description: msg, color: 'error' })
  } finally {
    saving.value = false
  }
}

const confirmDelete = (id: string) => {
  deleteConfirmId.value = id
  showDeleteConfirm.value = true
}

const doDelete = async () => {
  if (!deleteConfirmId.value) return
  deleting.value = true
  try {
    await deletePaymentMethod(deleteConfirmId.value)
    toast.add({ title: 'Deleted', description: 'Payment method removed', color: 'success' })
    showDeleteConfirm.value = false
    deleteConfirmId.value = null
    await fetchMethods()
  } catch {
    toast.add({ title: 'Error', description: 'Failed to delete', color: 'error' })
  } finally {
    deleting.value = false
  }
}

const toggleEnabled = async (m: PaymentMethod) => {
  toggling.value = m.id
  try {
    await updatePaymentMethod(m.id, { enabled: !m.enabled })
    m.enabled = !m.enabled
  } catch {
    toast.add({ title: 'Error', description: 'Failed to toggle', color: 'error' })
  } finally {
    toggling.value = null
  }
}

const typeItems = [
  { label: 'Deposit', value: 'DEPOSIT' },
  { label: 'Withdrawal', value: 'WITHDRAWAL' },
]

const depositMethods = computed(() => methods.value.filter(m => m.type === 'DEPOSIT'))
const withdrawalMethods = computed(() => methods.value.filter(m => m.type === 'WITHDRAWAL'))

onMounted(fetchAll)

async function fetchAll() {
  await fetchMethods()
}
</script>

<template>
  <div class="space-y-8 max-w-3xl">
    <!-- Header -->
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Payment Methods</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">Configure deposit and withdrawal options shown to players</p>
      </div>
      <UButton
        icon="i-heroicons:plus"
        color="primary"
        size="sm"
        @click="openAdd"
      >
        Add Method
      </UButton>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>

    <template v-else>
      <!-- Deposit Methods -->
      <div class="space-y-3">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:arrow-down-tray" class="w-5 h-5 text-emerald-400" />
          Deposit Methods
        </h2>

        <div v-if="depositMethods.length === 0" class="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm text-white/30">
          No deposit methods configured
        </div>

        <div
          v-for="m in depositMethods"
          :key="m.id"
          class="rounded-2xl border p-4 transition-all shadow-md"
          :class="m.enabled ? 'border-(--surface-border) hover:border-yellow-500/30' : 'border-white/5 opacity-60'"
          style="background: var(--surface-raised);"
        >
          <div class="flex items-center gap-4">
            <div class="p-2.5 rounded-xl border border-yellow-500/20 shrink-0 text-xl leading-none" style="background:var(--surface-overlay);">
              {{ m.icon || '💳' }}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="text-sm font-bold text-white">{{ m.name }}</p>
                <span class="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">DEPOSIT</span>
                <span v-if="!m.enabled" class="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/20">DISABLED</span>
              </div>
              <p class="text-xs text-white/40 mt-0.5 font-mono">{{ m.code }}</p>
              <p v-if="m.merchantAccount" class="text-xs text-white/50 mt-1">
                <span class="text-white/30">Account:</span> {{ m.merchantAccount }}
              </p>
              <p v-if="m.instructions" class="text-xs text-white/40 mt-1 truncate max-w-xs">{{ m.instructions }}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <USwitch
                :model-value="m.enabled"
                :disabled="toggling === m.id"
                color="primary"
                @update:model-value="toggleEnabled(m)"
              />
              <UButton
                icon="i-heroicons:pencil-square"
                color="neutral"
                variant="ghost"
                size="xs"
                @click="openEdit(m)"
              />
              <UButton
                icon="i-heroicons:trash"
                color="error"
                variant="ghost"
                size="xs"
                @click="confirmDelete(m.id)"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Withdrawal Methods -->
      <div class="space-y-3">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:arrow-up-tray" class="w-5 h-5 text-blue-400" />
          Withdrawal Methods
        </h2>

        <div v-if="withdrawalMethods.length === 0" class="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm text-white/30">
          No withdrawal methods configured
        </div>

        <div
          v-for="m in withdrawalMethods"
          :key="m.id"
          class="rounded-2xl border p-4 transition-all shadow-md"
          :class="m.enabled ? 'border-(--surface-border) hover:border-yellow-500/30' : 'border-white/5 opacity-60'"
          style="background: var(--surface-raised);"
        >
          <div class="flex items-center gap-4">
            <div class="p-2.5 rounded-xl border border-blue-500/20 shrink-0 text-xl leading-none" style="background:var(--surface-overlay);">
              {{ m.icon || '🏦' }}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <p class="text-sm font-bold text-white">{{ m.name }}</p>
                <span class="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-blue-500/10 text-blue-400 border border-blue-500/20">WITHDRAWAL</span>
                <span v-if="!m.enabled" class="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-red-500/10 text-red-400 border border-red-500/20">DISABLED</span>
              </div>
              <p class="text-xs text-white/40 mt-0.5 font-mono">{{ m.code }}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <USwitch
                :model-value="m.enabled"
                :disabled="toggling === m.id"
                color="primary"
                @update:model-value="toggleEnabled(m)"
              />
              <UButton
                icon="i-heroicons:pencil-square"
                color="neutral"
                variant="ghost"
                size="xs"
                @click="openEdit(m)"
              />
              <UButton
                icon="i-heroicons:trash"
                color="error"
                variant="ghost"
                size="xs"
                @click="confirmDelete(m.id)"
              />
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Add / Edit Modal -->
    <UModal v-model:open="modalOpen" :title="editingId ? 'Edit Payment Method' : 'Add Payment Method'">
      <template #body>
        <div class="space-y-4 p-1">
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-xs font-semibold text-white/60 uppercase tracking-wider">Code *</label>
              <UInput v-model="form.code" placeholder="e.g. telebirr" :disabled="!!editingId" />
              <p class="text-[11px] text-white/30">Unique identifier, cannot change after creation</p>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold text-white/60 uppercase tracking-wider">Display Name *</label>
              <UInput v-model="form.name" placeholder="e.g. TeleBirr" />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-xs font-semibold text-white/60 uppercase tracking-wider">Type *</label>
              <USelect v-model="form.type" :items="typeItems" />
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold text-white/60 uppercase tracking-wider">Icon (emoji)</label>
              <UInput v-model="form.icon" placeholder="📱" />
            </div>
          </div>

          <div v-if="form.type === 'DEPOSIT'" class="space-y-1">
            <label class="text-xs font-semibold text-white/60 uppercase tracking-wider">Merchant Account</label>
            <UInput v-model="form.merchantAccount" placeholder="Phone number or account number" />
          </div>

          <div class="space-y-1">
            <label class="text-xs font-semibold text-white/60 uppercase tracking-wider">Instructions</label>
            <UInput v-model="form.instructions" placeholder="Instructions shown to the player" />
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1">
              <label class="text-xs font-semibold text-white/60 uppercase tracking-wider">Sort Order</label>
              <UInput v-model.number="form.sortOrder" type="number" min="0" />
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold text-white/60 uppercase tracking-wider">Enabled</label>
              <div class="flex items-center h-9">
                <USwitch v-model="form.enabled" color="primary" />
              </div>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="modalOpen = false">Cancel</UButton>
          <UButton color="primary" :loading="saving" icon="i-heroicons:check" @click="saveMethod">
            {{ editingId ? 'Save Changes' : 'Add Method' }}
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Delete Confirm Modal -->
    <UModal v-model:open="showDeleteConfirm" title="Delete Payment Method">
      <template #body>
        <p class="text-sm text-white/70 p-1">
          This will permanently remove the payment method. Players won't see it anymore.
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="showDeleteConfirm = false">Cancel</UButton>
          <UButton color="error" :loading="deleting" icon="i-heroicons:trash" @click="doDelete">
            Delete
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
