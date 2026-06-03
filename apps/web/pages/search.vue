<script setup lang="ts">
import { useAuthStore } from '~/store/auth'
import { useGameStore } from '~/store/game'
import { useProviderGamesStore, type ProviderGame } from '~/store/provider-games'
import {
  filterBingoGames,
  filterProviderGames,
  normalizeLobbySearchQuery,
} from '~/utils/lobby-search'

const route = useRoute()
const config = useRuntimeConfig()
const auth = useAuthStore()
const gameStore = useGameStore()
const providerStore = useProviderGamesStore()
const { patternLabel } = usePatternLabel()

const searchQuery = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const providerResults = ref<ProviderGame[]>([])
const showAuthPrompt = ref(false)

const query = computed(() => normalizeLobbySearchQuery(String(route.query.q ?? '')))
const bingoResults = computed(() =>
  filterBingoGames(gameStore.availableGames, query.value, (game) => patternLabel(game.pattern)),
)
const providerMatches = computed(() => filterProviderGames(providerResults.value, query.value))
const totalResults = computed(() => bingoResults.value.length + providerMatches.value.length)

function goToSearch() {
  const q = normalizeLobbySearchQuery(searchQuery.value)
  if (!q) return
  navigateTo({ path: '/search', query: { q } })
}

function clearSearch() {
  searchQuery.value = ''
  navigateTo('/search')
}

function handleJoinGame(gameId: string) {
  if (!auth.isAuthenticated) {
    showAuthPrompt.value = true
    return
  }
  navigateTo(`/quick/${gameId}`)
}

async function loadSearchResults(q: string) {
  loading.value = true
  error.value = null
  try {
    await Promise.all([gameStore.fetchAvailableGames(), providerStore.fetchProviders()])

    if (!providerStore.activeProviderCode) {
      providerResults.value = []
      return
    }

    await providerStore.fetchGames({
      reset: true,
      category: 'ALL',
      page: 1,
      pageSize: 200,
    })
    providerResults.value = [...providerStore.games]
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load search results'
  } finally {
    loading.value = false
  }
}

watch(
  query,
  (q) => {
    searchQuery.value = q
    providerResults.value = []

    if (!q) {
      loading.value = false
      error.value = null
      return
    }

    loadSearchResults(q)
  },
  { immediate: true },
)

useHead({
  title: computed(() =>
    query.value ? `Search results for "${query.value}" — World Bingo` : 'Search — World Bingo',
  ),
})
</script>

<template>
  <div class="search-page">
    <section class="search-hero">
      <div class="max-container search-hero-inner">
        <NuxtLink to="/" class="back-btn" aria-label="Back to lobby">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </NuxtLink>

        <div class="search-copy">
          <p class="search-eyebrow">Search</p>
          <h1 class="search-title">
            {{ query ? `Results for "${query}"` : 'Search games' }}
          </h1>
          <p class="search-sub">Find bingo rooms and provider games from one place.</p>
        </div>

        <form class="search-wrap" role="search" @submit.prevent="goToSearch">
          <button type="submit" class="search-submit" aria-label="Search games">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search by title, price, category, or vendor..."
            class="search-input"
            aria-label="Search games"
          />
          <button
            v-if="searchQuery"
            type="button"
            class="search-clear"
            aria-label="Clear search"
            @click="clearSearch"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </form>
      </div>
    </section>

    <div class="max-container search-content">
      <div v-if="!query" class="state-msg">
        Type a game name, vendor, category, or price to see matches.
      </div>

      <template v-else>
        <div v-if="loading" class="state-msg">
          <span class="spinner" aria-hidden="true"></span> Searching...
        </div>
        <div v-else-if="error" class="state-msg state-msg--error">
          Could not load search results.
        </div>

        <template v-else>
          <div class="search-summary">
            <span>{{ totalResults }} result{{ totalResults === 1 ? '' : 's' }}</span>
          </div>

          <section class="result-section">
            <div class="section-head">
              <h2>Bingo Rooms</h2>
              <span>{{ bingoResults.length }}</span>
            </div>

            <div v-if="!bingoResults.length" class="state-msg">
              No bingo rooms match your search.
            </div>
            <div v-else class="rooms-grid">
              <div
                v-for="(game, idx) in bingoResults"
                :key="game.id"
                class="room-tile"
                :style="{ '--delay': `${idx * 40}ms` }"
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
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                    </svg>
                    {{ gameStore.livePlayers[game.id] ?? (game as any).currentPlayers ?? 0
                    }}<span class="rt-slash">/</span>{{ (game as any).maxPlayers ?? 10 }}
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
          </section>

          <section class="result-section">
            <div class="section-head">
              <h2>Provider Games</h2>
              <span>{{ providerMatches.length }}</span>
            </div>

            <div v-if="!providerMatches.length" class="state-msg">
              No provider games match your search.
            </div>
            <div v-else class="pg-grid">
              <NuxtLink
                v-for="g in providerMatches"
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
                    <svg
                      width="28"
                      height="28"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="rgba(255,255,255,0.2)"
                      stroke-width="1.3"
                      aria-hidden="true"
                    >
                      <rect x="2" y="3" width="20" height="18" rx="2" />
                      <rect x="5" y="7" width="4" height="8" rx="1" />
                      <rect x="10" y="7" width="4" height="8" rx="1" />
                      <rect x="15" y="7" width="4" height="8" rx="1" />
                    </svg>
                  </div>
                  <div class="pg-hover"><span class="pg-play">Play</span></div>
                </div>
                <div class="pg-name">{{ g.gameName }}</div>
                <div class="pg-meta">{{ g.categoryCode }}</div>
              </NuxtLink>
            </div>
          </section>
        </template>
      </template>
    </div>

    <AuthPromptModal v-model="showAuthPrompt" />
  </div>
