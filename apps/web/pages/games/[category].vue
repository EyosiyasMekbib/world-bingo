<script setup lang="ts">
import { useProviderGamesStore } from '~/store/provider-games'
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import type { ProviderGame } from '~/store/provider-games'
import type { Game } from '@world-bingo/shared-types'

const route = useRoute()
const config = useRuntimeConfig()
const providerStore = useProviderGamesStore()
const gameStore = useGameStore()
const auth = useAuthStore()
const { patternLabel } = usePatternLabel()

const rawCategory = computed(() => route.params.category as string)
const category = computed(() => rawCategory.value.toUpperCase())
const isBingo = computed(() => category.value === 'BINGO')

const CATEGORY_LABELS: Record<string, string> = {
  ALL: 'All Games',
  TRENDING: 'Trending',
  POPULAR: 'Popular',
  BINGO: 'Bingo',
  SLOTS: 'Slots',
  LIVE: 'Live',
  TABLE: 'Table',
  CRASH: 'Crash',
}

const categoryLabel = computed(() => CATEGORY_LABELS[category.value] ?? category.value)

useHead({ title: computed(() => `${categoryLabel.value} — World Bingo`) })

// ── Provider game infinite scroll ────────────────────────────────────
const providerGames = ref<ProviderGame[]>([])
const page = ref(1)
const totalPages = ref(1)
const initialLoading = ref(false)
const loadingMore = ref(false)

const hasMore = computed(() => page.value < totalPages.value)

async function fetchProviderPage(pg: number) {
  if (!providerStore.activeProviderCode) return
  const params = new URLSearchParams({
    page: String(pg),
    pageSize: '24',
    category: category.value,
  })
  const result = await $fetch<{ games: ProviderGame[]; totalPages: number; totalItems: number }>(
    `${config.public.apiBase}/providers/${providerStore.activeProviderCode}/games?${params}`,
  )
  return result
}

async function loadMore() {
  if (!hasMore.value || loadingMore.value) return
  loadingMore.value = true
  page.value++
  try {
    const result = await fetchProviderPage(page.value)
    if (result) providerGames.value = [...providerGames.value, ...result.games]
  } finally {
    loadingMore.value = false
  }
}

// Sentinel element for intersection observer
const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

function setupObserver() {
  if (!sentinel.value) return
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) loadMore()
    },
    { rootMargin: '300px' },
  )
  observer.observe(sentinel.value)
}

// ── Bingo ────────────────────────────────────────────────────────────
const showAuthPrompt = ref(false)

const trendingBingoGames = computed(() => {
  const weight = (s: string) => s === 'IN_PROGRESS' ? 0 : s === 'STARTING' ? 1 : s === 'LOCKING' ? 2 : 3
  return [...gameStore.availableGames].sort((a, b) => {
    const sw = weight(a.status) - weight(b.status)
    if (sw !== 0) return sw
    const ap = gameStore.livePlayers[a.id] ?? (a as any).currentPlayers ?? 0
    const bp = gameStore.livePlayers[b.id] ?? (b as any).currentPlayers ?? 0
    return bp - ap
  })
})

const popularBingoGames = computed(() => {
  return [...gameStore.availableGames].sort((a, b) => {
    const ap = gameStore.livePlayers[a.id] ?? (a as any).currentPlayers ?? 0
    const bp = gameStore.livePlayers[b.id] ?? (b as any).currentPlayers ?? 0
    if (bp !== ap) return bp - ap
    return Number(a.ticketPrice) - Number(b.ticketPrice)
  })
})

const bingoGames = computed((): Game[] => {
  if (category.value === 'TRENDING') return trendingBingoGames.value
  if (category.value === 'POPULAR') return popularBingoGames.value
  return gameStore.availableGames
})

const showBingo = computed(() => ['BINGO', 'TRENDING', 'POPULAR'].includes(category.value))

