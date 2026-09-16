<template>
  <div class="auth-card">
    <!-- Logo + Header -->
    <div class="auth-hero">
      <NuxtLink to="/">
        <BrandLogo :height="56" />
      </NuxtLink>
      <p class="auth-subtitle">Sign in to continue playing</p>
    </div>

    <!-- Tab switcher -->
    <div class="auth-tabs">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'phone' }"
        @click="activeTab = 'phone'; errorMsg = ''"
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 4h10a1 1 0 011 1v14a1 1 0 01-1 1H7a1 1 0 01-1-1V5a1 1 0 011-1zm4 14h2" />
        </svg>
        Phone
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

    <!-- ── Phone (SMS) tab ──────────────────────────────────────────────
         Sign-in and sign-up in one: a number we have never seen gets an
         account, so there is nothing for the player to choose between. -->
    <div v-if="activeTab === 'phone'" class="auth-actions">
      <PhoneSignIn @authenticated="router.push(redirectPath)" />

      <p class="auth-footer-link">
        Have a referral code?
        <NuxtLink to="/auth/register">Enter it here</NuxtLink>
      </p>
    </div>

    <!-- ── Telegram tab ──────────────────────────────────────────────── -->
    <div v-else class="auth-actions">
      <!-- Welcome-back block (returning user with expired session) -->
      <div v-if="showWelcomeBack" class="welcome-back">
        <div class="wb-avatar">
          <img v-if="auth.user!.photoUrl" :src="auth.user!.photoUrl" class="wb-photo" alt="Profile" />
          <!-- data-ph-mask: session replay must not record the player's
               name. rrweb masks the matched element and its descendants. -->
          <span v-else data-ph-mask>{{ (auth.user!.firstName ?? auth.user!.username ?? 'U')[0].toUpperCase() }}</span>
        </div>
        <p class="wb-name" data-ph-mask>
          Welcome back,<br>
          <strong>{{ auth.user!.firstName ?? auth.user!.telegramUsername ?? auth.user!.username }}</strong>
        </p>
        <button class="btn-primary-auth" :disabled="loading" @click="openTelegramAuth">
          <span v-if="loading" class="spinner" />
          <!-- The spinner beside this still shows the loading state in replay. -->
          <span data-ph-mask>{{ loading ? 'Connecting…' : `Continue as ${auth.user!.firstName ?? auth.user!.username}` }}</span>
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/store/auth'
import type { TelegramAuthDto } from '@world-bingo/shared-types'
import { describeFailure } from '~/utils/http-failure'

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
const { t } = useI18n()
const { track } = useAnalytics()
const errorMsg = ref('')
const loading = ref(false)
const activeTab = ref<'phone' | 'telegram'>('phone')

const showWelcomeBack = computed(() => !!auth.user && !auth.isAuthenticated)

const redirectPath = computed(() => {
  const r = route.query.redirect
  return typeof r === 'string' && r.startsWith('/') ? r : '/'
})

function handleTelegramCallback(user: TelegramAuthDto) {
  loading.value = true
  errorMsg.value = ''
  auth.telegramLogin(user)
    .then(() => router.push(redirectPath.value))
    .catch((e: any) => {
      const failure = describeFailure(e)
      track('login_failed', { method: 'telegram', reason: failure.code, status: failure.status })
      errorMsg.value =
        e?.data?.code === 'account_suspended'
          ? t('wallet.accountSuspended')
          : e?.data?.message || 'Authentication failed. Please try again.'
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

.auth-subtitle {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0;
}

/* ── Tabs ───────────────────────────────────────────────────────────── */
.auth-tabs {
  display: flex;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md, 12px);
  padding: 4px;
  gap: 4px;
}

.tab-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.6rem 1rem;
  background: none;
  border: none;
  border-radius: var(--radius-sm, 8px);
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}
.tab-btn.active {
  background: var(--surface-raised);
  color: var(--text-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.tab-icon,
.tg-tab-icon { width: 15px; height: 15px; }

/* ── Actions ─────────────────────────────────────────────────────────── */
.auth-actions { display: flex; flex-direction: column; gap: 1rem; }

/* ── Welcome back (Telegram) ─────────────────────────────────────────── */
.welcome-back {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.wb-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--brand-primary) 18%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-ui);
  font-size: 24px;
  font-weight: 700;
  color: var(--brand-primary);
  overflow: hidden;
}
.wb-photo { width: 100%; height: 100%; object-fit: cover; }

.wb-name {
  font-family: var(--font-ui);
  font-size: 14px;
  color: var(--text-secondary);
  text-align: center;
  margin: 0;
}
.wb-name strong { color: var(--text-primary); font-size: 16px; }

.wb-switch {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-decoration: underline;
}

/* ── Footer link ─────────────────────────────────────────────────────── */
.auth-footer-link {
  text-align: center;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}
.auth-footer-link a {
  color: var(--brand-primary);
  font-weight: 600;
  text-decoration: none;
}
.auth-footer-link a:hover { text-decoration: underline; }

/* ── Errors ──────────────────────────────────────────────────────────── */
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

/* ── CTA buttons ──────────────────────────────────────────────────────── */
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

.btn-telegram {
  background: #2AABEE;
  color: #fff;
}
.btn-telegram:hover:not(:disabled) {
  background: #38bdf8;
  box-shadow: 0 10px 26px rgba(42, 171, 238, 0.35);
}

.tg-icon { width: 18px; height: 18px; flex-shrink: 0; }

/* Spinner */
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