</template>

<style scoped>
.search-page {
  min-height: 100vh;
  background: var(--surface-base);
  font-family: var(--font-body);
  padding-bottom: 48px;
}

.max-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 20px;
}

.search-hero {
  background: linear-gradient(150deg, #020b20 0%, #061535 55%, #0c2248 100%);
  padding: 20px 0 22px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.search-hero-inner {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 18px 20px;
  align-items: center;
}

.back-btn {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.72);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  text-decoration: none;
}

.search-copy {
  min-width: 0;
}

.search-eyebrow {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
}

.search-title {
  margin: 0;
  font-family: 'Rajdhani', sans-serif;
  font-size: clamp(28px, 4vw, 42px);
  line-height: 1.04;
  color: #f0f4ff;
}

.search-sub {
  margin: 8px 0 0;
  color: rgba(180, 205, 240, 0.65);
  max-width: 520px;
}

.search-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.3);
  max-width: 640px;
  width: 100%;
  grid-column: 1 / -1;
}

.search-submit,
.search-clear {
  background: none;
  border: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.3);
  transition: color 0.15s ease;
}

.search-submit:hover,
.search-clear:hover {
  color: rgba(255, 255, 255, 0.7);
}

.search-input {
  background: none;
  border: none;
  outline: none;
  color: rgba(255, 255, 255, 0.82);
  font-size: 14px;
  font-family: var(--font-body);
  width: 100%;
  min-width: 0;
}

.search-input::placeholder {
  color: rgba(255, 255, 255, 0.34);
}

.search-content {
  padding-top: 22px;
}

.search-summary {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 14px;
  color: rgba(255, 255, 255, 0.42);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.result-section {
  margin-bottom: 28px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.section-head h2 {
  margin: 0;
  color: #f0f4ff;
  font-size: 18px;
  font-weight: 800;
}

.section-head span {
  color: rgba(255, 255, 255, 0.4);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.rooms-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

@media (min-width: 560px) {
  .rooms-grid {
    gap: 10px;
  }
}

@media (min-width: 800px) {
  .rooms-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

@media (min-width: 1100px) {
  .rooms-grid {
    grid-template-columns: repeat(5, 1fr);
  }
}

.room-tile {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(10, 22, 55, 0.75);
  transition:
    transform 0.15s ease,
    border-color 0.15s ease;
}

.room-tile:hover {
  transform: translateY(-2px);
  border-color: rgba(245, 158, 11, 0.22);
}

.rt-thumb {
  height: 120px;
  background: linear-gradient(145deg, #091840, #142e62);
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  min-height: 120px;
}

.rt-badge,
.rt-pattern {
  position: absolute;
  top: 6px;
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.85);
}

.rt-badge {
  left: 6px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.rt-badge--timer {
  color: rgba(255, 255, 255, 0.78);
}

.rt-badge--live {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.rt-pattern {
  right: 6px;
  background: rgba(124, 58, 237, 0.18);
  border: 1px solid rgba(139, 92, 246, 0.3);
  color: #c4b5fd;
}

.rt-price-wrap {
  position: absolute;
  left: 10px;
  bottom: 10px;
  display: flex;
  align-items: baseline;
  gap: 5px;
}

.rt-price {
  font-family: 'Rajdhani', sans-serif;
  font-size: 24px;
  font-weight: 700;
  color: #f0f4ff;
}

.rt-currency {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.45);
}

.rt-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px;
}

.rt-players {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  font-weight: 600;
}

.rt-slash {
  color: rgba(255, 255, 255, 0.2);
}

.rt-join {
  background: var(--brand-primary);
  color: #0a0f1a;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
}

.rt-join--live {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: #6ee7b7;
}

.pg-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

@media (min-width: 640px) {
  .pg-grid {
    grid-template-columns: repeat(5, 1fr);
  }
}

@media (min-width: 900px) {
  .pg-grid {
    grid-template-columns: repeat(7, 1fr);
  }
}

@media (min-width: 1200px) {
  .pg-grid {
    grid-template-columns: repeat(9, 1fr);
  }
}

.pg-card {
  border-radius: 8px;
  overflow: hidden;
  background: rgba(10, 22, 55, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.06);
  text-decoration: none;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease;
  cursor: pointer;
}

.pg-card:hover {
  transform: translateY(-2px);
  border-color: rgba(245, 158, 11, 0.2);
}

.pg-thumb {
  aspect-ratio: 3 / 4;
  background: #0d2050;
  position: relative;
  overflow: hidden;
}

.pg-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pg-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pg-hover {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.pg-card:hover .pg-hover {
  opacity: 1;
}

.pg-play {
  background: var(--brand-primary);
  color: #0a0f1a;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 6px 10px;
  border-radius: 999px;
}

.pg-name {
  padding: 8px 9px 0;
  font-size: 11px;
  color: #f0f4ff;
  font-weight: 700;
  line-height: 1.2;
}

.pg-meta {
  padding: 0 9px 9px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.38);
}

.state-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.45);
  padding: 3rem 0;
  font-size: 14px;
  text-align: center;
}

.state-msg--error {
  color: #f87171;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.08);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 760px) {
  .search-hero-inner {
    grid-template-columns: 1fr;
  }

  .search-wrap {
    max-width: none;
  }

  .rooms-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
