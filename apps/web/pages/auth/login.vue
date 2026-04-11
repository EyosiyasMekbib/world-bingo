<template>
  <div class="auth-card">
    <!-- Logo + Header -->
    <div class="auth-hero">
      <NuxtLink to="/">
        <img src="/logo.png" alt="Arada Bingo" class="auth-logo-img" />
      </NuxtLink>
      <p class="auth-subtitle">Sign in to continue playing</p>
    </div>

    <!-- Tab switcher -->
    <div class="auth-tabs">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'credentials' }"
        @click="activeTab = 'credentials'; errorMsg = ''"
      >
        Sign In
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'telegram' }"
        @click="activeTab = 'telegram'; errorMsg = ''"
      >
        <svg class="tg-tab-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248-2.04 9.61c-.152.68-.552.847-1.118.527l-3.09-2.276-1.49 1.434c-.165.165-.303.303-.62.303l.22-3.134 5.694-5.144c.247-.22-.054-.342-.385-.122L7.08 14.516l-3.04-.95c-.66-.207-.674-.66.138-.977l11.87-4.577c.55-.2 1.03.134.514.236z" />
        </svg>
        Telegram
      </button>
    </div>

    <!-- ── Username / Password tab ──────────────────────────────────── -->
    <div v-if="activeTab === 'credentials'" class="auth-actions">
      <form @submit.prevent="handleCredentialsLogin">
        <div class="field">
          <label class="field-label" for="identifier">Username or Phone</label>
          <input
            id="identifier"
            v-model="form.identifier"
            type="text"
            autocomplete="username"
            placeholder="e.g. john_doe or 0911234567"
            class="field-input"
            :disabled="loading"
            required
          />
        </div>
        <div class="field">
          <label class="field-label" for="password">Password</label>
          <div class="input-wrap">
            <input
              id="password"
              v-model="form.password"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder="Min. 6 characters"
              class="field-input"
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

      <p class="auth-footer-link">
        Don't have an account?
        <NuxtLink to="/auth/register">Register</NuxtLink>
      </p>
    </div>

    <!-- ── Telegram tab ──────────────────────────────────────────────── -->
    <div v-else class="auth-actions">
      <!-- Welcome-back block (returning user with expired session) -->
      <div v-if="showWelcomeBack" class="welcome-back">
        <div class="wb-avatar">
          <img v-if="auth.user!.photoUrl" :src="auth.user!.photoUrl" class="wb-photo" alt="Profile" />
          <span v-else>{{ (auth.user!.firstName ?? auth.user!.username ?? 'U')[0].toUpperCase() }}</span>
        </div>
        <p class="wb-name">
          Welcome back,<br>
          <strong>{{ auth.user!.firstName ?? auth.user!.telegramUsername ?? auth.user!.username }}</strong>
        </p>
        <button class="btn-primary-auth" :disabled="loading" @click="openTelegramAuth">
          <span v-if="loading" class="spinner" />
          <span>{{ loading ? 'Connecting…' : `Continue as ${auth.user!.firstName ?? auth.user!.username}` }}</span>
        </button>
        <button class="wb-switch" @click="auth.clearStoredUser()">
          Sign in as different user
        </button>
      </div>

      <!-- Default Telegram login button -->
      <template v-else>
        <button class="btn-primary-auth btn-telegram" :disabled="loading" @click="openTelegramAuth">
          <span v-if="loading" class="spinner" />
          <svg v-else class="tg-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248-2.04 9.61c-.152.68-.552.847-1.118.527l-3.09-2.276-1.49 1.434c-.165.165-.303.303-.62.303l.22-3.134 5.694-5.144c.247-.22-.054-.342-.385-.122L7.08 14.516l-3.04-.95c-.66-.207-.674-.66.138-.977l11.87-4.577c.55-.2 1.03.134.514.236z" />
          </svg>
          <span>{{ loading ? 'Connecting…' : 'Continue with Telegram' }}</span>
        </button>
      </template>

      <p v-if="errorMsg" class="auth-error" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {{ errorMsg }}
      </p>

      <p class="auth-footer-link">
        Don't have an account?
        <NuxtLink to="/auth/register">Register</NuxtLink>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'
import type { TelegramAuthDto } from '@world-bingo/shared-types'

declare global {
  interface Window {
    __worldBingoTelegramAuth: (user: TelegramAuthDto) => void
    Telegram?: { Login: { auth: (opts: { bot_id: number; request_access: boolean }, cb: (user: TelegramAuthDto | false) => void) => void } }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
definePageMeta({ layout: 'auth' as any })

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const config = useRuntimeConfig()
const errorMsg = ref('')
const loading = ref(false)
const showPassword = ref(false)
const activeTab = ref<'credentials' | 'telegram'>('credentials')

const form = reactive({ identifier: '', password: '' })

const showWelcomeBack = computed(() => !!auth.user && !auth.isAuthenticated)

const redirectPath = computed(() => {
  const r = route.query.redirect
  return typeof r === 'string' && r.startsWith('/') ? r : '/'
})

async function handleCredentialsLogin() {
  errorMsg.value = ''
  loading.value = true
  try {
    await auth.login({ identifier: form.identifier, password: form.password })
    await router.push(redirectPath.value)
  } catch (e: any) {
    errorMsg.value = e?.data?.message || 'Invalid credentials. Please try again.'
  } finally {
    loading.value = false
  }
}

function handleTelegramCallback(user: TelegramAuthDto) {
  loading.value = true
  errorMsg.value = ''
  auth.telegramLogin(user)
    .then(() => router.push(redirectPath.value))
    .catch((e: any) => {
      errorMsg.value = e?.data?.message || 'Authentication failed. Please try again.'
    })
    .finally(() => { loading.value = false })
}

function loadTelegramScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Telegram?.Login) { resolve(); return }
    if (document.getElementById('tg-widget-script')) {
      document.getElementById('tg-widget-script')!.addEventListener('load', () => resolve())
      return
    }
    const script = document.createElement('script')
    script.id = 'tg-widget-script'
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.setAttribute('data-telegram-login', config.public.telegramBotName)
    script.setAttribute('data-request-access', 'write')
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Telegram script'))
    document.head.appendChild(script)
  })
}

