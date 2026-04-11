<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="$emit('update:modelValue', false)">
      <div class="modal">
        <div class="modal-header">
          <h3>Deposit Funds</h3>
          <button class="close-btn" @click="$emit('update:modelValue', false)">✕</button>
        </div>

        <div class="modal-body">
          <!-- TeleBirr Instructions Banner -->
          <div class="telebirr-banner">
            <div class="banner-icon">📱</div>
            <div class="banner-content">
              <div class="banner-title">⚡ Complete within 15 minutes</div>
              <div class="banner-detail">Send via <strong>TeleBirr</strong> to merchant number:</div>
              <div class="merchant-number">0901977670</div>
            </div>
          </div>

          <!-- Amount -->
          <div class="field">
            <label>Amount (ETB)</label>
            <input v-model.number="form.amount" type="number" min="10" placeholder="Enter amount" class="input" />
            <div class="chips">
              <button v-for="chip in [50, 100, 200, 500]" :key="chip" class="chip" @click="form.amount = chip">
                +{{ chip }}
              </button>
            </div>
          </div>

          <!-- Payment Method — static TeleBirr label -->
          <div class="field">
            <label>Payment Method</label>
            <div class="input static-method">
              <span class="method-icon">📱</span> TeleBirr
            </div>
          </div>

          <!-- TeleBirr Transaction ID -->
          <div class="field">
            <label>TeleBirr Transaction ID <span class="required">*</span></label>
            <input
              v-model="form.transactionId"
              type="text"
              placeholder="e.g. TLB202601011234"
              class="input"
              :class="{ 'input--error': fieldError === 'transactionId' }"
              @input="if (fieldError === 'transactionId') { fieldError = ''; error = '' }"
            />
            <span v-if="fieldError === 'transactionId'" class="field-error-msg">
              Already used — check your pending deposits below.
            </span>
          </div>

          <!-- Sender Name -->
          <div class="field">
            <label>Your Name (as shown on TeleBirr receipt) <span class="required">*</span></label>
            <input v-model="form.senderName" type="text" placeholder="Full name" class="input" />
          </div>

          <!-- Sender TeleBirr Account -->
          <div class="field">
            <label>Your TeleBirr Phone Number <span class="required">*</span></label>
            <input v-model="form.senderAccount" type="tel" placeholder="09XXXXXXXX" class="input" />
          </div>

          <!-- Receipt Upload -->
          <div class="field">
            <label>Transfer Receipt Screenshot <span class="required">*</span></label>
            <div
              class="file-drop"
              :class="{ 'has-preview': previewUrl }"
              @click="fileInputRef?.click()"
              @dragover.prevent
              @drop.prevent="onFileDrop"
            >
              <img v-if="previewUrl" :src="previewUrl" alt="Receipt preview" class="preview-img" />
              <div v-else class="drop-hint">
                <span class="icon">📎</span>
                <span>Click or drag & drop receipt (JPG/PNG, max 5MB)</span>
              </div>
            </div>
            <input
              ref="fileInputRef"
              type="file"
              accept="image/jpeg,image/png"
              class="hidden-input"
              @change="onFileChange"
            />
          </div>

          <!-- Error / Success -->
          <div v-if="error" class="error-banner" :class="{ 'error-banner--field': fieldError === 'transactionId' }">
            <div class="error-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div class="error-body">
              <span class="error-title">{{ errorTitle }}</span>
              <span v-if="errorHint" class="error-hint">{{ errorHint }}</span>
            </div>
          </div>
          <div v-if="success" class="success-banner">
            <div class="success-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div class="success-body">
              <span class="success-title">Deposit submitted</span>
              <span class="success-hint">Pending admin verification — usually within 15 minutes.</span>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" @click="$emit('update:modelValue', false)">Cancel</button>
          <button class="btn-primary" :disabled="loading || !canSubmit" @click="submit">
            <span v-if="loading">Uploading… {{ uploadProgress }}%</span>
            <span v-else>Submit Deposit</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'deposited'): void
}>()

const auth = useAuthStore()
const config = useRuntimeConfig()

const fileInputRef = ref<HTMLInputElement | null>(null)
const previewUrl = ref<string | null>(null)
const selectedFile = ref<File | null>(null)
const uploadProgress = ref(0)

const form = reactive({
  amount: 0,
  transactionId: '',
  senderName: '',
  senderAccount: '',
})

const error = ref('')
const fieldError = ref('')
const success = ref(false)
const loading = ref(false)

const errorTitle = computed(() => {
  if (fieldError.value === 'transactionId') return 'This Transaction ID has already been submitted.'
  return error.value
})

const errorHint = computed(() => {
  if (fieldError.value === 'transactionId') return 'If you sent money, your deposit may already be pending review. Check your transaction history or enter a different Transaction ID.'
  return ''
})

const canSubmit = computed(() =>
  form.amount >= 10 &&
  form.transactionId.trim().length >= 5 &&
  form.senderName.trim().length >= 1 &&
  form.senderAccount.trim().length >= 10 &&
  selectedFile.value !== null,
)

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) setFile(file)
}