function handleJoinGame(gameId: string) {
  if (!auth.isAuthenticated) {
    showAuthPrompt.value = true
    return
  }
  navigateTo(`/quick/${gameId}`)
}

// ── Lifecycle ────────────────────────────────────────────────────────
onMounted(async () => {
  if (showBingo.value) {
    await gameStore.fetchAvailableGames()
  } else {
    await providerStore.fetchProviders()
    initialLoading.value = true
    try {
      const result = await fetchProviderPage(1)
      if (result) {
        providerGames.value = result.games
        totalPages.value = result.totalPages
      }
    } finally {
      initialLoading.value = false
    }
    await nextTick()
    setupObserver()
  }
})

onUnmounted(() => {
  observer?.disconnect()
})
</script>

<template>
  <div class="cat-page">
    <!-- Header -->
    <div class="cat-header max-container">
      <NuxtLink to="/" class="back-btn" aria-label="Back to home">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </NuxtLink>
      <h1 class="cat-title">{{ categoryLabel }}</h1>
      <div class="cat-count" v-if="showBingo">
        {{ bingoGames.length }} rooms
      </div>
    </div>

    <!-- ── BINGO ───────────────────────────────────────────────────── -->
    <div v-if="showBingo" class="max-container">
      <div v-if="gameStore.loadingGames" class="state-msg">
        <span class="spinner" aria-hidden="true"></span> Loading rooms...
      </div>
      <div v-else-if="!bingoGames.length" class="state-msg">
        No bingo rooms available right now. Check back soon.
      </div>
      <div v-else class="rooms-grid">
        <div
          v-for="(game, idx) in bingoGames"
          :key="game.id"
          class="room-tile"
          :style="{ '--delay': `${Math.min(idx, 11) * 40}ms` }"
        >
          <div class="rt-thumb">
            <div v-if="game.status !== 'WAITING'" class="rt-badge rt-badge--live">
              <span class="live-dot-sm"></span> Live
            </div>
            <div v-else-if="gameStore.countdowns[game.id]" class="rt-badge rt-badge--timer">
              <GameCountdown :starts-at="gameStore.countdowns[game.id]" compact />
            </div>
            <div v-else class="rt-badge rt-badge--timer">1:00</div>
            <div class="rt-pattern">{{ patternLabel(game.pattern) }}</div>
            <div class="rt-price-wrap">
              <span class="rt-price">{{ Number(game.ticketPrice).toLocaleString() }}</span>
              <span class="rt-currency">ETB</span>
            </div>
          </div>
          <div class="rt-footer">
            <div class="rt-players">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
              </svg>
              {{ gameStore.livePlayers[game.id] ?? (game as any).currentPlayers ?? 0 }}<span class="rt-slash">/</span>{{ (game as any).maxPlayers ?? 10 }}
            </div>
            <button
              v-if="game.status === 'WAITING'"
              class="rt-join"
              @click="handleJoinGame(game.id)"
            >
              Join
            </button>
            <div v-else class="rt-join rt-join--live">
              {{ game.status === 'STARTING' ? 'Starting' : 'Live' }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── PROVIDER GAMES ─────────────────────────────────────────── -->
    <div v-else class="max-container">
      <!-- Skeleton grid while loading first page -->
      <div v-if="initialLoading" class="pg-grid" aria-busy="true" aria-label="Loading games">
        <div v-for="n in 24" :key="n" class="pg-skel">
          <div class="pg-skel-thumb"></div>
          <div class="pg-skel-name"></div>
        </div>
      </div>
      <div v-else-if="!providerGames.length" class="state-msg">
        No games available.
      </div>
      <template v-else>
        <div class="pg-grid">
          <NuxtLink
            v-for="g in providerGames"
            :key="g.gameCode"
            :to="`/play/${providerStore.activeProviderCode}/${g.gameCode}`"
            class="pg-card"
          >
            <div class="pg-thumb">
              <img
                v-if="g.imageSquare || g.imageLandscape"
                :src="g.imageSquare ?? g.imageLandscape ?? ''"
                :alt="g.gameName"
                class="pg-img"
                loading="lazy"
              />
              <div v-else class="pg-placeholder">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.3" aria-hidden="true">
                  <rect x="2" y="3" width="20" height="18" rx="2"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="8" rx="1"/><rect x="15" y="7" width="4" height="8" rx="1"/>
                </svg>
              </div>
              <div class="pg-hover"><span class="pg-play">Play</span></div>
            </div>
            <div class="pg-name">{{ g.gameName }}</div>
          </NuxtLink>
        </div>

        <!-- Infinite scroll sentinel -->
        <div ref="sentinel" class="sentinel" aria-hidden="true"></div>

        <!-- Skeleton row while loading next page -->
        <div v-if="loadingMore" class="pg-grid pg-grid--more" aria-busy="true">
          <div v-for="n in 8" :key="n" class="pg-skel">
            <div class="pg-skel-thumb"></div>
            <div class="pg-skel-name"></div>
          </div>
        </div>
        <div v-else-if="!hasMore && providerGames.length > 0" class="end-msg">
          All {{ categoryLabel }} games loaded
        </div>
      </template>
    </div>

    <AuthPromptModal v-model="showAuthPrompt" />
  </div>
</template>

<style scoped>
.cat-page {
  min-height: 100vh;
  background: var(--surface-base);
  font-family: var(--font-body);
  padding-bottom: 64px;
}

.max-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 20px;
}

