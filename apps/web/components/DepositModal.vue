<template>
  <Teleport to="body">
    <div v-if="modelValue" class="wb-overlay" @click.self="$emit('update:modelValue', false)">
      <div class="wb-modal wb-modal--lg">
        <div class="wb-modal__head">
          <h3 class="wb-modal__title">Deposit Funds</h3>
          <button class="wb-close" aria-label="Close" @click="$emit('update:modelValue', false)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div class="wb-modal__body">
          <!-- Loading methods -->
          <div v-if="loadingMethods" class="wb-empty">
            <span class="spin">⏳</span> Loading payment methods…
          </div>

          <!-- No methods available -->
          <div v-else-if="depositMethods.length === 0" class="wb-empty">
            No deposit methods are currently available. Please try again later.
          </div>

          <template v-else>
            <div class="method-stack">
              <section
                v-for="m in depositMethods"
                :key="m.code"
                class="method-card"
                :class="{ 'method-card--open': openMethod === m.code }"
              >
                <header class="method-card__logo">
                  <img v-if="m.logoUrl" :src="m.logoUrl" :alt="m.name" />
                  <span v-else class="method-card__fallback">
                    <span aria-hidden="true">{{ m.icon || '💳' }}</span> {{ m.name }}
                  </span>
                </header>

                <div class="method-card__body">
                  <h4 class="method-card__name">{{ m.name }}</h4>

                  <!-- Hosted checkout: amount and go. Method choice, the collection
                       account and the receipt all live on ZareCash's page. -->
                  <template v-if="m.hostedCheckout">
                    <div class="wb-field">
                      <label class="wb-label">{{ t('wallet.amount') }} (ETB)</label>
                      <input
                        v-model.number="checkoutAmount"
                        type="number"
                        :min="MIN_DEPOSIT"
                        :placeholder="`Min ${MIN_DEPOSIT} ETB`"
                        class="wb-input"
                        @focus="openMethod = m.code"
                      />
                      <div class="chips">
                        <button
                          v-for="chip in [200, 500, 1000, 2000]"
                          :key="chip"
                          class="wb-chip"
                          @click="checkoutAmount = chip; openMethod = m.code"
                        >
                          +{{ chip }}
                        </button>
                      </div>
                    </div>
                    <p v-if="checkoutError" class="wb-hint wb-hint--error">{{ checkoutError }}</p>
                    <button
                      class="wb-btn wb-btn--primary method-card__cta"
                      :disabled="redirecting || !(checkoutAmount >= MIN_DEPOSIT)"
                      @click="startCheckout(m)"
                    >
                      {{ redirecting ? t('wallet.redirecting') : t('wallet.continue') }}
                    </button>
                    <p class="method-card__hint">{{ t('wallet.hostedCheckoutHint') }}</p>
                  </template>

                  <!-- Manual: collapsed to a Continue button, expands to the
                       receipt form in place. -->
                  <template v-else>
                    <button
                      v-if="openMethod !== m.code"
                      class="wb-btn wb-btn--primary method-card__cta"
                      @click="toggleMethod(m)"
                    >
                      {{ t('wallet.continue') }}
                    </button>

                    <template v-else>
                      <div v-if="m.merchantAccount || m.instructions" class="method-banner">
                        <div class="banner-content">
                          <template v-if="m.merchantAccount">
                            <div class="banner-detail">Send to:</div>
                            <div class="merchant-number">
                              <span v-if="m.merchantName">{{ m.merchantName }} — </span>{{ m.merchantAccount }}
                            </div>
                          </template>
                          <div v-if="m.instructions" class="banner-instructions">{{ m.instructions }}</div>
                        </div>
                      </div>

                      <div class="wb-field">
                        <label class="wb-label">Amount (ETB)</label>
                        <input
                          v-model.number="form.amount"
                          type="number"
                          :min="MIN_DEPOSIT"
                          :placeholder="`Min ${MIN_DEPOSIT} ETB`"
                          :class="['wb-input', form.amount > 0 && form.amount < MIN_DEPOSIT ? 'wb-input--error' : '']"
                        />
                        <p v-if="form.amount > 0 && form.amount < MIN_DEPOSIT" class="wb-hint wb-hint--error">
                          Minimum deposit is {{ MIN_DEPOSIT }} ETB
                        </p>
                        <div class="chips">
                          <button v-for="chip in [200, 500, 1000, 2000]" :key="chip" class="wb-chip" @click="form.amount = chip">
                            +{{ chip }}
                          </button>
                        </div>
                      </div>

                      <div v-if="dailyDepositHint || weeklyDepositHint" class="deposit-bonus-hints">
                        <p v-if="dailyDepositHint" class="deposit-bonus-hint">
                          <span aria-hidden="true">🎁</span>{{ dailyDepositHint }}
                        </p>
                        <p v-if="weeklyDepositHint" class="deposit-bonus-hint">
                          <span aria-hidden="true">🎁</span>{{ weeklyDepositHint }}
                        </p>
                      </div>

                      <div class="wb-field">
                        <label class="wb-label">Transaction ID <span class="wb-req">*</span></label>
                        <input
                          v-model="form.transactionId"
                          type="text"
                          placeholder="e.g. TLB202601011234"
                          class="wb-input"
                          :class="{ 'wb-input--error': fieldError === 'transactionId' }"
                          @input="if (fieldError === 'transactionId') { fieldError = ''; error = '' }"
                        />
                        <span v-if="fieldError === 'transactionId'" class="wb-hint wb-hint--error">
                          Already used — check your pending deposits below.
                        </span>
                      </div>

                      <div class="wb-field">
                        <label class="wb-label">Your Full Name <span class="wb-req">*</span></label>
                        <input v-model="form.senderName" type="text" placeholder="Full name" class="wb-input" />
                      </div>

                      <div class="wb-field">
                        <label class="wb-label">Your {{ m.name }} Phone/Account Number <span class="wb-req">*</span></label>
                        <input v-model="form.senderAccount" type="tel" placeholder="09XXXXXXXX" class="wb-input" />
                      </div>

                      <div class="wb-field">
                        <label class="wb-label">Transfer Receipt Screenshot <span class="wb-req">*</span></label>
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
                            <span>Click or drag &amp; drop receipt (JPG/PNG/HEIC, max 5MB)</span>
                          </div>
                        </div>
                        <input
                          ref="fileInputRef"
                          type="file"
                          accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
                          class="hidden-input"
                          @change="onFileChange"
                        />
                      </div>

                      <div v-if="error" class="wb-notice wb-notice--error">
                        <div class="wb-notice__icon">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                          </svg>
                        </div>
                        <div class="wb-notice__body">
                          <span class="wb-notice__title">{{ errorTitle }}</span>
                          <span v-if="errorHint" class="wb-notice__text">{{ errorHint }}</span>
                        </div>
                      </div>
                      <div v-if="success" class="wb-notice wb-notice--success">
                        <div class="wb-notice__icon">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <div class="wb-notice__body">
                          <span class="wb-notice__title">Deposit submitted</span>
                          <span class="wb-notice__text">Pending admin verification — usually within 15 minutes.</span>
                        </div>
                      </div>

                      <button
                        class="wb-btn wb-btn--primary method-card__cta"
                        :disabled="loading || !canSubmit"
                        @click="submit"
                      >
                        <span v-if="loading">Uploading… {{ uploadProgress }}%</span>
                        <span v-else>Submit Deposit</span>
                      </button>
                    </template>
                  </template>
                </div>
              </section>
            </div>
          </template>
        </div>

        <div class="wb-modal__foot">
          <button class="wb-btn wb-btn--subtle" @click="$emit('update:modelValue', false)">Cancel</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'