function onFileDrop(e: DragEvent) {
  const file = e.dataTransfer?.files?.[0]
  if (file) setFile(file)
}

function setFile(file: File) {
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    error.value = 'Only JPG/PNG images are allowed.'
    return
  }
  if (file.size > 5 * 1024 * 1024) {
    error.value = 'File size must be under 5 MB.'
    return
  }
  selectedFile.value = file
  previewUrl.value = URL.createObjectURL(file)
  error.value = ''
}

async function submit() {
  if (!canSubmit.value || !selectedFile.value) return
  loading.value = true
  error.value = ''
  success.value = false
  uploadProgress.value = 0

  try {
    const formData = new FormData()
    formData.append('amount', String(form.amount))
    formData.append('transactionId', form.transactionId)
    formData.append('senderName', form.senderName)
    formData.append('senderAccount', form.senderAccount)
    formData.append('receipt', selectedFile.value)

    await auth.apiFetch('/wallet/deposit', {
      method: 'POST',
      body: formData,
    })

    success.value = true
    uploadProgress.value = 100
    emit('deposited')
    setTimeout(() => {
      emit('update:modelValue', false)
      resetForm()
    }, 2000)
  } catch (e: any) {
    const status = e?.status ?? e?.statusCode ?? e?.response?.status
    const serverMsg = e?.data?.error ?? e?.data?.message ?? e?.message
    if (status === 409) {
      fieldError.value = 'transactionId'
      error.value = serverMsg ?? 'Transaction ID already used.'
    } else {
      fieldError.value = ''
      error.value = serverMsg ?? 'Deposit failed. Please try again.'
    }
  } finally {
    loading.value = false
  }
}

function resetForm() {
  form.amount = 0
  form.transactionId = ''
  form.senderName = ''
  form.senderAccount = ''
  selectedFile.value = null
  previewUrl.value = null
  uploadProgress.value = 0
  success.value = false
  error.value = ''
  fieldError.value = ''
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
  max-width: 460px;
  max-height: 90vh;
  overflow-y: auto;
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
  line-height: 1;
}

.modal-body {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

label {
  font-size: 0.85rem;
  color: #aaa;
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

.chips {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.25rem;
}

.chip {
  padding: 0.3rem 0.75rem;
  background: rgba(201, 169, 110, 0.12);
  border: 1px solid rgba(201, 169, 110, 0.4);
  color: var(--color-primary, #c9a96e);
  border-radius: 20px;
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.2s;
}

.chip:hover {
  background: rgba(201, 169, 110, 0.25);
}

.file-drop {
  border: 2px dashed rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  min-height: 100px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: border-color 0.2s;
  overflow: hidden;
  padding: 0.5rem;
}

.file-drop:hover {
  border-color: var(--color-primary, #c9a96e);
}

.drop-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  color: #777;
  font-size: 0.85rem;
  text-align: center;
}

.drop-hint .icon {
  font-size: 2rem;
}

.preview-img {
  max-height: 200px;
  max-width: 100%;
  object-fit: contain;
  border-radius: 4px;
}

.hidden-input {
  display: none;
}

/* ── Field-level error ─────────────────────────────────────────── */
.input--error {
  border-color: #f87171 !important;
  background: rgba(239, 68, 68, 0.06) !important;
}

.field-error-msg {
  font-size: 0.75rem;
  color: #f87171;
  margin-top: 0.1rem;
}

/* ── Error banner ──────────────────────────────────────────────── */
.error-banner {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 10px;
  padding: 0.875rem 1rem;
  animation: slide-in 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.error-banner--field {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.1);
}

.error-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  color: #f87171;
  margin-top: 1px;
}

.error-icon svg {
  width: 100%;
  height: 100%;
}

.error-body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.error-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: #f87171;
  line-height: 1.4;
}

.error-hint {
  font-size: 0.78rem;
  color: rgba(248, 113, 113, 0.75);
  line-height: 1.5;
}

/* ── Success banner ────────────────────────────────────────────── */
.success-banner {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  background: rgba(34, 197, 94, 0.08);
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 10px;
  padding: 0.875rem 1rem;
  animation: slide-in 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.success-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  color: #4ade80;
  margin-top: 1px;
}

.success-icon svg {
  width: 100%;
  height: 100%;
}

.success-body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.success-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: #4ade80;
}

.success-hint {
  font-size: 0.78rem;
  color: rgba(74, 222, 128, 0.7);
  line-height: 1.5;
}

@keyframes slide-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
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

.telebirr-banner {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  background: rgba(201, 169, 110, 0.1);
  border: 1px solid rgba(201, 169, 110, 0.35);
  border-radius: 10px;
  padding: 0.85rem 1rem;
}

.banner-icon {
  font-size: 1.8rem;
  flex-shrink: 0;
  line-height: 1;
}

.banner-content {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.banner-title {
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--color-primary, #c9a96e);
}

.banner-detail {
  font-size: 0.8rem;
  color: #bbb;
}

.merchant-number {
  font-size: 1.25rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #fff;
}

.static-method {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #ddd;
  cursor: default;
}

.method-icon {
  font-size: 1.1rem;
}

.required {
  color: #f87171;
  margin-left: 2px;
}
</style>