/* ── Header ──────────────────────────────────────────────────────── */
.cat-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-top: 20px;
  padding-bottom: 20px;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.65);
  text-decoration: none;
  flex-shrink: 0;
  transition: background 0.15s ease, color 0.15s ease;
}
.back-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
.back-btn:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }

.cat-title {
  font-family: 'Rajdhani', sans-serif;
  font-size: clamp(22px, 5vw, 30px);
  font-weight: 700;
  color: #e8eef8;
  margin: 0;
  flex: 1;
  min-width: 0;
}

.cat-count {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255,255,255,0.35);
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 20px;
  padding: 4px 12px;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Provider game grid ──────────────────────────────────────────── */
.pg-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
@media (min-width: 480px) { .pg-grid { grid-template-columns: repeat(4, 1fr); } }
@media (min-width: 640px) { .pg-grid { grid-template-columns: repeat(5, 1fr); } }
@media (min-width: 900px) { .pg-grid { grid-template-columns: repeat(7, 1fr); } }
@media (min-width: 1200px) { .pg-grid { grid-template-columns: repeat(9, 1fr); } }

.pg-card {
  border-radius: 8px;
  overflow: hidden;
  background: rgba(10, 22, 55, 0.7);
  border: 1px solid rgba(255,255,255,0.06);
  text-decoration: none;
  transition: transform 0.15s ease, border-color 0.15s ease;
  cursor: pointer;
}
.pg-card:hover { transform: translateY(-2px); border-color: rgba(245,158,11,0.2); }
.pg-card:active { transform: translateY(0); }