async function openTelegramAuth() {
  loading.value = true
  errorMsg.value = ''
  try {
    await loadTelegramScript()
    window.Telegram!.Login.auth(
      { bot_id: Number(config.public.telegramBotId), request_access: true },
      (user) => {
        if (!user) { loading.value = false; return }
        handleTelegramCallback(user)
      },
    )
  } catch {
    errorMsg.value = 'Failed to load Telegram login. Check your connection.'
    loading.value = false
  }
}
</script>

<style scoped>
/* ── Glass card ─────────────────────────────────────────────────────── */
.auth-card {
  background: rgba(17, 24, 39, 0.75);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 24px;
  padding: 2.5rem 2rem 2rem;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.06);
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
  font-size: 0.9rem;
  color: var(--text-secondary, #94a3b8);
  margin: 0;
}

/* ── Tabs ───────────────────────────────────────────────────────────── */
.auth-tabs {
  display: flex;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  padding: 3px;
  gap: 3px;
}

.tab-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.55rem 1rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #94a3b8);
  font-size: 0.875rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.18s, color 0.18s;
}

.tab-btn.active {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.tab-btn:hover:not(.active) {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary, #f1f5f9);
}

.tg-tab-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

/* ── Actions ─────────────────────────────────────────────────────────── */
.auth-actions { display: flex; flex-direction: column; gap: 1rem; }

/* ── Form fields ─────────────────────────────────────────────────────── */
.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}

.field-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary, #94a3b8);
  letter-spacing: 0.02em;
}

.input-wrap {
  position: relative;
}

.field-input {
  width: 100%;
  padding: 0.7rem 0.9rem;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  color: var(--text-primary, #f1f5f9);
  font-size: 0.9rem;
  font-family: inherit;
  transition: border-color 0.2s, background 0.2s;
  outline: none;
  box-sizing: border-box;
}

.input-wrap .field-input {
  padding-right: 2.75rem;
}

.field-input::placeholder {
  color: rgba(148, 163, 184, 0.5);
}

.field-input:focus {
  border-color: rgba(245, 158, 11, 0.5);
  background: rgba(245, 158, 11, 0.04);
}

.field-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.eye-btn {
  position: absolute;
  right: 0.75rem;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--text-secondary, #94a3b8);
  display: flex;
  align-items: center;
}

.eye-btn svg {
  width: 16px;
  height: 16px;
}

.eye-btn:hover {
  color: var(--text-primary, #f1f5f9);
}

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

/* ── CTA buttons ──────────────────────────────────────────────────────── */
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

.btn-telegram {
  background: #2AABEE;
  color: #fff;
  box-shadow: 0 0 20px rgba(42, 171, 238, 0.2);
}
.btn-telegram:hover:not(:disabled) {
  background: #38bdf8;
  box-shadow: 0 0 30px rgba(42, 171, 238, 0.35);
}

.tg-icon { width: 18px; height: 18px; flex-shrink: 0; }

/* Spinner */
.spinner {
  width: 16px; height: 16px;
  border: 2px solid rgba(0,0,0,0.3);
  border-top-color: #000;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
.btn-telegram .spinner {
  border-color: rgba(255,255,255,0.3);
  border-top-color: #fff;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Footer link ─────────────────────────────────────────────────────── */
.auth-footer-link {
  margin: 0;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-secondary, #94a3b8);
}
.auth-footer-link a {
  color: #f59e0b;
  font-weight: 600;
  text-decoration: none;
}
.auth-footer-link a:hover {
  text-decoration: underline;
}

/* ── Welcome-back ────────────────────────────────────────────────────── */
.welcome-back {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  text-align: center;
}

.wb-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: linear-gradient(135deg, #f59e0b, #d97706);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.75rem;
  font-weight: 800;
  color: #000;
  overflow: hidden;
  border: 2px solid rgba(245, 158, 11, 0.4);
  flex-shrink: 0;
}

.wb-photo {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.wb-name {
  margin: 0;
  font-size: 1rem;
  color: var(--text-secondary, #94a3b8);
  line-height: 1.5;
}

.wb-name strong {
  color: var(--text-primary, #f1f5f9);
  font-size: 1.1rem;
}

.wb-switch {
  background: none;
  border: none;
  color: var(--text-secondary, #94a3b8);
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  font-family: inherit;
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: color 0.2s;
}

.wb-switch:hover {
  color: var(--text-primary, #f1f5f9);
}
</style>
