<template>
  <div class="auth-card">
    <!-- Header -->
    <div class="auth-card-header">
      <h1 class="auth-title">Welcome back</h1>
      <p class="auth-subtitle">Sign in to continue playing</p>
    </div>

    <!-- Form -->
    <form class="auth-form" @submit.prevent="handleLogin">
      <div class="field-group">
        <label class="field-label" for="identifier">Phone or Username</label>
        <div class="input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          <input
            id="identifier"
            v-model="form.identifier"
            type="text"
            placeholder="Phone or username"
            autocomplete="username"
            required
            class="auth-input"
          />
        </div>
      </div>

      <div class="field-group">
        <div class="label-row">
          <label class="field-label" for="password">Password</label>
        </div>
        <div class="input-wrap">
          <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <input
            id="password"
            v-model="form.password"
            :type="showPassword ? 'text' : 'password'"
            placeholder="Your password"
            autocomplete="current-password"
            required
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

      <p v-if="errorMsg" class="auth-error" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {{ errorMsg }}
      </p>

      <button type="submit" class="btn-primary-auth" :disabled="loading">
        <span v-if="loading" class="spinner" />
        <span>{{ loading ? 'Signing in…' : 'Sign In' }}</span>
      </button>
    </form>

    <!-- Footer -->
    <p class="auth-footer">
      Don't have an account?
      <NuxtLink to="/auth/register" class="auth-link">Create one →</NuxtLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
definePageMeta({ layout: 'auth' as any })

const auth = useAuthStore()
const router = useRouter()

const form = ref({ identifier: '', password: '' })
const errorMsg = ref('')
const loading = ref(false)
const showPassword = ref(false)

async function handleLogin() {
  loading.value = true
  errorMsg.value = ''
  try {
    await (auth as any).login(form.value)
    await router.push('/')
  } catch (e: any) {
    errorMsg.value = e?.data?.message || 'Invalid credentials. Please try again.'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
/* ── Glass card ─────────────────────────────────────────────────────── */
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

/* ── Form ────────────────────────────────────────────────────────────── */
.auth-form { display: flex; flex-direction: column; gap: 1.1rem; }
.field-group { display: flex; flex-direction: column; gap: 0.45rem; }
.label-row { display: flex; align-items: center; justify-content: space-between; }
.field-label {
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary, #94a3b8);
}

.input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.input-icon {
  position: absolute;
  left: 0.85rem;
  width: 16px; height: 16px;
  color: var(--text-disabled, #475569);
  flex-shrink: 0;
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

.toggle-pass {
  position: absolute;
  right: 0.85rem;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  color: var(--text-disabled, #475569);
  display: flex;
  align-items: center;
  transition: color 0.2s;
}
.toggle-pass:hover { color: var(--text-secondary, #94a3b8); }
.toggle-pass svg { width: 16px; height: 16px; }

/* ── Error ───────────────────────────────────────────────────────────── */
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

/* ── CTA button ──────────────────────────────────────────────────────── */
.btn-primary-auth {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
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

/* Spinner */
.spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(0,0,0,0.3);
  border-top-color: #000;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Footer link ─────────────────────────────────────────────────────── */
.auth-footer {
  text-align: center;
  font-size: 0.875rem;
  color: var(--text-secondary, #94a3b8);
  margin: 0;
}
.auth-link {
  color: var(--brand-primary, #f59e0b);
  font-weight: 600;
  text-decoration: none;
  transition: opacity 0.2s;
}
.auth-link:hover { opacity: 0.8; }
</style>