.pg-thumb {
  aspect-ratio: 3/4;
  position: relative;
  overflow: hidden;
  background: linear-gradient(145deg, #0d2050, #1a3870);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pg-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pg-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }

.pg-hover {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.pg-card:hover .pg-hover { opacity: 1; }
.pg-play {
  background: var(--brand-primary);
  color: #0a0f1a;
  font-weight: 800;
  font-size: 12px;
  padding: 7px 18px;
  border-radius: 6px;
}
.pg-name {
  padding: 7px 9px 8px;
  font-family: 'Rajdhani', sans-serif;
  font-size: 12px;
  font-weight: 700;
  color: #c8d4e8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Bingo rooms grid ────────────────────────────────────────────── */
.rooms-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
@media (min-width: 560px) { .rooms-grid { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 800px) { .rooms-grid { grid-template-columns: repeat(4, 1fr); } }
@media (min-width: 1100px) { .rooms-grid { grid-template-columns: repeat(5, 1fr); } }
@media (min-width: 1400px) { .rooms-grid { grid-template-columns: repeat(6, 1fr); } }

.room-tile {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.07);
  background: rgba(10, 22, 55, 0.75);
  animation: fadeUp 0.3s ease both;
  animation-delay: var(--delay, 0ms);
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.room-tile:hover { transform: translateY(-2px); border-color: rgba(245,158,11,0.22); }
.room-tile:active { transform: translateY(0); }

.rt-thumb {
  position: relative;
  padding: 28px 16px 24px;
  background: linear-gradient(155deg, #091840 0%, #142e62 100%);
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  min-height: 120px;
}
.rt-badge {
  position: absolute;
  top: 9px;
  left: 9px;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.03em;
  display: flex;
  align-items: center;
  gap: 4px;
}
.rt-badge--live { background: #dc2626; color: #fff; }
.rt-badge--timer {
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: var(--brand-primary);
  font-family: 'Rajdhani', sans-serif;
  font-size: 13px;
}
.rt-pattern {
  position: absolute;
  top: 9px;
  right: 9px;
  background: rgba(6, 182, 212, 0.1);
  border: 1px solid rgba(6, 182, 212, 0.22);
  color: #22d3ee;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.rt-price-wrap { display: flex; align-items: baseline; gap: 5px; }
.rt-price {
  font-family: 'Rajdhani', sans-serif;
  font-size: clamp(26px, 4vw, 32px);
  font-weight: 700;
  color: #f0f4ff;
  line-height: 1;
}
.rt-currency { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.4); }

.rt-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
}
.rt-players {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: rgba(255,255,255,0.45);
  font-weight: 600;
}
.rt-slash { color: rgba(255,255,255,0.2); margin: 0 1px; }
.rt-join {
  background: var(--brand-primary);
  color: #0a0f1a;
  border: none;
  border-radius: 6px;
  padding: 7px 14px;
  min-height: 34px;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  text-decoration: none;
  font-family: var(--font-body);
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.15s ease;
  display: inline-flex;
  align-items: center;
}
.rt-join:hover:not(.rt-join--live) { background: #fbbf24; }
.rt-join:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 3px; }
.rt-join--live {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: #34d399;
  cursor: default;
  font-size: 11px;
}

/* ── Skeleton cards ──────────────────────────────────────────────── */
.pg-skel {
  border-radius: 8px;
  overflow: hidden;
  background: rgba(10, 22, 55, 0.7);
  border: 1px solid rgba(255,255,255,0.04);
}

.pg-skel-thumb {
  aspect-ratio: 3/4;
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0.04) 0%,
    rgba(255,255,255,0.09) 40%,
    rgba(255,255,255,0.04) 80%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

.pg-skel-name {
  height: 10px;
  margin: 9px 9px 10px;
  border-radius: 3px;
  width: 70%;
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0.04) 0%,
    rgba(255,255,255,0.09) 40%,
    rgba(255,255,255,0.04) 80%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
  animation-delay: 0.07s;
}

.pg-grid--more {
  margin-top: 10px;
}

@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ── Infinite scroll ─────────────────────────────────────────────── */
.sentinel { height: 1px; }

.end-msg {
  text-align: center;
  padding: 28px 0;
  font-size: 13px;
  color: rgba(255,255,255,0.25);
  font-weight: 600;
}

/* ── Shared ──────────────────────────────────────────────────────── */
.state-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255,255,255,0.4);
  padding: 4rem 0;
  font-size: 14px;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255,255,255,0.08);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

.live-dot-sm {
  width: 6px;
  height: 6px;
  background: #fff;
  border-radius: 50%;
  animation: blink 1.2s infinite;
  flex-shrink: 0;
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.25; }
}
</style>
