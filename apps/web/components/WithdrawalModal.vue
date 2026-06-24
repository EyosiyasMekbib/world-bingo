<template>
  <Teleport to="body">
    <div v-if="modelValue" class="wb-overlay" @click.self="$emit('update:modelValue', false)">
      <div class="wb-modal">
        <div class="wb-modal__head">
          <h3 class="wb-modal__title">Withdraw Funds</h3>
          <button class="wb-close" aria-label="Close" @click="$emit('update:modelValue', false)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div class="wb-modal__body">
          <div class="balance-info">
            <span>Available Balance</span>
            <strong>{{ balance.toFixed(2) }} ETB</strong>
          </div>

          <!-- Loading methods -->
          <div v-if="loadingMethods" class="wb-empty">
            Loading payment methods…
          </div>

          <!-- No methods -->
          <div v-else-if="withdrawalMethods.length === 0" class="wb-empty">
            No withdrawal methods are currently available. Please try again later.
          </div>

          <template v-else>
            <!-- Amount -->
            <div class="wb-field">
              <label class="wb-label">Amount (ETB)</label>
              <input
                v-model.number="form.amount"
                type="number"
                :min="100"
                :max="balance"
                placeholder="Min 100 ETB"
                class="wb-input"
              />
              <span class="wb-hint">Minimum: 100 ETB</span>
            </div>

            <!-- Bank / Payment Method (dynamic) -->
            <div class="wb-field">
              <label class="wb-label">Bank / Payment Method</label>
              <select v-model="form.paymentMethod" class="wb-select">
                <option v-for="m in withdrawalMethods" :key="m.code" :value="m.code">
                  {{ m.icon ? m.icon + ' ' : '' }}{{ m.name }}
                </option>
              </select>
            </div>

            <!-- Account Number -->
            <div class="wb-field">
              <label class="wb-label">Account / Phone Number</label>
              <input
                v-model="form.accountNumber"
                type="text"
                placeholder="e.g. 0912345678"
                class="wb-input"
              />
            </div>

            <p v-if="error" class="wb-notice wb-notice--error"><span class="wb-notice__title">{{ error }}</span></p>
            <p v-if="success" class="wb-notice wb-notice--success"><span class="wb-notice__title">Withdrawal request submitted — we'll process it within 24h.</span></p>
          </template>
        </div>

        <div class="wb-modal__foot">
          <button class="wb-btn wb-btn--subtle" @click="$emit('update:modelValue', false)">Cancel</button>
          <button
            class="wb-btn wb-btn--primary"
            :disabled="loading || !canSubmit || withdrawalMethods.length === 0"
            @click="submit"
          >
            <span v-if="loading">Submitting…</span>
            <span v-else>Request Withdrawal</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const props = defineProps<{ modelValue: boolean; balance: number }>()
const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'withdrawn'): void
}>()

const auth = useAuthStore()

type WithdrawalMethod = { code: string; name: string; icon: string | null }

const loadingMethods = ref(false)
const withdrawalMethods = ref<WithdrawalMethod[]>([])

const form = reactive({
  amount: 0,
  paymentMethod: '',
  accountNumber: '',
})

const error = ref('')
const success = ref(false)
const loading = ref(false)

const fetchMethods = async () => {
  loadingMethods.value = true
  try {
    const data = await auth.apiFetch<WithdrawalMethod[]>('/payment-methods?type=WITHDRAWAL')
    withdrawalMethods.value = Array.isArray(data) ? data : []
    if (withdrawalMethods.value.length > 0 && !form.paymentMethod) {
      form.paymentMethod = withdrawalMethods.value[0].code
    }
  } catch {
    withdrawalMethods.value = []
  } finally {
    loadingMethods.value = false
  }
}

watch(() => props.modelValue, (open) => {
  if (open) fetchMethods()
})

const canSubmit = computed(
  () =>
    form.amount >= 100 &&
    form.amount <= props.balance &&
    form.paymentMethod.length > 0 &&
    form.accountNumber.length >= 7,
)

async function submit() {
  if (!canSubmit.value) return
  loading.value = true
  error.value = ''
  success.value = false

  try {
    await auth.apiFetch('/wallet/withdraw', {
      method: 'POST',
      body: {
        amount: form.amount,
        paymentMethod: form.paymentMethod,
        accountNumber: form.accountNumber,
      },
    })
    success.value = true
    emit('withdrawn')
    setTimeout(() => {
      emit('update:modelValue', false)
      resetForm()
    }, 2500)
  } catch (e: any) {
    error.value = e?.data?.error ?? e?.data?.message ?? e?.message ?? 'Withdrawal request failed. Please try again.'
  } finally {
    loading.value = false
  }
}

function resetForm() {
  form.amount = 0
  form.paymentMethod = withdrawalMethods.value[0]?.code ?? ''
  form.accountNumber = ''
  error.value = ''
  success.value = false
}
</script>

<style scoped>
.balance-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 15px;
  border-radius: var(--radius-md, 12px);
  background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 28%, transparent);
}
.balance-info span {
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.balance-info strong {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 18px;
  color: var(--brand-primary);
}

select.wb-select option { background: var(--surface-raised); color: var(--text-primary); }
</style>
