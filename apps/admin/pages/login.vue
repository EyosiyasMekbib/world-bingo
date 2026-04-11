<script setup lang="ts">
definePageMeta({
  layout: false
})

const { login } = useAdminAuth()
const toast = useToast()

const form = reactive({
  identifier: '',
  password: ''
})

const loading = ref(false)
const showPassword = ref(false)

const handleLogin = async () => {
  loading.value = true
  try {
    await login(form)
    await navigateTo('/')
  } catch (err: any) {
    toast.add({ title: 'Access denied', description: err.data?.message || 'Invalid credentials', color: 'error' })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-root">
    <!-- Dot grid -->
    <div class="login-grid" aria-hidden="true" />

    <!-- Ambient glows -->
    <div class="login-glow login-glow--amber" aria-hidden="true" />
    <div class="login-glow login-glow--blue" aria-hidden="true" />

    <div class="login-wrap">

      <!-- Brand mark -->
      <div class="login-brand">
        <div class="login-logo-ring">
          <img src="/logo.png" alt="World Bingo" class="login-logo" />
        </div>
        <div class="login-brand-text">
          <span class="login-brand-name">World Bingo</span>
          <span class="login-brand-role">Admin Console</span>
        </div>
      </div>

      <!-- Card -->
      <div class="login-card">
        <div class="login-card-head">
          <span class="login-eyebrow">Secure Access</span>
          <h1 class="login-heading">Sign in to continue</h1>
        </div>

        <form class="login-form" @submit.prevent="handleLogin" novalidate>

          <!-- Identifier -->
          <div class="login-field">
            <label class="login-label" for="login-identifier">Username or Phone</label>
            <div class="login-input-wrap">
              <svg class="login-input-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" />
              </svg>
              <input
                id="login-identifier"
                v-model="form.identifier"
                type="text"
                class="login-input"
                placeholder="kira or +251…"
                autocomplete="username"
                required
              />
            </div>
          </div>

          <!-- Password -->
          <div class="login-field">
            <label class="login-label" for="login-password">Password</label>
            <div class="login-input-wrap">
              <svg class="login-input-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clip-rule="evenodd" />
              </svg>
              <input
                id="login-password"
                v-model="form.password"
                :type="showPassword ? 'text' : 'password'"
                class="login-input login-input--pw"
                placeholder="••••••••"
                autocomplete="current-password"
                required
              />
              <button
                type="button"
                class="login-pw-toggle"
                :aria-label="showPassword ? 'Hide password' : 'Show password'"
                @click="showPassword = !showPassword"
              >
                <svg v-if="!showPassword" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                  <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
                  <path fill-rule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" clip-rule="evenodd" />
                </svg>
                <svg v-else viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4">
                  <path fill-rule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clip-rule="evenodd" />
                  <path d="m10.748 13.93 2.523 2.523a10.048 10.048 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
                </svg>
              </button>
            </div>
          </div>

          <!-- Submit -->
          <button type="submit" class="login-btn" :disabled="loading">
            <span v-if="!loading">Sign In</span>
            <span v-else class="login-btn-loading">
              <span class="login-spinner" aria-hidden="true" />
              Authenticating…
            </span>
          </button>

        </form>
      </div>

      <!-- Footer -->
      <p class="login-footer">
        <svg viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true">
          <path fill-rule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clip-rule="evenodd" />
        </svg>
        Authorized personnel only · All access is logged
      </p>

    </div>
  </div>
</template>

<style scoped>
/* ── Root ──────────────────────────────────────────────────────────────── */
.login-root {
  min-height: 100vh;
  background: var(--surface-base);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 20px;
  position: relative;
  overflow: hidden;
}

/* Subtle dot grid */
.login-grid {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(circle, rgba(190, 210, 240, 0.055) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 50%, black 30%, transparent 100%);
  -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 50%, black 30%, transparent 100%);
  pointer-events: none;
}

/* Ambient glows */
.login-glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(90px);
  pointer-events: none;
}
.login-glow--amber {
  width: 480px;
  height: 280px;
  top: -80px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(245, 158, 11, 0.06);
}
.login-glow--blue {
  width: 360px;
  height: 360px;
  bottom: -120px;
  right: -60px;
  background: rgba(66, 99, 235, 0.07);
}

/* ── Wrap ──────────────────────────────────────────────────────────────── */
.login-wrap {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 384px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
}

/* ── Brand ─────────────────────────────────────────────────────────────── */
.login-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.login-logo-ring {
  width: 60px;
  height: 60px;
  border-radius: 18px;
  background: var(--surface-raised);
  border: 1px solid rgba(245, 158, 11, 0.18);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.05);
}

.login-logo {
  width: 38px;
  height: 38px;
  object-fit: contain;
}

.login-brand-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.login-brand-name {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.login-brand-role {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

/* ── Card ──────────────────────────────────────────────────────────────── */
.login-card {
  width: 100%;
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 16px;
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 22px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.2);
}

.login-card-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.login-eyebrow {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--brand-primary);
}

.login-heading {
  font-size: 19px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.02em;
  margin: 0;
}

/* ── Form ──────────────────────────────────────────────────────────────── */
.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.login-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.login-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.login-input-icon {
  position: absolute;
  left: 11px;
  width: 15px;
  height: 15px;
  color: var(--text-muted);
  flex-shrink: 0;
  pointer-events: none;
}

.login-input {
  width: 100%;
  height: 44px;
  padding: 0 12px 0 36px;
  background: var(--surface-overlay) !important;
  border: 1px solid var(--surface-border);
  border-radius: 9px;
  font-size: 14px;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  color: var(--text-primary) !important;
  outline: none;
  -webkit-appearance: none;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

.login-input::placeholder {
  color: var(--text-muted);
}

.login-input:focus {
  border-color: rgba(245, 158, 11, 0.45);
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.09);
}

.login-input--pw {
  padding-right: 42px;
}

/* Password toggle */
.login-pw-toggle {
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
.login-pw-toggle:hover {
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
}

/* ── Submit button ─────────────────────────────────────────────────────── */
.login-btn {
  width: 100%;
  height: 44px;
  margin-top: 2px;
  border-radius: 9px;
  border: none;
  background: var(--brand-primary);
  color: #111;
  font-size: 14px;
  font-weight: 700;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  letter-spacing: 0.01em;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.12s ease, opacity 0.12s ease, transform 0.1s ease;
}
.login-btn:hover:not(:disabled) {
  background: var(--brand-primary-dim);
}
.login-btn:active:not(:disabled) {
  transform: translateY(1px);
}
.login-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.login-btn:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 3px;
}

.login-btn-loading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.login-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 0, 0, 0.2);
  border-top-color: rgba(0, 0, 0, 0.55);
  border-radius: 50%;
  animation: spin 0.65s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Footer ────────────────────────────────────────────────────────────── */
.login-footer {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
}
</style>
