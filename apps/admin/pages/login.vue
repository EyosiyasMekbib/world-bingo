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
// Brand logos load from remote storage; if the URL 404s or is blocked, fall
// back to the wordmark/initial instead of a broken-image glyph.
const logoFailed = ref(false)
const showLogo = computed(() => !!brand.value.logoUrl && !logoFailed.value)
const initial = computed(() => (brand.value.displayName?.[0] ?? 'A').toUpperCase())

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
    <aside class="brand-side">
      <div class="brand-grid" aria-hidden="true" />
      <div class="brand-rings" aria-hidden="true">
        <span class="ring ring--1" />
        <span class="ring ring--2" />
        <span class="ring ring--3" />
        <span class="ring ring--4" />
      </div>

      <div class="brand-content">
        <div class="brand-mark">
          <img
            v-if="showLogo"
            :src="brand.logoUrl"
            :alt="brand.displayName"
            class="brand-img"
            decoding="async"
            @error="logoFailed = true"
          />
          <span v-else class="brand-initial">{{ initial }}</span>
        </div>

        <div class="brand-copy">
          <p class="brand-eyebrow"><span class="dot" />Admin Console</p>
          <h1 class="brand-name">{{ brand.displayName }}</h1>
          <p class="brand-tagline">Operations &amp; control center</p>
        </div>
      </div>

      <footer class="brand-foot" aria-hidden="true">
        <span class="foot-key">{{ initial }}</span>
        <span>{{ brand.displayName }} · Back office</span>
      </footer>
    </aside>

    <!-- ── Right: form panel ─────────────────────────────────────────── -->
    <main class="form-side">
      <!-- Mobile-only brand stamp -->
      <div class="mobile-brand">
        <BrandLogo :height="32" />
      </div>

      <div class="form-box">
        <header class="form-header">
          <p class="form-eyebrow">Secure access</p>
          <h2 class="form-heading">Sign in to continue</h2>
          <span class="header-rule" />
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
            <svg v-if="!loading" class="btn-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 10h11m0 0-4-4m4 4-4 4" />
            </svg>
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
/* ── Shell: asymmetric split ─────────────────────────────────────────── */
.shell {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 44% 56%;
  background: var(--surface-base);
}

/* ── Brand side ──────────────────────────────────────────────────────── */
.brand-side {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 56px;
  overflow: hidden;
  border-right: 1px solid var(--surface-border);
  background:
    radial-gradient(130% 110% at 22% 18%,
      color-mix(in srgb, var(--brand-primary) 12%, transparent) 0%,
      transparent 42%),
    radial-gradient(120% 120% at 80% 100%,
      var(--surface-overlay) 0%,
      var(--surface-raised) 38%,
      var(--surface-base) 78%);
}

/* faint engineering grid — pure hairlines, no glow */
.brand-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--surface-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--surface-line) 1px, transparent 1px);
  background-size: 44px 44px;
  -webkit-mask-image: radial-gradient(120% 90% at 30% 30%, #000 0%, transparent 72%);
  mask-image: radial-gradient(120% 90% at 30% 30%, #000 0%, transparent 72%);
  opacity: 0.6;
}

/* concentric rings, border-only, anchored off the lower-right */
.brand-rings {
  position: absolute;
  bottom: -160px;
  right: -160px;
  pointer-events: none;
}
.ring {
  position: absolute;
  bottom: 0;
  right: 0;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--brand-primary) 16%, transparent);
}
.ring--1 { width: 520px; height: 520px; opacity: 0.30; }
.ring--2 { width: 380px; height: 380px; right: 70px; bottom: 70px; opacity: 0.45; }
.ring--3 { width: 250px; height: 250px; right: 135px; bottom: 135px; opacity: 0.6; }
.ring--4 {
  width: 140px; height: 140px; right: 190px; bottom: 190px;
  border-color: color-mix(in srgb, var(--brand-primary) 34%, transparent);
}

/* ── Brand content ───────────────────────────────────────────────────── */
.brand-content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 26px;
  animation: rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.brand-mark {
  width: 92px;
  height: 92px;
  border-radius: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background:
    linear-gradient(160deg,
      color-mix(in srgb, var(--brand-primary) 18%, var(--surface-raised)),
      var(--surface-raised));
  border: 1px solid color-mix(in srgb, var(--brand-primary) 34%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent),
    0 18px 40px -22px color-mix(in srgb, var(--brand-primary) 55%, transparent);
  animation: pop 0.6s 0.05s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.brand-img { width: 62px; height: 62px; object-fit: contain; }

.brand-initial {
  font-family: var(--font-ui);
  font-size: 48px;
  font-weight: 700;
  color: var(--brand-primary);
  line-height: 1;
  letter-spacing: -0.02em;
}

.brand-copy { display: flex; flex-direction: column; gap: 10px; }

.brand-eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--brand-primary);
  margin: 0;
}
.brand-eyebrow .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--brand-primary);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--brand-primary) 18%, transparent);
}

.brand-name {
  font-family: var(--font-ui);
  font-size: clamp(38px, 4.4vw, 60px);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  margin: 0;
  line-height: 0.98;
}

.brand-tagline {
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
  max-width: 30ch;
  line-height: 1.5;
}

.brand-foot {
  position: absolute;
  left: 56px;
  bottom: 40px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.01em;
  animation: rise 0.6s 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.foot-key {
  display: grid;
  place-items: center;
  width: 20px; height: 20px;
  border-radius: 6px;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 26%, transparent);
}

