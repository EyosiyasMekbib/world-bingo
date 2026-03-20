<template>
  <div class="auth-card">
    <!-- Header -->
    <div class="auth-card-header">
      <h1 class="auth-title">Welcome back</h1>
      <p class="auth-subtitle">Sign in to continue playing</p>
    </div>

    <!-- Welcome-back block (returning user with expired session) -->
    <div v-if="showWelcomeBack" class="auth-actions">
      <div class="welcome-back">
        <div class="wb-avatar">
          <img v-if="auth.user!.photoUrl" :src="auth.user!.photoUrl" class="wb-photo" alt="Profile" />
          <span v-else>{{ (auth.user!.firstName ?? auth.user!.username ?? 'U')[0].toUpperCase() }}</span>
        </div>
        <p class="wb-name">Welcome back,<br><strong>{{ auth.user!.firstName ?? auth.user!.telegramUsername ?? auth.user!.username }}</strong></p>
        <button class="btn-primary-auth" :disabled="loading" @click="openTelegramAuth">
          <span v-if="loading" class="spinner" />
          <span>{{ loading ? 'Connecting…' : `Continue as ${auth.user!.firstName ?? auth.user!.username}` }}</span>
        </button>
        <button class="wb-switch" @click="auth.clearStoredUser()">
          Sign in as different user
        </button>
      </div>
      <p v-if="errorMsg" class="auth-error" role="alert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        {{ errorMsg }}
      </p>
    </div>

    <!-- Default Telegram login button -->
    <div v-else class="auth-actions">
      <button class="btn-primary-auth" :disabled="loading" @click="openTelegramAuth">
        <span v-if="loading" class="spinner" />
        <svg v-else class="tg-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248-2.04 9.61c-.152.68-.552.847-1.118.527l-3.09-2.276-1.49 1.434c-.165.165-.303.303-.62.303l.22-3.134 5.694-5.144c.247-.22-.054-.342-.385-.122L7.08 14.516l-3.04-.95c-.66-.207-.674-.66.138-.977l11.87-4.577c.55-.2 1.03.134.514.236z" />
        </svg>
        <span>{{ loading ? 'Connecting…' : 'Continue with Telegram' }}</span>
      </button>

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
const config = useRuntimeConfig()
const errorMsg = ref('')
const loading = ref(false)

const showWelcomeBack = computed(() => !!auth.user && !auth.isAuthenticated)

function handleTelegramCallback(user: TelegramAuthDto) {
  loading.value = true
  errorMsg.value = ''
  auth.telegramLogin(user)
    .then(() => router.push('/'))
    .catch((e: any) => {
      errorMsg.value = e?.data?.message || 'Authentication failed. Please try again.'
    })
    .finally(() => { loading.value = false })
}

function loadTelegramScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Telegram?.Login) { resolve(); return }
    if (document.getElementById('tg-widget-script')) {
      // already injected but not yet loaded — wait
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

/* ── Actions ─────────────────────────────────────────────────────────── */
.auth-actions { display: flex; flex-direction: column; gap: 1rem; }

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
@keyframes spin { to { transform: rotate(360deg); } }

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