import { usePromotionsStore } from '~/store/promotions'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'deposited'): void
}>()

const auth = useAuthStore()
const promotions = usePromotionsStore()
const { track } = useAnalytics()
const { t } = useI18n()

type DepositMethod = {
  id: string
  code: string
  name: string
  icon: string | null
  merchantName: string | null
  merchantAccount: string | null
  instructions: string | null
  gateway: string
  hostedCheckout: boolean
  logoUrl: string | null
}

/** Mirrors the API's min_deposit_amount site setting. */
const MIN_DEPOSIT = 200

const loadingMethods = ref(false)
const depositMethods = ref<DepositMethod[]>([])

// Accordion: exactly one card open at a time.
const openMethod = ref<string | null>(null)
const selectedMethod = computed(
  () => depositMethods.value.find((m) => m.code === openMethod.value) ?? null,
)

function toggleMethod(m: DepositMethod) {
  openMethod.value = openMethod.value === m.code ? null : m.code
  if (openMethod.value) track('deposit_method_selected', { paymentMethod: m.code })
}

// ── Hosted checkout (ZareCash) ────────────────────────────────────
const checkoutAmount = ref(0)
const checkoutError = ref('')
const redirecting = ref(false)

async function startCheckout(m: DepositMethod) {
  if (redirecting.value) return
  redirecting.value = true
  checkoutError.value = ''
  const amt = checkoutAmount.value
  const amountBucket = amt < 500 ? '<500' : amt < 1000 ? '500-1000' : amt < 5000 ? '1000-5000' : '5000+'
  track('deposit_amount_entered', { paymentMethod: m.code, amountBucket })
  try {
    const res = await auth.apiFetch<{ url: string }>('/wallet/deposit/checkout', {
      method: 'POST',
      body: { amount: amt, methodCode: m.code },
    })
    // Always the URL from THIS response: repeating the idempotency key mints a
    // fresh link upstream and kills the previous one.
    window.location.assign(res.url)
  } catch (e: any) {
    checkoutError.value = e?.data?.error ?? t('wallet.checkoutFailed')
    redirecting.value = false
  }
}

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
  !!selectedMethod.value &&
  form.amount >= MIN_DEPOSIT &&
  form.transactionId.trim().length >= 5 &&
  form.senderName.trim().length >= 1 &&
  form.senderAccount.trim().length >= 10 &&
  selectedFile.value !== null,
)

