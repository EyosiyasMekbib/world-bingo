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
    router.replace('/auth/login')
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

function goBack() {
  router.push('/')
}

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
      <button class="back-btn" @click="goBack">Back to Lobby</button>
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
      <button class="float-back" @click="goBack" :title="'Back to Lobby'">
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
  background: #000;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.game-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
}

.play-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: rgba(255, 255, 255, 0.7);
  font-family: 'Nunito', sans-serif;
}

.play-state--error { color: #ef4444; }

.play-state-text {
  font-size: 15px;
  margin: 0;
}

.play-state-text--error { color: #ef4444; }

.play-spinner {
  width: 48px;
  height: 48px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: #FFD700;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.back-btn {
  margin-top: 8px;
  background: #FFD700;
  color: #000;
  font-weight: 800;
  font-size: 14px;
  padding: 10px 28px;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  font-family: 'Nunito', sans-serif;
  transition: background 0.15s;
}

.back-btn:hover { background: #e5c500; }

.float-back {
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 200;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.85);
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  font-family: 'Nunito', sans-serif;
  transition: background 0.15s, color 0.15s;
  backdrop-filter: blur(8px);
}

.float-back:hover {
  background: rgba(0, 0, 0, 0.9);
  color: #FFD700;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
