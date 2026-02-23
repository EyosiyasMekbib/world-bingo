<template>
  <div class="auth-card">
    <div class="auth-card-header">
      <h1 class="auth-title">Create account</h1>
      <p class="auth-subtitle">Join World Bingo and start winning</p>
    </div>

    <form class="auth-form" @submit.prevent="handleRegister">
      <!-- Username -->
      <div class="field-group">
        <label class="field-label" for="username">Username</label>
        <div class="input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          <input id="username" v-model="form.username" type="text" placeholder="Pick a username" required autocomplete="username" class="auth-input" />
        </div>
      </div>

      <!-- Phone -->
      <div class="field-group">
        <label class="field-label" for="phone">Phone Number</label>
        <div class="input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
          <input id="phone" v-model="form.phone" type="tel" placeholder="+251912345678" required autocomplete="tel" class="auth-input" />
        </div>
      </div>

      <!-- Password -->
      <div class="field-group">
        <label class="field-label" for="reg-password">Password</label>
        <div class="input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <input
            id="reg-password"
            v-model="form.password"
            :type="showPassword ? 'text' : 'password'"
            placeholder="Min 6 characters"
            required
            autocomplete="new-password"
            class="auth-input"
          />
          <button type="button" class="toggle-pass" :aria-label="showPassword ? 'Hide password' : 'Show password'" @click="showPassword = !showPassword">
            <svg v-if="!showPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Referral Code -->
      <div class="field-group">
        <label class="field-label" for="referral">Referral Code <span class="field-optional">(optional)</span></label>
        <div class="input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
          </svg>
          <input
            id="referral"
            v-model="form.referralCode"
            type="text"
            placeholder="e.g. WB3FA29C"
            maxlength="12"
            class="auth-input referral-input"
          />
        </div>
        <Transition name="badge-pop">
          <span v-if="form.referralCode" class="referral-badge">🎁 Referral code applied!</span>
        </Transition>
      </div>

      <p v-if="error" class="auth-error" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {{ error }}
      </p>

      <button type="submit" class="btn-primary-auth" :disabled="loading">
        <span v-if="loading" class="spinner" />
        <span>{{ loading ? 'Creating account…' : 'Create Account' }}</span>
      </button>
    </form>

    <p class="auth-footer">
      Already have an account?
      <NuxtLink to="/auth/login" class="auth-link">Sign in →</NuxtLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
definePageMeta({ layout: 'auth' as any })

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const loading = ref(false)
const error = ref('')
const showPassword = ref(false)

const form = ref({
  username: '',
  phone: '',
  password: '',
  referralCode: (route.query.ref as string) || '',
})

async function handleRegister() {
  loading.value = true
  error.value = ''
  try {
    await (auth as any).register({
      username: form.value.username,
      phone: form.value.phone,
      password: form.value.password,
      referralCode: form.value.referralCode || undefined,
    })
    await router.push('/')
  } catch (e: any) {
    error.value = e?.data?.message || 'Registration failed. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
/* ── Glass card (shared auth style) ─────────────────────────────────── */
.auth-card {
  background: rgba(17, 24, 39, 0.7);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  padding: 2.25rem 2rem;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.06);
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
}

.auth-card-header { display: flex; flex-direction: column; gap: 0.35rem; }
.auth-title {
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  letter-spacing: -0.02em;
  margin: 0;
}
.auth-subtitle {
  font-size: 0.9rem;
  color: var(--text-secondary, #94a3b8);
  margin: 0;
}

.auth-form { display: flex; flex-direction: column; gap: 1.1rem; }
.field-group { display: flex; flex-direction: column; gap: 0.45rem; }
.field-label {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary, #94a3b8);
}
.field-optional { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-disabled, #475569); }

.input-wrap { position: relative; display: flex; align-items: center; }
.input-icon {
  position: absolute;
  left: 0.85rem;
  width: 16px; height: 16px;
  color: var(--text-disabled, #475569);
  pointer-events: none;
}
.auth-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 0.7rem 2.75rem 0.7rem 2.5rem;
  font-size: 0.95rem;
  font-family: inherit;
  color: var(--text-primary, #f1f5f9);
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
}
.auth-input::placeholder { color: var(--text-disabled, #475569); }
.auth-input:focus {
  border-color: var(--brand-primary, #f59e0b);
  background: rgba(245, 158, 11, 0.04);
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.12);
}
.referral-input { text-transform: uppercase; font-family: var(--font-game, 'Rajdhani', monospace); letter-spacing: 0.08em; }

.toggle-pass {
  position: absolute;
  right: 0.85rem;
  background: none; border: none; cursor: pointer; padding: 0;
  color: var(--text-disabled, #475569);
  display: flex; align-items: center;
  transition: color 0.2s;
}
.toggle-pass:hover { color: var(--text-secondary, #94a3b8); }
.toggle-pass svg { width: 16px; height: 16px; }

.referral-badge {
  font-size: 0.78rem;
  font-weight: 600;
  color: #34d399;
  display: inline-block;
}
.badge-pop-enter-active { transition: all 0.25s var(--ease-bounce, cubic-bezier(0.34,1.56,0.64,1)); }
.badge-pop-enter-from { opacity: 0; transform: translateY(-6px) scale(0.9); }
.badge-pop-leave-active { transition: opacity 0.15s; }
.badge-pop-leave-to { opacity: 0; }

.auth-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: #f87171;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
  padding: 0.55rem 0.75rem;
  margin: 0;
}
.auth-error svg { width: 15px; height: 15px; flex-shrink: 0; }

.btn-primary-auth {
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  width: 100%;
  padding: 0.8rem 1.5rem;
  background: var(--brand-primary, #f59e0b);
  color: #000;
  font-weight: 700;
  font-size: 0.95rem;
  font-family: inherit;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  margin-top: 0.25rem;
  transition: background 0.2s, box-shadow 0.2s, transform 0.15s;
  box-shadow: 0 0 20px rgba(245, 158, 11, 0.25);
}
.btn-primary-auth:hover:not(:disabled) {
  background: #fbbf24;
  box-shadow: 0 0 30px rgba(245, 158, 11, 0.4);
  transform: translateY(-1px);
}
.btn-primary-auth:active:not(:disabled) { transform: translateY(0); }
.btn-primary-auth:disabled { opacity: 0.45; cursor: not-allowed; }

.spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(0,0,0,0.3);
  border-top-color: #000;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.auth-footer { text-align: center; font-size: 0.875rem; color: var(--text-secondary, #94a3b8); margin: 0; }
.auth-link { color: var(--brand-primary, #f59e0b); font-weight: 600; text-decoration: none; transition: opacity 0.2s; }
.auth-link:hover { opacity: 0.8; }
</style>