const fetchMethods = async () => {
  loadingMethods.value = true
  try {
    const data = await auth.apiFetch<DepositMethod[]>('/payment-methods?type=DEPOSIT')
    depositMethods.value = Array.isArray(data) ? data : []
    if (depositMethods.value.length > 0) {
      openMethod.value = depositMethods.value[0].code
    }
  } catch {
    depositMethods.value = []
  } finally {
    loadingMethods.value = false
  }
}

watch(() => props.modelValue, (open) => {
  if (open) {
    fetchMethods()
    promotions.fetch()
    track('deposit_modal_opened')
  }
})

// ── Deposit-progress hints (daily/weekly deposit bonus rules) ──────
const dailyDepositHint = computed(() => {
  const rule = promotions.dailyDepositBonus
  return rule ? t('wallet.depositDailyHint', { amount: rule.threshold }) : null
})
const weeklyDepositHint = computed(() => {
  const rule = promotions.weeklyDepositBonus
  return rule ? t('wallet.depositWeeklyHint', { amount: rule.threshold }) : null
})

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
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.type)
    && !file.name.toLowerCase().match(/\.(jpg|jpeg|png|webp|heic|heif)$/)) {
    error.value = 'Only JPG, PNG, or HEIC images are allowed.'
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
  const amountBucket = form.amount < 500 ? '<500' : form.amount < 1000 ? '500-1000' : form.amount < 5000 ? '1000-5000' : '5000+'
  track('deposit_amount_entered', { paymentMethod: selectedMethod.value?.code ?? null, amountBucket })

  try {
    const formData = new FormData()
    formData.append('amount', String(form.amount))
    formData.append('transactionId', form.transactionId)
    formData.append('senderName', form.senderName)
    formData.append('senderAccount', form.senderAccount)
    formData.append('receipt', selectedFile.value)
    if (selectedMethod.value) {
      formData.append('methodCode', selectedMethod.value.code)
    }

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
  openMethod.value = depositMethods.value[0]?.code ?? null
}
</script>

<style scoped>
.spin { display: inline-block; }

/* ── Method cards (the deposit stack) ─────────────────────────── */
.method-stack { display: flex; flex-direction: column; gap: 14px; }

.method-card {
  border-radius: var(--radius-md, 12px);
  overflow: hidden;
  background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 22%, transparent);
}
.method-card--open { border-color: color-mix(in srgb, var(--brand-primary) 48%, transparent); }

.method-card__logo {
  background: #fff;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  min-height: 56px;
}
.method-card__logo img { max-height: 32px; width: auto; }
.method-card__fallback { font-weight: 700; color: #111; display: flex; align-items: center; gap: 8px; }

.method-card__body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.method-card__name {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-primary);
}
.method-card__cta { width: 100%; justify-content: center; }
.method-card__hint { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }

.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}

/* ── Method banner (bespoke: merchant payout details) ─────────── */
.method-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: color-mix(in srgb, var(--brand-primary) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 36%, transparent);
  border-radius: var(--radius-md, 12px);
  padding: 14px 16px;
}
.banner-icon { font-size: 1.8rem; flex-shrink: 0; line-height: 1; }
.banner-content { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.banner-title {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--brand-primary);
}
.banner-detail { font-size: 12.5px; color: var(--text-secondary); }
.merchant-number {
  font-family: var(--font-ui);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-primary);
}
.banner-instructions { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; line-height: 1.5; }

/* ── Deposit bonus hints (bespoke) ────────────────────────────── */
.deposit-bonus-hints {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.deposit-bonus-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12.5px;
  color: var(--brand-primary);
}

/* ── Receipt drop zone (bespoke) ──────────────────────────────── */
.file-drop {
  border: 2px dashed var(--surface-border);
  border-radius: var(--radius-md, 12px);
  min-height: 110px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: border-color 0.18s, background 0.18s;
  overflow: hidden;
  padding: 10px;
}
.file-drop:hover {
  border-color: color-mix(in srgb, var(--brand-primary) 60%, transparent);
  background: color-mix(in srgb, var(--brand-primary) 5%, transparent);
}
.drop-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}
.drop-hint .icon { font-size: 2rem; }
.preview-img { max-height: 200px; max-width: 100%; object-fit: contain; border-radius: 8px; }
.hidden-input { display: none; }
</style>
