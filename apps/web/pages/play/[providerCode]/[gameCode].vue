<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const providerCode = route.params.providerCode as string
const gameCode = route.params.gameCode as string

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
    // GASea requires a new window — redirect directly to the game URL
    window.location.href = result.gameUrl
  } catch (e: any) {
    error.value = e?.data?.message ?? e?.message ?? 'Failed to launch game'
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

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