/* ── Form side ───────────────────────────────────────────────────────── */
.form-side {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 48px clamp(32px, 9%, 110px);
  background: var(--surface-base);
}

.mobile-brand { display: none; }

.form-box {
  width: 100%;
  max-width: 372px;
  display: flex;
  flex-direction: column;
  gap: 34px;
}

/* ── Form header ─────────────────────────────────────────────────────── */
.form-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: rise 0.6s 0.08s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.form-eyebrow {
  font-family: var(--font-ui);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--brand-primary);
  margin: 0;
}

.form-heading {
  font-family: var(--font-ui);
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.05;
}

.header-rule {
  width: 44px;
  height: 3px;
  border-radius: 3px;
  margin-top: 4px;
  background: linear-gradient(90deg, var(--brand-primary), color-mix(in srgb, var(--brand-primary) 8%, transparent));
}

/* ── Fields ──────────────────────────────────────────────────────────── */
.form-fields { display: flex; flex-direction: column; gap: 18px; }

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  animation: rise 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.field--1 { animation-delay: 0.15s; }
.field--2 { animation-delay: 0.21s; }
.field--3 { animation-delay: 0.28s; }

.field-label {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.input-wrap { position: relative; display: flex; align-items: center; }

.input-icon {
  position: absolute;
  left: 14px;
  width: 16px; height: 16px;
  color: var(--text-muted);
  pointer-events: none;
  transition: color 0.18s ease;
}

.field-input {
  width: 100%;
  height: 50px;
  padding: 0 16px 0 42px;
  background: color-mix(in srgb, var(--surface-overlay) 65%, var(--surface-base)) !important;
  border: 1px solid var(--surface-border);
  border-radius: 12px;
  font-size: 14px;
  font-family: var(--font-body);
  color: var(--text-primary) !important;
  outline: none;
  -webkit-appearance: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}
.field-input::placeholder { color: var(--text-muted); }

.field-input:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--brand-primary) 28%, var(--surface-border));
}
.field-input:focus {
  border-color: color-mix(in srgb, var(--brand-primary) 60%, transparent);
  background: var(--surface-overlay) !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--brand-primary) 14%, transparent);
}
.input-wrap:focus-within .input-icon { color: var(--brand-primary); }

.field-input:disabled { opacity: 0.45; cursor: not-allowed; }
.field-input--pw { padding-right: 46px; }

.pw-toggle {
  position: absolute;
  right: 9px;
  width: 32px; height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 8px;
  padding: 0;
  transition: color 0.14s ease, background 0.14s ease;
}
.pw-toggle:hover { color: var(--text-primary); background: rgba(255,255,255,0.06); }
.eye-icon { width: 17px; height: 17px; }

/* ── Submit ──────────────────────────────────────────────────────────── */
.submit-btn {
  position: relative;
  width: 100%;
  height: 52px;
  margin-top: 6px;
  border: none;
  border-radius: 12px;
  background: linear-gradient(180deg, var(--brand-primary), color-mix(in srgb, var(--brand-primary) 82%, #000));
  color: var(--text-on-brand, #0a1628);
  font-family: var(--font-ui);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  box-shadow: 0 14px 30px -14px color-mix(in srgb, var(--brand-primary) 70%, transparent);
  transition: transform 0.12s ease, box-shadow 0.2s ease, filter 0.2s ease;
}
/* sheen sweep on hover */
.submit-btn::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.28) 50%, transparent 70%);
  transform: translateX(-120%);
  transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
}
.submit-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 18px 38px -14px color-mix(in srgb, var(--brand-primary) 80%, transparent);
  filter: brightness(1.04);
}
.submit-btn:hover:not(:disabled)::after { transform: translateX(120%); }
.submit-btn:active:not(:disabled) { transform: translateY(0); }
.submit-btn:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
.submit-btn:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 3px; }

.btn-arrow { width: 18px; height: 18px; transition: transform 0.2s ease; }
.submit-btn:hover:not(:disabled) .btn-arrow { transform: translateX(3px); }

.btn-loading { display: flex; align-items: center; gap: 9px; }
.btn-spinner {
  width: 15px; height: 15px;
  border: 2px solid color-mix(in srgb, var(--text-on-brand, #0a1628) 28%, transparent);
  border-top-color: var(--text-on-brand, #0a1628);
  border-radius: 50%;
  animation: spin 0.65s linear infinite;
  flex-shrink: 0;
}

/* ── Footer ──────────────────────────────────────────────────────────── */
.form-footer {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
  animation: rise 0.5s 0.36s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.footer-icon { width: 13px; height: 13px; flex-shrink: 0; }

/* ── Keyframes ───────────────────────────────────────────────────────── */
@keyframes rise {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes pop {
  from { opacity: 0; transform: scale(0.9); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .brand-content, .brand-mark, .form-header, .field, .form-footer, .brand-foot {
    animation: none;
  }
  .submit-btn::after { display: none; }
}

/* ── Mobile: brand panel hidden, form centred ────────────────────────── */
@media (max-width: 767px) {
  .shell { grid-template-columns: 1fr; }
  .brand-side { display: none; }
  .form-side { align-items: center; padding: 40px 24px; }
  .form-box { max-width: 100%; gap: 30px; }
  .mobile-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    animation: rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
}
</style>
