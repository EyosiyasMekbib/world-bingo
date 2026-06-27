<script setup lang="ts">
import { useBrand } from '~/composables/useBrand'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
definePageMeta({ layout: false as any })

const { login } = useAdminAuth()
const toast = useToast()
const brand = useBrand()

const form = reactive({ identifier: '', password: '' })
const loading = ref(false)
const showPassword = ref(false)

async function handleLogin() {
  loading.value = true
  try {
    await login(form)
    await navigateTo('/')
  } catch (err: any) {
    toast.add({
      title: 'Access denied',
      description: err.data?.message || 'Invalid credentials',
      color: 'error',
    })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="shell">

    <!-- ── Left: brand panel ─────────────────────────────────────────── -->
    <aside class="brand-side" aria-hidden="true">
      <div class="brand-content">
        <div class="brand-mark">
          <img
            v-if="brand.logoUrl"
            :src="brand.logoUrl"
            :alt="brand.displayName"
            class="brand-img"
          />
          <span v-else class="brand-initial">{{ brand.displayName[0] }}</span>
        </div>
        <div class="brand-copy">
          <p class="brand-eyebrow">Admin Console</p>
          <h1 class="brand-name">{{ brand.displayName }}</h1>
        </div>
      </div>
      <!-- Decorative rings — border-only, zero glow -->
      <div class="deco-rings">
        <div class="deco-ring deco-ring--a" />
        <div class="deco-ring deco-ring--b" />
        <div class="deco-ring deco-ring--c" />
      </div>
    </aside>

    <!-- ── Right: form panel ─────────────────────────────────────────── -->
    <main class="form-side">
      <!-- Mobile-only brand stamp -->
      <div class="mobile-brand">
        <img v-if="brand.logoUrl" :src="brand.logoUrl" :alt="brand.displayName" class="mobile-logo" />
        <span v-else class="mobile-wordmark">{{ brand.displayName }}</span>
      </div>

      <div class="form-box">
        <header class="form-header">
          <p class="form-eyebrow">Secure Access</p>
          <h2 class="form-heading">Sign in to continue</h2>
        </header>

        <form class="form-fields" novalidate @submit.prevent="handleLogin">

          <!-- Identifier -->
          <div class="field field--1">
            <label class="field-label" for="login-id">Username or Phone</label>
            <div class="input-wrap">
              <svg class="input-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" />
              </svg>
              <input
                id="login-id"
                v-model="form.identifier"
                type="text"
                class="field-input"
                placeholder="kira or +251…"
                autocomplete="username"
                :disabled="loading"
                required
              />
            </div>
          </div>

          <!-- Password -->
          <div class="field field--2">
            <label class="field-label" for="login-pw">Password</label>
            <div class="input-wrap">
              <svg class="input-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clip-rule="evenodd" />
              </svg>
              <input
                id="login-pw"
                v-model="form.password"
                :type="showPassword ? 'text' : 'password'"
                class="field-input field-input--pw"
                placeholder="••••••••"
                autocomplete="current-password"
                :disabled="loading"
                required
              />
              <button
                type="button"
                class="pw-toggle"
                :aria-label="showPassword ? 'Hide password' : 'Show password'"
                @click="showPassword = !showPassword"
              >
                <svg v-if="!showPassword" viewBox="0 0 20 20" fill="currentColor" class="eye-icon">
                  <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                  <path fill-rule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" clip-rule="evenodd" />
                </svg>
                <svg v-else viewBox="0 0 20 20" fill="currentColor" class="eye-icon">
                  <path fill-rule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clip-rule="evenodd" />
                  <path d="m10.748 13.93 2.523 2.523a10.048 10.048 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Submit -->
          <button type="submit" class="submit-btn field--3" :disabled="loading">
            <span v-if="!loading">Sign In</span>
            <span v-else class="btn-loading">
              <span class="btn-spinner" aria-hidden="true" />
              Authenticating…
            </span>
          </button>

        </form>

        <footer class="form-footer">
          <svg viewBox="0 0 16 16" fill="currentColor" class="footer-icon" aria-hidden="true">
            <path fill-rule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clip-rule="evenodd" />
          </svg>
          Authorized personnel only · All access is logged
        </footer>
      </div>
    </main>

  </div>
</template>

<style scoped>
/* ── Shell: 42/58 asymmetric split ──────────────────────────────────── */
.shell {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 42% 58%;
  background: var(--surface-base);
}

/* ── Brand side ──────────────────────────────────────────────────────── */
.brand-side {
  position: relative;
  background: var(--surface-raised);
  border-right: 1px solid var(--surface-border);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.brand-content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 0 40px;
  animation: rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.brand-mark {
  width: 96px;
  height: 96px;
  border-radius: 24px;
  background: color-mix(in srgb, var(--brand-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 28%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.brand-img {
  width: 68px;
  height: 68px;
  object-fit: contain;
}

.brand-initial {
  font-family: var(--font-ui);
  font-size: 46px;
  font-weight: 700;
  color: var(--brand-primary);
  line-height: 1;
  letter-spacing: -0.02em;
}

.brand-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  text-align: center;
}

.brand-eyebrow {
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--brand-primary);
  margin: 0;
  opacity: 0.75;
}

.brand-name {
  font-family: var(--font-ui);
  font-size: clamp(26px, 3vw, 40px);
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.05;
}

/* Decorative concentric rings — border-only, never a shadow/glow */
.deco-rings {
  position: absolute;
  bottom: -100px;
  right: -100px;
  pointer-events: none;
}

.deco-ring {
  position: absolute;
  border-radius: 50%;
}

.deco-ring--a {
  width: 340px;
  height: 340px;
  bottom: 0;
  right: 0;
  border: 1px solid color-mix(in srgb, var(--brand-primary) 16%, transparent);
}

.deco-ring--b {
  width: 230px;
  height: 230px;
  bottom: 55px;
  right: 55px;
  border: 1px solid color-mix(in srgb, var(--brand-primary) 11%, transparent);
}

.deco-ring--c {
  width: 120px;
  height: 120px;
  bottom: 110px;
  right: 110px;
  border: 1px solid color-mix(in srgb, var(--brand-primary) 7%, transparent);
}

/* ── Form side ───────────────────────────────────────────────────────── */
.form-side {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 10% 48px 10%;
}

.mobile-brand { display: none; }

.form-box {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 32px;
}

/* ── Form header ─────────────────────────────────────────────────────── */
.form-header {
  display: flex;
  flex-direction: column;
  gap: 5px;
  animation: rise 0.6s 0.08s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.form-eyebrow {
  font-family: var(--font-ui);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--brand-primary);
  margin: 0;
  opacity: 0.8;
}

.form-heading {
  font-family: var(--font-ui);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.1;
}

/* ── Fields ──────────────────────────────────────────────────────────── */
.form-fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: rise 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.field--1 { animation-delay: 0.14s; }
.field--2 { animation-delay: 0.20s; }
.field--3 { animation-delay: 0.27s; }

.field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  letter-spacing: 0.01em;
}

.input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.input-icon {
  position: absolute;
  left: 12px;
  width: 15px;
  height: 15px;
  color: var(--text-muted);
  pointer-events: none;
  flex-shrink: 0;
}

.field-input {
  width: 100%;
  height: 46px;
  padding: 0 14px 0 38px;
  background: var(--surface-overlay) !important;
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  font-size: 14px;
  font-family: var(--font-body);
  color: var(--text-primary) !important;
  outline: none;
  -webkit-appearance: none;
  transition: border-color 0.15s cubic-bezier(0.16, 1, 0.3, 1),
              box-shadow 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

.field-input::placeholder { color: var(--text-muted); }

.field-input:focus {
  border-color: color-mix(in srgb, var(--brand-primary) 50%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand-primary) 11%, transparent);
}

.field-input:disabled { opacity: 0.45; cursor: not-allowed; }
.field-input--pw { padding-right: 42px; }

.pw-toggle {
  position: absolute;
  right: 8px;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
  padding: 0;
  transition: color 0.12s ease, background 0.12s ease;
}
.pw-toggle:hover { color: var(--text-secondary); background: rgba(255,255,255,0.05); }

.eye-icon { width: 16px; height: 16px; }

/* ── Submit ──────────────────────────────────────────────────────────── */
.submit-btn {
  width: 100%;
  height: 48px;
  margin-top: 4px;
  border: none;
  border-radius: 10px;
  background: var(--brand-primary);
  color: var(--text-on-brand, #0a1628);
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.15s ease, transform 0.1s ease;
}

.submit-btn:hover:not(:disabled) { background: var(--brand-primary-dim); }
.submit-btn:active:not(:disabled) { transform: scale(0.98); }
.submit-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.submit-btn:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 3px; }

.btn-loading { display: flex; align-items: center; gap: 8px; }

.btn-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, var(--text-on-brand, #0a1628) 25%, transparent);
  border-top-color: var(--text-on-brand, #0a1628);
  border-radius: 50%;
  animation: spin 0.65s linear infinite;
  flex-shrink: 0;
}

/* ── Footer ──────────────────────────────────────────────────────────── */
.form-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
  letter-spacing: 0.01em;
  animation: rise 0.5s 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.footer-icon { width: 12px; height: 12px; flex-shrink: 0; }

/* ── Keyframes ───────────────────────────────────────────────────────── */
@keyframes rise {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes spin { to { transform: rotate(360deg); } }

/* ── Mobile: brand panel hidden, form centred ────────────────────────── */
@media (max-width: 767px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .brand-side { display: none; }

  .form-side {
    align-items: center;
    padding: 40px 24px;
  }

  .form-box {
    max-width: 100%;
    gap: 28px;
  }

  .mobile-brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .mobile-logo {
    height: 30px;
    object-fit: contain;
  }

  .mobile-wordmark {
    font-family: var(--font-ui);
    font-size: 20px;
    font-weight: 700;
    color: var(--brand-primary);
    letter-spacing: -0.01em;
  }
}
</style>
