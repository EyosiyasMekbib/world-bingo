<script setup lang="ts">
import { useAuthStore } from '~/store/auth'
import { describeFailure } from '~/utils/http-failure'
import {
  crossedReady,
  crossedTimeout,
  elapsedSeconds,
  initialLoadState,
  reduceLoad,
  type LoadEvent,
} from '~/utils/provider-load'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { track } = useAnalytics()

const providerCode = route.params.providerCode as string
const gameCode = route.params.gameCode as string

const gameUrl = ref<string | null>(null)
const load = ref(initialLoadState(0))
const now = ref(0)
const sessionStartedAt = ref<number | null>(null)
let ticker: ReturnType<typeof setInterval> | null = null

const elapsed = computed(() => elapsedSeconds(load.value, now.value))
const showOverlay = computed(() =>
  ['launching', 'loading', 'slow', 'timeout'].includes(load.value.phase),
)
const canRetry = computed(() => load.value.phase === 'slow' || load.value.phase === 'timeout')

function dispatch(event: LoadEvent) {
  const prev = load.value
  const next = reduceLoad(prev, event)
  if (next === prev) return
  load.value = next
  if (crossedTimeout(prev, next)) {
    track('provider_game_load_timeout', {
      providerCode,
      gameCode,
      attempt: next.attempt,
      stage: next.urlAt === null ? 'launch' : 'frame',
      msToUrl: next.urlAt === null ? null : Math.round(next.urlAt - next.startedAt),
    })
  }
  if (crossedReady(prev, next)) {
    // 185 of 210 Keno sessions ended inside a minute; without this nobody can
    // tell a slow-loading game from a short one. msToUrl separates our api
    // (and the provider's launch call) from the game's own asset load.
    track('provider_game_loaded', {
      providerCode,
      gameCode,
      attempt: next.attempt,
      msToLoad: Math.round(next.loadedAt! - next.startedAt),
      msToUrl: Math.round(next.urlAt! - next.startedAt),
    })
  }
  if (next.phase === 'ready' || next.phase === 'error') stopTicker()
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker)
    ticker = null
  }
}

function startTicker() {
  stopTicker()
  ticker = setInterval(() => {
    now.value = performance.now()
    dispatch({ type: 'tick', now: now.value })
  }, 500)
}

async function launch() {
  const attempt = load.value.attempt
  try {
    const result = await auth.apiFetch<{ gameUrl: string; token: string }>(
      `/providers/${providerCode}/games/${gameCode}/launch`,
      {
        method: 'POST',
        body: { lobbyUrl: `${window.location.origin}/`, language: 'en', currency: 'ETB' },
      },
    )
    // A retry started while this call was in flight: this answer is stale.
    if (attempt !== load.value.attempt) return
    gameUrl.value = result.gameUrl
    sessionStartedAt.value ??= Date.now()
    dispatch({ type: 'url', now: performance.now() })
  } catch (e: any) {
    if (attempt !== load.value.attempt) return
    const failure = describeFailure(e)
    track('provider_launch_failed', {
      providerCode,
      gameCode,
      code: failure.code,
      status: failure.status,
    })
    dispatch({
      type: 'launch_failed',
      message: e?.data?.message ?? e?.message ?? 'Failed to launch game',
    })
  }
}

function onFrameLoad() {
  dispatch({ type: 'frame_loaded', now: performance.now() })
}

/** A fresh launch URL and a fresh frame; the old frame is unmounted, not reused. */
function retry() {
  const from = load.value.phase
  gameUrl.value = null
  now.value = performance.now()
  dispatch({ type: 'retry', now: now.value })
  track('provider_game_retry', { providerCode, gameCode, attempt: load.value.attempt, from })
  startTicker()
  void launch()
}

function fireSessionEnd() {
  if (!sessionStartedAt.value) return
  const durationSecs = Math.round((Date.now() - sessionStartedAt.value) / 1000)
  track('provider_session_ended', {
    providerCode,
    gameCode,
    sessionDurationSecs: durationSecs,
    balanceDelta: null,
  })
  sessionStartedAt.value = null
}

