<template>
  <div class="auth-card">
    <!-- Logo + Header -->
    <div class="auth-hero">
      <NuxtLink to="/">
        <img src="/logo.png" alt="Arada Bingo" class="auth-logo-img" />
      </NuxtLink>
      <p class="auth-subtitle">Create your account</p>
    </div>

    <div class="auth-actions">
      <form @submit.prevent="handleRegister">
        <div class="wb-field">
          <label class="wb-label" for="username">Username</label>
          <input
            id="username"
            v-model="form.username"
            type="text"
            autocomplete="username"
            placeholder="2–32 characters"
            class="wb-input"
            :disabled="loading"
            required
            minlength="2"
            maxlength="32"
          />
        </div>

        <div class="wb-field">
          <label class="wb-label" for="phone">Phone Number</label>
          <input
            id="phone"
            v-model="form.phone"
            type="tel"
            autocomplete="tel"
            placeholder="e.g. 0911234567"
            class="wb-input"
            :disabled="loading"
            required
            minlength="9"
            maxlength="15"
          />
        </div>

        <div class="wb-field">
          <label class="wb-label" for="password">Password</label>
          <div class="input-wrap">
            <input
              id="password"
              v-model="form.password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="new-password"
              placeholder="Min. 6 characters"
              class="wb-input"
              :disabled="loading"
              required
              minlength="6"
            />
            <button type="button" class="eye-btn" tabindex="-1" @click="showPassword = !showPassword">
              <svg v-if="showPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88L6.59 6.59m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Referral code (collapsible) -->
        <div class="referral-toggle-wrap">
          <button type="button" class="referral-toggle" @click="showReferral = !showReferral">
            {{ showReferral ? '− Hide referral code' : '+ Have a referral code?' }}
          </button>
        </div>
        <div v-if="showReferral" class="wb-field">
          <label class="wb-label" for="referralCode">Referral Code</label>
          <input
            id="referralCode"
            v-model="form.referralCode"
            type="text"
            placeholder="6–12 characters (optional)"
            class="wb-input"
            :disabled="loading"
            minlength="6"
            maxlength="12"
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
          <span>{{ loading ? 'Creating account…' : 'Create Account' }}</span>
        </button>
      </form>

      <p class="auth-footer-link">
        Already have an account?
        <NuxtLink to="/auth/login">Sign In</NuxtLink>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
definePageMeta({ layout: 'auth' as any })

const auth = useAuthStore()
const router = useRouter()
const errorMsg = ref('')
const loading = ref(false)
const showPassword = ref(false)
const showReferral = ref(false)

const form = reactive({
  username: '',
  phone: '',
  password: '',
  referralCode: '',
})

async function handleRegister() {
  errorMsg.value = ''

  // client-side validation
  if (form.username.length < 2 || form.username.length > 32) {
    errorMsg.value = 'Username must be 2–32 characters.'
    return
  }
  if (form.phone.length < 9 || form.phone.length > 15) {
    errorMsg.value = 'Phone number must be 9–15 digits.'
    return
  }
  if (form.password.length < 6) {
    errorMsg.value = 'Password must be at least 6 characters.'
    return
  }
  if (form.referralCode && (form.referralCode.length < 6 || form.referralCode.length > 12)) {
    errorMsg.value = 'Referral code must be 6–12 characters.'
    return
  }

  loading.value = true
  try {
    await auth.register({
      username: form.username,
      phone: form.phone,
      password: form.password,
      ...(form.referralCode ? { referralCode: form.referralCode } : {}),
    })
    await router.push('/')
  } catch (e: any) {
    errorMsg.value = e?.data?.message || 'Registration failed. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
form { display: flex; flex-direction: column; gap: 16px; }

/* ── Card ───────────────────────────────────────────────────────────── */
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

/* ── Hero ───────────────────────────────────────────────────────────── */
.auth-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  text-align: center;
}

.auth-logo-img {
  height: 8vh;
  object-fit: contain;
}

.auth-subtitle {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0;
}

/* ── Actions ─────────────────────────────────────────────────────────── */
.auth-actions { display: flex; flex-direction: column; gap: 1rem; }

/* ── Password field eye toggle ───────────────────────────────────────── */
.input-wrap { position: relative; }
.input-wrap .wb-input { padding-right: 2.75rem; }

.eye-btn {
  position: absolute;
  right: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
}
.eye-btn svg { width: 16px; height: 16px; }
.eye-btn:hover { color: var(--brand-primary); }

/* ── Referral toggle ─────────────────────────────────────────────────── */
.referral-toggle-wrap { margin: -2px 0 2px; }

.referral-toggle {
  background: none;
  border: none;
  padding: 0;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--brand-primary);
  cursor: pointer;
  text-underline-offset: 3px;
}
.referral-toggle:hover { text-decoration: underline; }

/* ── Error ───────────────────────────────────────────────────────────── */
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

/* ── CTA button ──────────────────────────────────────────────────────── */
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

/* Spinner */
.spinner {
  width: 16px; height: 16px;
  border: 2px solid color-mix(in srgb, var(--text-on-brand) 30%, transparent);
  border-top-color: var(--text-on-brand);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Footer link ─────────────────────────────────────────────────────── */
.auth-footer-link {
  margin: 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
}
.auth-footer-link a {
  color: var(--brand-primary);
  font-weight: 700;
  text-decoration: none;
}
.auth-footer-link a:hover { text-decoration: underline; }
</style>
