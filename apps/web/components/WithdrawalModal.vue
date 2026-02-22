<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="$emit('update:modelValue', false)">
      <div class="modal">
        <div class="modal-header">
          <h3>Withdraw Funds</h3>
          <button class="close-btn" @click="$emit('update:modelValue', false)">✕</button>
        </div>

        <div class="modal-body">
          <p class="balance-info">
            Available Balance: <strong>{{ balance.toFixed(2) }} ETB</strong>
          </p>

          <!-- Amount -->
          <div class="field">
            <label>Amount (ETB)</label>
            <input
              v-model.number="form.amount"
              type="number"
              :min="100"
              :max="balance"
              placeholder="Min 100 ETB"
              class="input"
            />
            <span class="hint">Minimum: 100 ETB</span>
          </div>

          <!-- Bank -->
          <div class="field">
            <label>Bank / Payment Method</label>
            <select v-model="form.paymentMethod" class="input">
              <option value="telebirr">Telebirr</option>
              <option value="cbe">CBE Birr</option>
              <option value="awash">Awash Bank</option>
              <option value="dashen">Dashen Bank</option>
              <option value="amhara">Amhara Bank</option>
            </select>
          </div>

          <!-- Account Number -->
          <div class="field">
            <label>Account / Phone Number</label>
            <input
              v-model="form.accountNumber"
              type="text"
              placeholder="e.g. 0912345678"
              class="input"
            />
          </div>

          <p v-if="error" class="msg error">{{ error }}</p>
          <p v-if="success" class="msg success">✅ Withdrawal request submitted! We'll process it within 24h.</p>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" @click="$emit('update:modelValue', false)">Cancel</button>
          <button class="btn-primary" :disabled="loading || !canSubmit" @click="submit">
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

const form = reactive({
  amount: 0,
  paymentMethod: 'telebirr',
  accountNumber: '',
})

const error = ref('')
const success = ref(false)
const loading = ref(false)

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
    error.value = e?.data?.message ?? e?.message ?? 'Withdrawal request failed. Please try again.'
  } finally {
    loading.value = false
  }
}

function resetForm() {
  form.amount = 0
  form.paymentMethod = 'telebirr'
  form.accountNumber = ''
  error.value = ''
  success.value = false
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--color-surface, #1a1a2e);
  border: 1px solid var(--color-primary, #c9a96e);
  border-radius: 12px;
  width: 100%;
  max-width: 420px;
  padding: 0;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.modal-header h3 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--color-primary, #c9a96e);
}

.close-btn {
  background: none;
  border: none;
  color: #999;
  cursor: pointer;
  font-size: 1rem;
}

.modal-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.balance-info {
  color: #aaa;
  font-size: 0.9rem;
  background: rgba(255, 255, 255, 0.04);
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  margin: 0;
}

.balance-info strong {
  color: var(--color-primary, #c9a96e);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

label {
  font-size: 0.85rem;
  color: #aaa;
}

.hint {
  font-size: 0.75rem;
  color: #666;
}

.input {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #fff;
  padding: 0.6rem 0.8rem;
  font-size: 1rem;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}

.input:focus {
  border-color: var(--color-primary, #c9a96e);
}

.msg {
  font-size: 0.875rem;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin: 0;
}

.msg.error {
  background: rgba(220, 38, 38, 0.1);
  color: #f87171;
  border: 1px solid rgba(220, 38, 38, 0.3);
}

.msg.success {
  background: rgba(34, 197, 94, 0.1);
  color: #86efac;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.modal-footer {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
  padding: 1rem 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.btn-primary {
  padding: 0.6rem 1.4rem;
  background: var(--color-primary, #c9a96e);
  color: #000;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.95rem;
  transition: opacity 0.2s;
}

.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-secondary {
  padding: 0.6rem 1.2rem;
  background: transparent;
  color: #aaa;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.95rem;
}
</style>
