<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const providerCode = route.params.providerCode as string
const gameCode = route.params.gameCode as string

const gameUrl = ref<string | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.replace(`/auth/login?redirect=${encodeURIComponent(route.fullPath)}`)
    return
  }

  try {
    const lobbyUrl = `${window.location.origin}/`
    const result = await auth.apiFetch<{ gameUrl: string; token: string }>(
      `/providers/${providerCode}/games/${gameCode}/launch`,
      {
        method: 'POST',
        body: { lobbyUrl, language: 'en', currency: 'ETB' },
      },
    )
    gameUrl.value = result.gameUrl
  } catch (e: any) {
    error.value = e?.data?.message ?? e?.message ?? 'Failed to launch game'
  } finally {
    loading.value = false
  }
})

useHead({
  title: `Playing ${gameCode}`,
})
</script>

<template>
  <div class="play-page">
    <!-- Loading state -->
    <div v-if="loading" class="play-state">
      <div class="play-spinner"></div>
      <p class="play-state-text">Launching game…</p>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="play-state play-state--error">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <p class="play-state-text play-state-text--error">{{ error }}</p>
      <button class="back-btn" @click="router.push('/')">Back to Lobby</button>
    </div>

    <!-- Game iframe -->
    <template v-else-if="gameUrl">
      <iframe
        :src="gameUrl"
        class="game-frame"
        allow="fullscreen; autoplay"
        allowfullscreen
        frameborder="0"
        scrolling="no"
      />
      <button class="float-back" @click="router.push('/')" title="Back to Lobby">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Lobby
      </button>
    </template>

  </div>
</template>

<style scoped>
.play-page {
  position: fixed;
  inset: 0;
  background: linear-gradient(150deg, #020b20 0%, #061535 55%, #0c2248 100%);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Subtle radial accent — same as lobby hero bg */
.play-page::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 50% 60% at 70% 50%, rgba(245, 158, 11, 0.06) 0%, transparent 65%),
    radial-gradient(ellipse 35% 50% at 20% 40%, rgba(6, 182, 212, 0.04) 0%, transparent 60%);
  pointer-events: none;
}

.play-state {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: rgba(200, 215, 240, 0.7);
  font-family: 'Nunito', sans-serif;
}

.play-state--error { color: #f87171; }

.play-state-text {
  font-size: 15px;
  margin: 0;
  font-weight: 600;
}

.play-state-text--error { color: #f87171; }

.play-spinner {
  width: 44px;
  height: 44px;
  border: 2px solid rgba(255, 255, 255, 0.08);
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
}

.game-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
}

.float-back {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(2, 11, 32, 0.72);
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  font-weight: 700;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  cursor: pointer;
  font-family: 'Nunito', sans-serif;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  z-index: 10;
  transition: background 0.15s ease, color 0.15s ease;
}

.float-back:hover {
  background: rgba(2, 11, 32, 0.88);
  color: #fff;
}

.float-back:focus-visible {
  outline: 2px solid #f59e0b;
  outline-offset: 2px;
}

.back-btn {
  margin-top: 8px;
  background: #f59e0b;
  color: #0a0f1a;
  font-weight: 800;
  font-size: 14px;
  padding: 10px 28px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-family: 'Nunito', sans-serif;
  transition: background 0.15s ease;
}

.back-btn:hover { background: #fbbf24; }
.back-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
