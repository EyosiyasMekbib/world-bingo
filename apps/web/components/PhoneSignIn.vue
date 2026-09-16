<template>
  <div class="phone-auth">
    <!-- Every brand deployment carries its own Firebase project. With none
         configured there is no form worth showing: password sign-in is gone,
         so this is the whole door. -->
    <p v-if="!isConfigured" class="auth-error" role="alert">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      Phone sign-in is not available right now. Please contact support.
    </p>

    <!-- ── Step 1: the number ──────────────────────────────────────────── -->
    <!-- novalidate: the native required/minlength bubble is a tooltip with no
         DOM change, which replay records as a dead click on the button.
         Errors render inline and are tracked. -->
    <form v-else-if="step === 'phone'" novalidate @submit.prevent="handleSend">
      <div class="wb-field">
        <label class="wb-label" for="phone">Phone Number</label>
        <input
          id="phone"
          ref="phoneEl"
          v-model="form.phone"
          type="tel"
          inputmode="tel"
          autocomplete="tel"
          placeholder="e.g. 0911234567"
          class="wb-input"
          :disabled="loading"
        />
      </div>

      <slot name="extra-fields" />

      <p v-if="errorMsg" class="auth-error" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {{ errorMsg }}
      </p>

      <button type="submit" class="btn-primary-auth wb-btn--block" :disabled="loading">
        <span v-if="loading" class="spinner" />
        <span>{{ loading ? 'Sending code…' : 'Send code' }}</span>
      </button>

      <p class="auth-hint">We'll send you a 6-digit code by SMS.</p>
    </form>

    <!-- ── Step 2: the code ────────────────────────────────────────────── -->
    <form v-else novalidate @submit.prevent="handleVerify">
      <!-- data-ph-mask: the player's own number must not land in a replay. -->
      <p class="auth-hint">
        Code sent to <strong data-ph-mask>{{ sentTo }}</strong>
      </p>

      <div class="wb-field">
        <label class="wb-label" for="code">6-digit code</label>
        <input
          id="code"
          ref="codeEl"
          v-model="form.code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="123456"
          maxlength="6"
          class="wb-input code-input"
          :disabled="loading"
        />
      </div>

      <p v-if="errorMsg" class="auth-error" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {{ errorMsg }}
      </p>

      <button type="submit" class="btn-primary-auth wb-btn--block" :disabled="loading">
        <span v-if="loading" class="spinner" />
        <span>{{ loading ? 'Verifying…' : 'Verify and continue' }}</span>
      </button>

      <div class="code-actions">
        <button type="button" class="wb-switch" :disabled="loading" @click="backToNumber">
          Change number
        </button>
        <button type="button" class="wb-switch" :disabled="loading || resendIn > 0" @click="handleResend">
          {{ resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code' }}
        </button>
      </div>
    </form>

    <!-- The invisible reCAPTCHA lives here and must outlive the step switch
         above: Firebase holds a reference to this node from the moment the
         first code is requested until the last one is confirmed. -->
    <div ref="recaptchaEl" class="recaptcha-host" />
  </div>
</template>

<script setup lang="ts">
import { formatEtPhone } from '@world-bingo/shared-types'
import { useAuthStore } from '~/store/auth'
import {
  applyAutofill,
  validateCodeForm,
  validatePhoneForm,
  type CodeFormError,
  type PhoneFormError,
} from '~/utils/auth-form'
import { describeFailure } from '~/utils/http-failure'

/**
 * The SMS sign-in form, shared by /auth/login and /auth/register — the two are
 * the same call now. The server verifies the Firebase token and either signs
 * the player in or creates the account; the client is never told which, and
 * does not need to be.
 */
const props = defineProps<{
  /** Applied only when this sign-in actually creates an account. */
  referralCode?: string
}>()

const emit = defineEmits<{ (e: 'authenticated'): void }>()

const auth = useAuthStore()
const { t } = useI18n()
const { track } = useAnalytics()
const { isConfigured, sendCode, confirmCode, reset, describeError } = useFirebasePhoneAuth()

/** Seconds before a second SMS may be requested. Firebase meters these. */
const RESEND_COOLDOWN_S = 60

const step = ref<'phone' | 'code'>('phone')
const loading = ref(false)
const errorMsg = ref('')
const sentTo = ref('')
const resendIn = ref(0)

const form = reactive({ phone: '', code: '' })

// Some Android browsers autofill without firing `input`, so v-model stays
// empty while the box shows a value; applyAutofill reads the DOM back. The
// code field is an autofill target too — Android offers the SMS code itself.
const phoneEl = ref<HTMLInputElement | null>(null)
const codeEl = ref<HTMLInputElement | null>(null)
const recaptchaEl = ref<HTMLElement | null>(null)

const PHONE_MESSAGES: Record<PhoneFormError, string> = {
  phone_required: 'Enter your phone number.',
  phone_invalid: 'Enter a valid Ethiopian phone number, e.g. 0911234567.',
}

const CODE_MESSAGES: Record<CodeFormError, string> = {
  code_required: 'Enter the 6-digit code from the SMS.',
  code_invalid: 'The code is 6 digits.',
}

let resendTimer: ReturnType<typeof setInterval> | null = null

function startResendCooldown() {
  resendIn.value = RESEND_COOLDOWN_S
  if (resendTimer) clearInterval(resendTimer)
  resendTimer = setInterval(() => {
    resendIn.value = Math.max(0, resendIn.value - 1)
    if (resendIn.value === 0 && resendTimer) {
      clearInterval(resendTimer)
      resendTimer = null
    }
  }, 1000)
}

onBeforeUnmount(() => {
  if (resendTimer) clearInterval(resendTimer)
  reset()
})

/** Requests the SMS. Shared by the first send and the resend button. */
async function requestCode(): Promise<boolean> {
  errorMsg.value = ''
  applyAutofill(form, { phone: phoneEl.value })

  const invalid = validatePhoneForm(form)
  if (invalid) {
    errorMsg.value = PHONE_MESSAGES[invalid]
    track('login_failed', { method: 'phone', reason: invalid, status: null })
    return false
  }
  if (!recaptchaEl.value) {
    errorMsg.value = 'Sign-in could not start. Please reload the page.'
    return false
  }

  loading.value = true
  try {
    await sendCode(form.phone, recaptchaEl.value)
    sentTo.value = formatEtPhone(form.phone)
    startResendCooldown()
    track('otp_requested', { method: 'phone' })
    return true
  } catch (e: unknown) {
    const failure = describeError(e)
    errorMsg.value = failure.message
    track('login_failed', { method: 'phone', reason: failure.code, status: null })
    return false
  } finally {
    loading.value = false
  }
}

async function handleSend() {
  if (await requestCode()) {
    step.value = 'code'
    // The player's next keystroke belongs in the code box, not back in the
    // number they just confirmed.
    await nextTick()
    codeEl.value?.focus()
  }
}

async function handleResend() {
  form.code = ''
  await requestCode()
}

function backToNumber() {
  reset()
  form.code = ''
  errorMsg.value = ''
  step.value = 'phone'
}

async function handleVerify() {
  errorMsg.value = ''
  applyAutofill(form, { code: codeEl.value })

  const invalid = validateCodeForm(form)
  if (invalid) {
    errorMsg.value = CODE_MESSAGES[invalid]
    track('login_failed', { method: 'phone', reason: invalid, status: null })
    return
  }

  loading.value = true
  try {
    // Two separate failures with one spinner: Firebase rejecting the code, and
    // our API rejecting the token it produced. They read differently to the
    // player, so they are caught separately below.
    const idToken = await confirmCode(form.code)

    try {
      await auth.phoneLogin({
        idToken,
        ...(props.referralCode ? { referralCode: props.referralCode } : {}),
      })
    } catch (e: any) {
      const failure = describeFailure(e)
      track('login_failed', { method: 'phone', reason: failure.code, status: failure.status })
      errorMsg.value =
        failure.code === 'account_suspended'
          ? t('wallet.accountSuspended')
          : failure.message || 'Sign-in failed. Please try again.'
      // The Firebase code is spent either way — a retry has to start over.
      backToNumber()
      return
    }

    emit('authenticated')
  } catch (e: unknown) {
    const failure = describeError(e)
    errorMsg.value = failure.message
    track('login_failed', { method: 'phone', reason: failure.code, status: null })
    // An expired or over-quota code cannot be retyped into anything that
    // works; send the player back to request a fresh one.
    if (!failure.retryable) backToNumber()
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.phone-auth { display: flex; flex-direction: column; gap: 1rem; }
form { display: flex; flex-direction: column; gap: 16px; }

.auth-hint {
  font-family: var(--font-ui);
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  text-align: center;
}

.code-input {
  letter-spacing: 0.5em;
  text-align: center;
  font-size: 20px;
}

.code-actions {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}

.wb-switch {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-primary, #f59e0b);
}
.wb-switch:disabled { color: var(--text-secondary); cursor: default; }

/* Invisible reCAPTCHA: no box of its own, but it must stay in the DOM. A
   challenge Firebase decides to show renders in an overlay, not here. */
.recaptcha-host { display: block; }

.auth-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 13px;
  color: var(--status-error);
  background: color-mix(in srgb, var(--status-error) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-error) 32%, transparent);
  border-radius: var(--radius-md, 12px);
  padding: 0.6rem 0.85rem;
  margin: 0;
}
.auth-error svg { width: 15px; height: 15px; flex-shrink: 0; }

/* Same CTA as the Telegram button beside it on /auth/login — that one is
   styled by the page, this one by the component that owns it. */
.btn-primary-auth {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.85rem 1.5rem;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  border: none;
  border-radius: var(--radius-md, 12px);
  cursor: pointer;
  margin-top: 0.25rem;
  transition: background 0.2s, box-shadow 0.2s, transform 0.15s;
}
.btn-primary-auth:hover:not(:disabled) {
  background: color-mix(in srgb, var(--brand-primary) 90%, white);
  box-shadow: 0 10px 26px color-mix(in srgb, var(--brand-primary) 38%, transparent);
  transform: translateY(-1px);
}
.btn-primary-auth:active:not(:disabled) { transform: translateY(0); }
.btn-primary-auth:disabled { opacity: 0.45; cursor: not-allowed; }

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }
</style>
