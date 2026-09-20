<template>
  <div class="auth-card">
    <div class="auth-hero">
      <BrandLogo :height="48" />
      <h1 class="auth-title">{{ t('auth.resetPassword.title') }}</h1>
      <p class="auth-subtitle">{{ t('auth.resetPassword.subtitle') }}</p>
    </div>

    <!-- novalidate: errors render inline, same as login and set-password. -->
    <form novalidate @submit.prevent="handleSubmit">
      <div class="wb-field">
        <label class="wb-label" for="new-password">{{ t('auth.resetPassword.new') }}</label>
        <input
          id="new-password"
          v-model="form.newPassword"
          :type="showPasswords ? 'text' : 'password'"
          autocomplete="new-password"
          :placeholder="t('auth.resetPassword.newPlaceholder')"
          class="wb-input"
          :disabled="loading"
        />
      </div>

      <div class="wb-field">
        <label class="wb-label" for="confirm-password">{{ t('auth.resetPassword.confirm') }}</label>
        <input
          id="confirm-password"
          v-model="form.confirmPassword"
          :type="showPasswords ? 'text' : 'password'"
          autocomplete="new-password"
          :placeholder="t('auth.resetPassword.confirmPlaceholder')"
          class="wb-input"
          :disabled="loading"
        />
      </div>

      <label class="show-toggle">
        <input v-model="showPasswords" type="checkbox" />
        <span>{{ t('auth.resetPassword.showPasswords') }}</span>
      </label>

      <p v-if="errorMsg" class="auth-error" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        {{ errorMsg }}
      </p>

      <button type="submit" class="btn-primary-auth" :disabled="loading || !hasToken">
        <span v-if="loading" class="spinner" />
        <span>{{ loading ? t('auth.resetPassword.saving') : t('auth.resetPassword.submit') }}</span>
      </button>
    </form>

    <NuxtLink to="/auth/login" class="auth-signout">
      {{ t('auth.resetPassword.backToLogin') }}
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'
import { validateResetPasswordForm, type ResetPasswordFormError } from '~/utils/password-change'
import { describeFailure } from '~/utils/http-failure'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
definePageMeta({ layout: 'auth' as any })

const auth = useAuthStore()
const route = useRoute()
const { t } = useI18n()
const { track } = useAnalytics()

// Read once, at load: the token is single-use and the query string does not
// change under this page, so there is nothing to react to.
const token = typeof route.query.token === 'string' ? route.query.token : ''
const hasToken = token.length > 0

const form = reactive({ newPassword: '', confirmPassword: '' })
const showPasswords = ref(false)
const loading = ref(false)
const errorMsg = ref(hasToken ? '' : t('auth.resetPassword.errors.invalidToken'))

const VALIDATION_KEYS: Record<ResetPasswordFormError, string> = {
  new_short: 'auth.resetPassword.errors.newShort',
  mismatch: 'auth.resetPassword.errors.mismatch',
}

async function handleSubmit() {
  errorMsg.value = ''
  if (!hasToken) {
    errorMsg.value = t('auth.resetPassword.errors.invalidToken')
    return
  }
  const invalid = validateResetPasswordForm(form)
  if (invalid) {
    errorMsg.value = t(VALIDATION_KEYS[invalid])
    return
  }
  loading.value = true
  try {
    await auth.consumePasswordReset({ token, newPassword: form.newPassword })
    track('password_reset_via_telegram')
    await navigateTo('/')
  } catch (e: any) {
    const failure = describeFailure(e)
    const code = e?.data?.code
    track('password_reset_via_telegram_failed', { reason: code ?? failure.code, status: failure.status })
    errorMsg.value =
      code === 'invalid_token'
        ? t('auth.resetPassword.errors.invalidToken')
        : t('auth.resetPassword.errors.failed')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.auth-card {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-xl, 24px);
  padding: 2.5rem 2rem 2rem;
  box-shadow: var(--shadow-modal, 0 20px 60px rgba(0, 0, 0, 0.6));
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.auth-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  text-align: center;
}

.auth-title {
  font-family: var(--font-ui);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}

.auth-subtitle {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-secondary);
  margin: 0;
}

.show-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  margin-top: -4px;
}

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
.auth-error svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

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
  transition:
    background 0.2s,
    box-shadow 0.2s;
}
.btn-primary-auth:hover:not(:disabled) {
  background: color-mix(in srgb, var(--brand-primary) 90%, white);
  box-shadow: 0 10px 26px color-mix(in srgb, var(--brand-primary) 38%, transparent);
}
.btn-primary-auth:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(0, 0, 0, 0.3);
  border-top-color: #000;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.auth-signout {
  align-self: center;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  font-family: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.auth-signout:hover {
  color: var(--text-primary);
}
</style>