onMounted(() => {
  if (!auth.isAuthenticated) {
    router.replace(`/auth/login?redirect=${encodeURIComponent(route.fullPath)}`)
    return
  }
  track('provider_game_view', { providerCode, gameCode })
  now.value = performance.now()
  load.value = initialLoadState(now.value)
  startTicker()
  void launch()

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') fireSessionEnd()
  })
  window.addEventListener('beforeunload', fireSessionEnd)
})

onUnmounted(() => {
  stopTicker()
  fireSessionEnd()
})

useHead({
  title: `Playing ${gameCode}`,
})
</script>

<template>
  <div class="play-page">
    <!-- Mounts as soon as a URL exists and loads under the overlay. Keyed by
         attempt so a retry replaces the frame instead of reusing it. -->
    <iframe
      v-if="gameUrl"
      :key="load.attempt"
      :src="gameUrl"
      class="game-frame"
      allow="fullscreen; autoplay"
      allowfullscreen
      frameborder="0"
      scrolling="no"
      @load="onFrameLoad"
    />

    <div v-if="showOverlay" class="play-state play-state--overlay" role="status" aria-live="polite">
      <div class="play-spinner"></div>
      <p class="play-state-text">{{ load.urlAt === null ? 'Launching game…' : 'Loading game…' }}</p>
      <!-- A per-second counter inside a live region would be read out every tick. -->
      <p class="play-state-elapsed" aria-hidden="true">{{ elapsed }}s</p>
      <p v-if="load.phase === 'slow'" class="play-state-hint">
        This is taking longer than usual. Slow connections can need up to 30 seconds.
      </p>
      <p v-else-if="load.phase === 'timeout'" class="play-state-hint">
        The game still hasn't loaded. Try again, or go back and pick another game.
      </p>
      <div v-if="canRetry" class="play-actions">
        <button class="back-btn" @click="retry">Try again</button>
        <button class="ghost-btn" @click="router.push('/')">Back to Lobby</button>
      </div>
    </div>

    <div v-else-if="load.phase === 'error'" class="play-state play-state--error">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <p class="play-state-text play-state-text--error">{{ load.error }}</p>
      <div class="play-actions">
        <button class="back-btn" @click="retry">Try again</button>
        <button class="ghost-btn" @click="router.push('/')">Back to Lobby</button>
      </div>
    </div>

    <!-- Always reachable while waiting or playing, not only once a URL exists. -->
    <button
      v-if="load.phase !== 'error'"
      class="float-back"
      title="Back to Lobby"
      @click="router.push('/')"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 12H5M12 19l-7-7 7-7" />
      </svg>
      Lobby
    </button>
  </div>
</template>

<style scoped>
.play-page {
  position: fixed;
  inset: 0;
  background: linear-gradient(150deg, #020b20 0%, #061535 55%, #0c2248 100%);
  /* 55, not 100: all this surface has to cover is the arada sticky header at
     50. At 100 it also covered the support launcher, so the one screen where
     a player most needs to ask a question was the one screen with no way to
     ask it. See the scale in assets/css/components.css. */
  z-index: 55;
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

/* Covers the blank frame until it fires `load`; the float-back (z 10) stays above it. */
.play-state--overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  justify-content: center;
  padding: 24px;
  text-align: center;
  background: linear-gradient(150deg, #020b20 0%, #061535 55%, #0c2248 100%);
}

.play-state-elapsed {
  margin: 0;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: rgba(200, 215, 240, 0.5);
}

.play-state-hint {
  margin: 0;
  max-width: 300px;
  font-size: 13px;
  line-height: 1.5;
  color: rgba(200, 215, 240, 0.75);
}

.play-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }

.ghost-btn {
  margin-top: 8px;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  font-weight: 700;
  font-size: 14px;
  padding: 10px 20px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
  font-family: 'Nunito', sans-serif;
}

.ghost-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
