<script setup lang="ts">
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import { useProviderGamesStore } from '~/store/provider-games'
import { usePromotionsStore } from '~/store/promotions'
import type { Game } from '@world-bingo/shared-types'

const auth = useAuthStore()
const gameStore = useGameStore()
const providerStore = useProviderGamesStore()
const promotionsStore = usePromotionsStore()
const { connect } = useSocket()
const featuredTemplateId = ref<string | null>(null)
const config = useRuntimeConfig()
const { patternLabel, patternIcon } = usePatternLabel()
const { tournamentsEnabled, thirdPartyGamesEnabled } = useFeatureFlags()

const topGamesCollapsed = ref(false)
const bingoCollapsed = ref(false)
const searchQuery = ref('')
const showAuthPrompt = ref(false)

// Category tabs (only shown when thirdPartyGamesEnabled)
const CATEGORY_LABELS: Record<string, string> = {
  ALL: 'All',
  BINGO: 'Bingo',
  SLOTS: 'Slots',
  LIVE: 'Live',
  TABLE: 'Table',
  CRASH: 'Crash',
}

const showBingoSection = computed(() =>
  !thirdPartyGamesEnabled.value ||
  providerStore.activeCategory === 'ALL' ||
  providerStore.activeCategory === 'BINGO',
)

const showProviderGames = computed(() =>
  thirdPartyGamesEnabled.value &&
  providerStore.activeCategory !== 'BINGO',
)

function selectCategory(cat: string) {
  providerStore.setCategory(cat)
}

async function handleLaunchGame(gameCode: string) {
  if (!auth.isAuthenticated) {
    navigateTo('/auth/login')
    return
  }
  const url = await providerStore.launchGame(providerStore.activeProviderCode, gameCode)
  if (url) {
    navigateTo(`/play/${providerStore.activeProviderCode}/${gameCode}`)
  }
}

function handleJoinGame(gameId: string) {
  if (!auth.isAuthenticated) {
    showAuthPrompt.value = true
    return
  }
  navigateTo(`/quick/${gameId}`)
}

const filteredGames = computed(() => {
  if (!searchQuery.value.trim()) return gameStore.availableGames
  const q = searchQuery.value.trim().toLowerCase()
  return gameStore.availableGames.filter((g: Game) =>
    String(g.ticketPrice).includes(q) ||
    g.status.toLowerCase().includes(q)
  )
})


const featuredGame = computed(() =>
  featuredTemplateId.value
    ? gameStore.availableGames.find((g) => g.templateId === featuredTemplateId.value) ?? null
    : null,
)

function scrollToRooms() {
  document.getElementById('rooms')?.scrollIntoView({ behavior: 'smooth' })
}

// Fetch data on mount
onMounted(async () => {
  try {
    await gameStore.fetchAvailableGames()
  } catch { /* errors are stored in gameStore.error */ }

  promotionsStore.fetch()

  $fetch<{ templateId: string | null }>(`${config.public.apiBase}/settings/featured-game`)
    .then((r) => { featuredTemplateId.value = r.templateId })
    .catch(() => {})

  if (thirdPartyGamesEnabled.value) {
    await providerStore.fetchProviders()
    await providerStore.fetchCategories()
    await providerStore.fetchGames({ reset: true })
  }

  const socket = connect()
  if (!socket) return

  socket.emit('lobby:subscribe')

  socket.on('lobby:game-added', (game: Game) => {
    gameStore.onLobbyGameAdded(game)
  })

  socket.on('lobby:game-removed', (gameId: string) => {
    gameStore.onLobbyGameRemoved(gameId)
  })

  socket.on('game:updated', (game: Game) => {
    gameStore.onGameUpdated(game)
  })

  // Live player count updates from the new room state machine
  ;(socket as any).on('player_count_update', (payload: { gameId: string; playerCount: number }) => {
    gameStore.onPlayerCountUpdate(payload.gameId, payload.playerCount)
  })

  // Listen for countdown events (game reached minPlayers, 60s countdown started)
  socket.on('game:countdown', (payload: { gameId: string; countdownSecs: number; startsAt: string }) => {
    gameStore.onGameCountdown(payload)
  })
})

onUnmounted(() => {
  const socket = connect()
  socket?.emit('lobby:unsubscribe')
})
</script>

<template>
  <div class="lobby-page">

    <!-- ── HERO BANNER ───────────────────────────────────────── -->
    <section class="hero">
      <div class="hero-bg"></div>
      <div class="hero-inner max-container">
        <div class="hero-text">
          <div class="hero-badge">
            <span class="badge-dot"></span>
            NOW LIVE — ETHIOPIA'S #1 BINGO
          </div>
          <h1 class="hero-title">Play <span class="hero-accent">Bingo</span>,<br>Win Real ETB</h1>
          <p class="hero-sub">Join thousands of players. Pick your cartela, call BINGO, get paid instantly.</p>
          <button class="hero-cta" @click="scrollToRooms">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play Now
          </button>
        </div>
        <div class="hero-art">
          <!-- Featured game card — shown when admin configured a template -->
          <template v-if="featuredGame">
            <div class="featured-game-card">
              <div class="fg-label">FEATURED GAME</div>
              <div class="fg-title">{{ featuredGame.title }}</div>
              <div class="fg-price">{{ Number(featuredGame.ticketPrice).toLocaleString() }} <span class="fg-etb">ETB</span></div>
              <div class="fg-meta">
                {{ patternLabel(featuredGame.pattern) }}
                &nbsp;·&nbsp;
                {{ gameStore.livePlayers[featuredGame.id] ?? (featuredGame as any).currentPlayers ?? 0 }}
                /
                {{ (featuredGame as any).maxPlayers ?? 10 }} players
              </div>
              <NuxtLink v-if="featuredGame.status === 'WAITING'" :to="`/quick/${featuredGame.id}`" class="fg-join">
                Join Now →
              </NuxtLink>
              <div v-else class="fg-live">
                <span class="live-dot"></span>
                {{ featuredGame.status === 'STARTING' ? 'Starting Soon' : 'LIVE' }}
              </div>
            </div>
          </template>

          <!-- Default art — shown when no featured game is configured -->
          <template v-else>
            <!-- Front bingo card -->
            <div class="bingo-card bingo-card--front">
              <div class="bc-cell">3</div>
              <div class="bc-cell">17</div>
              <div class="bc-cell">32</div>
              <div class="bc-cell bc-cell--gold">46</div>
              <div class="bc-cell">61</div>
              <div class="bc-cell bc-cell--blue">5</div>
              <div class="bc-cell">20</div>
              <div class="bc-cell">35</div>
              <div class="bc-cell">51</div>
              <div class="bc-cell bc-cell--gold">69</div>
              <div class="bc-cell">9</div>
              <div class="bc-cell">28</div>
              <div class="bc-cell bc-cell--free">FREE</div>
              <div class="bc-cell">53</div>
              <div class="bc-cell">74</div>
              <div class="bc-cell">14</div>
              <div class="bc-cell bc-cell--blue">24</div>
              <div class="bc-cell">39</div>
              <div class="bc-cell">48</div>
              <div class="bc-cell">63</div>
              <div class="bc-cell bc-cell--blue">1</div>
              <div class="bc-cell">16</div>
              <div class="bc-cell">44</div>
              <div class="bc-cell">60</div>
              <div class="bc-cell bc-cell--blue">75</div>
            </div>
            <!-- Back bingo card -->
            <div class="bingo-card bingo-card--back">
              <div class="bc-cell">7</div>
              <div class="bc-cell">19</div>
              <div class="bc-cell bc-cell--blue">33</div>
              <div class="bc-cell">49</div>
              <div class="bc-cell">62</div>
              <div class="bc-cell">2</div>
              <div class="bc-cell bc-cell--blue">21</div>
              <div class="bc-cell">36</div>
              <div class="bc-cell bc-cell--blue">52</div>
              <div class="bc-cell">70</div>
              <div class="bc-cell">11</div>
              <div class="bc-cell">29</div>
              <div class="bc-cell bc-cell--free">FREE</div>
              <div class="bc-cell">55</div>
              <div class="bc-cell bc-cell--blue">71</div>
              <div class="bc-cell">4</div>
              <div class="bc-cell bc-cell--blue">18</div>
              <div class="bc-cell">43</div>
              <div class="bc-cell bc-cell--blue">59</div>
              <div class="bc-cell">72</div>
              <div class="bc-cell">13</div>
              <div class="bc-cell">29</div>
              <div class="bc-cell bc-cell--blue">40</div>
              <div class="bc-cell">47</div>
              <div class="bc-cell">64</div>
            </div>
          </template>
        </div>
      </div>
      <div class="hero-dots">
        <span class="dot dot--active"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </section>

    <!-- ── PROMOTION BANNERS ─────────────────────────────────── -->
    <div class="max-container flex flex-col gap-2 px-4 pt-4">
      <CashbackBanner />
      <FirstDepositBanner />
    </div>

    <!-- ── GAME TYPE TABS ─────────────────────────────────────── -->
    <div class="tabs-bar">
      <div class="max-container tabs-inner">
        <div class="tabs-group">
          <!-- Without third-party games: Lobby + Tournaments only -->
          <template v-if="!thirdPartyGamesEnabled">
            <button class="tab tab--active">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              Lobby
            </button>
            <NuxtLink v-if="tournamentsEnabled" to="/tournaments" class="tab">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Tournaments
            </NuxtLink>
          </template>

          <!-- With third-party games: category tabs -->
          <template v-else>
            <button
              v-for="cat in providerStore.displayCategories"
              :key="cat"
              class="tab"
              :class="{ 'tab--active': providerStore.activeCategory === cat }"
              @click="selectCategory(cat)"
            >
              {{ CATEGORY_LABELS[cat] ?? cat }}
            </button>
            <NuxtLink v-if="tournamentsEnabled" to="/tournaments" class="tab">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Tournaments
            </NuxtLink>
          </template>
        </div>
        <label class="search-bar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:0.4">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search games…"
            class="search-input"
          />
        </label>
      </div>
    </div>

    <!-- ── TOP GAMES ROW ──────────────────────────────────────── -->
    <div class="section">
      <div class="max-container">
        <div class="section-hdr">
          <span class="section-title">Top Games</span>
          <button class="collapse-btn" @click="topGamesCollapsed = !topGamesCollapsed">
            {{ topGamesCollapsed ? 'Expand' : 'Collapse' }}
          </button>
        </div>
        <div v-show="!topGamesCollapsed" class="games-scroll">

          <!-- Bingo — LIVE -->
          <div class="game-card">
            <div class="gc-thumb gc-thumb--bingo">
              <div class="mini-grid">
                <div class="mg-cell">7</div>
                <div class="mg-cell mg-cell--m">23</div>
                <div class="mg-cell">41</div>
                <div class="mg-cell">54</div>
                <div class="mg-cell mg-cell--m">68</div>
                <div class="mg-cell mg-cell--m">12</div>
                <div class="mg-cell">29</div>
                <div class="mg-cell mg-cell--m">43</div>
                <div class="mg-cell">58</div>
                <div class="mg-cell">71</div>
                <div class="mg-cell">3</div>
                <div class="mg-cell mg-cell--m">30</div>
                <div class="mg-cell mg-cell--f">FR</div>
                <div class="mg-cell">60</div>
                <div class="mg-cell mg-cell--m">75</div>
                <div class="mg-cell">14</div>
                <div class="mg-cell">27</div>
                <div class="mg-cell">44</div>
                <div class="mg-cell mg-cell--m">57</div>
                <div class="mg-cell">72</div>
                <div class="mg-cell mg-cell--m">9</div>
                <div class="mg-cell">32</div>
                <div class="mg-cell">46</div>
                <div class="mg-cell">62</div>
                <div class="mg-cell mg-cell--m">74</div>
              </div>
              <div class="gc-live-badge"><span class="live-dot"></span> LIVE</div>
            </div>
            <div class="gc-info">
              <div class="gc-name">Bingo</div>
              <div class="gc-meta">
                From {{ gameStore.availableGames.length > 0 ? Math.min(...gameStore.availableGames.map((g: Game) => Number(g.ticketPrice))).toLocaleString() : 10 }} ETB
                · {{ gameStore.availableGames.length }} rooms open
              </div>
            </div>
          </div>

          <!-- Third-party featured games OR "Coming Soon" placeholders -->
          <template v-if="thirdPartyGamesEnabled && providerStore.games.length">
            <NuxtLink
              v-for="g in providerStore.games.slice(0, 6)"
              :key="g.gameCode"
              :to="`/play/${providerStore.activeProviderCode}/${g.gameCode}`"
              class="game-card"
            >
              <div class="gc-thumb gc-thumb--provider">
                <img
                  v-if="g.imageSquare || g.imageLandscape"
                  :src="g.imageSquare ?? g.imageLandscape ?? ''"
                  :alt="g.gameName"
                  class="gc-img"
                />
                <div v-else class="gc-placeholder-icon">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.3">
                    <rect x="2" y="3" width="20" height="18" rx="2" />
                    <rect x="5" y="7" width="4" height="8" rx="1" />
                    <rect x="10" y="7" width="4" height="8" rx="1" />
                    <rect x="15" y="7" width="4" height="8" rx="1" />
                  </svg>
                </div>
                <div class="gc-cat-badge">{{ g.categoryCode }}</div>
              </div>
              <div class="gc-info">
                <div class="gc-name">{{ g.gameName }}</div>
                <div class="gc-meta">{{ g.categoryCode }}</div>
              </div>
            </NuxtLink>
          </template>
          <template v-else-if="!thirdPartyGamesEnabled">
            <!-- Aviator -->
            <div class="game-card game-card--soon">
              <div class="gc-thumb gc-thumb--soon">
                <div class="soon-art">
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
                  </svg>
                  <span class="soon-label">AVIATOR</span>
                </div>
                <div class="soon-badge">Soon</div>
              </div>
              <div class="gc-info">
                <div class="gc-name">Aviator</div>
                <div class="gc-meta">Coming Soon</div>
              </div>
            </div>

            <!-- Slots -->
            <div class="game-card game-card--soon">
              <div class="gc-thumb gc-thumb--soon">
                <div class="soon-art">
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="3" width="20" height="18" rx="2" />
                    <rect x="5" y="7" width="4" height="8" rx="1" />
                    <rect x="10" y="7" width="4" height="8" rx="1" />
                    <rect x="15" y="7" width="4" height="8" rx="1" />
                    <line x1="2" y1="16" x2="22" y2="16" />
                  </svg>
                  <span class="soon-label">SLOTS</span>
                </div>
                <div class="soon-badge">Soon</div>
              </div>
              <div class="gc-info">
                <div class="gc-name">Slot Games</div>
                <div class="gc-meta">Coming Soon</div>
              </div>
            </div>

            <!-- Crash -->
            <div class="game-card game-card--soon">
              <div class="gc-thumb gc-thumb--soon">
                <div class="soon-art">
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z" />
                    <path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z" />
                  </svg>
                  <span class="soon-label">CRASH</span>
                </div>
                <div class="soon-badge">Soon</div>
              </div>
              <div class="gc-info">
                <div class="gc-name">Crash Game</div>
                <div class="gc-meta">Coming Soon</div>
              </div>
            </div>

            <!-- Cards -->
            <div class="game-card game-card--soon">
              <div class="gc-thumb gc-thumb--soon">
                <div class="soon-art">
                  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    <line x1="9" y1="10" x2="15" y2="10" />
                    <line x1="12" y1="7" x2="12" y2="13" />
                  </svg>
                  <span class="soon-label">CARDS</span>
                </div>
                <div class="soon-badge">Soon</div>
              </div>
              <div class="gc-info">
                <div class="gc-name">Card Games</div>
                <div class="gc-meta">Coming Soon</div>
              </div>
            </div>
          </template>

        </div>
      </div>
    </div>

    <!-- ── PROVIDER GAMES GRID (third-party categories) ─────── -->
    <div v-if="showProviderGames" class="section">
      <div class="max-container">
        <div class="section-hdr">
          <span class="section-title">{{ CATEGORY_LABELS[providerStore.activeCategory] ?? providerStore.activeCategory }}</span>
        </div>

        <div v-if="providerStore.loading && !providerStore.games.length" class="state-msg">
          <span class="spinner"></span> Loading games…
        </div>
        <div v-else-if="providerStore.error" class="state-msg state-msg--error">
          {{ providerStore.error }}
        </div>
        <div v-else-if="!providerStore.games.length" class="state-msg">
          No games available in this category.
        </div>

        <div v-else class="provider-grid">
          <NuxtLink
            v-for="g in providerStore.games"
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
              />
              <div v-else class="pg-placeholder">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="1.3">
                  <rect x="2" y="3" width="20" height="18" rx="2" />
                  <rect x="5" y="7" width="4" height="8" rx="1" />
                  <rect x="10" y="7" width="4" height="8" rx="1" />
                  <rect x="15" y="7" width="4" height="8" rx="1" />
                </svg>
              </div>
              <div class="pg-overlay">
                <span class="pg-play-btn">Play</span>
              </div>
            </div>
            <div class="pg-name">{{ g.gameName }}</div>
          </NuxtLink>
        </div>

        <div v-if="providerStore.hasMore" class="load-more-wrap">
          <button
            class="load-more-btn"
            :disabled="providerStore.loading"
            @click="providerStore.loadMore()"
          >
            {{ providerStore.loading ? 'Loading…' : 'Load More' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── BINGO ROOMS (by category) ────────────────────────────── -->
    <div v-if="showBingoSection" id="rooms">

      <!-- Loading / error / empty — shown once above all categories -->
      <div class="section">
        <div class="max-container">
          <div v-if="gameStore.loadingGames" class="state-msg">
            <span class="spinner"></span> Loading games…
          </div>
          <div v-else-if="gameStore.error" class="state-msg state-msg--error">
            Could not load games
            <button class="retry-btn" @click="gameStore.fetchAvailableGames()">Retry</button>
          </div>
          <div v-else-if="!filteredGames.length" class="state-msg">
            {{ searchQuery ? 'No games match your search.' : 'No games available right now. Check back soon!' }}
          </div>
        </div>
      </div>

      <!-- Single Bingo section -->
      <div v-if="!gameStore.loadingGames && !gameStore.error && filteredGames.length" class="section">
        <div class="max-container">
          <div class="section-hdr">
            <span class="section-title">Bingo</span>
            <button class="collapse-btn" @click="bingoCollapsed = !bingoCollapsed">
              {{ bingoCollapsed ? 'Expand' : 'Collapse' }}
            </button>
          </div>

          <div v-show="!bingoCollapsed" class="rooms-grid">
            <div
              v-for="(game, idx) in filteredGames"
              :key="game.id"
              class="room-card"
              :style="{ '--delay': `${idx * 60}ms` }"
            >
              <!-- Row 1: Label + Pattern badge -->
              <div class="rc-row-1">
                <span class="rc-ticket-label">TICKET PRICE</span>
                <span class="rc-pattern">{{ patternLabel(game.pattern) }}</span>
              </div>

              <!-- Row 2: Price + Timer/Live -->
              <div class="rc-row-2">
                <div class="rc-price-block">
                  <span class="rc-price">{{ Number(game.ticketPrice).toLocaleString() }}</span>
                  <span class="rc-etb">ETB</span>
                </div>
                <div class="rc-timer" :class="{ 'rc-timer--live': game.status !== 'WAITING' }">
                  <template v-if="game.status !== 'WAITING'">
                    <span class="live-dot-sm"></span>
                    LIVE
                  </template>
                  <template v-else>
                    <GameCountdown
                      v-if="gameStore.countdowns[game.id]"
                      :starts-at="gameStore.countdowns[game.id]"
                      compact
                    />
                    <template v-else>1:00</template>
                  </template>
                </div>
              </div>

              <!-- Row 3: Players + CTA -->
              <div class="rc-row-3">
                <div class="rc-players">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="rc-player-icon">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  {{ gameStore.livePlayers[game.id] ?? (game as any).currentPlayers ?? 0 }} / {{ (game as any).maxPlayers ?? 10 }} players
                </div>
                <button v-if="game.status === 'WAITING'" class="rc-join" @click="handleJoinGame(game.id)">
                  Join Game →
                </button>
                <div v-else class="rc-join rc-join--live">
                  {{ game.status === 'STARTING' ? 'Starting...' : 'Game Live' }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- Auth Prompt Modal -->
    <AuthPromptModal v-model="showAuthPrompt" />
  </div>
</template>

<style scoped>
/* ── Page wrapper ────────────────────────────────────────────────────── */
.lobby-page {
  min-height: 100vh;
  background: #000A38;
  font-family: 'Nunito', sans-serif;
  padding-bottom: 40px;
}

.max-container {
  max-width: 1060px;
  margin: 0 auto;
  padding: 0 20px;
}

/* ── HERO ────────────────────────────────────────────────────────────── */
.hero {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, #020e2e 0%, #061840 50%, #0a254f 100%);
  padding-bottom: 28px;
}

.hero-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 55% 90% at 75% 50%, rgba(255, 215, 0, 0.07) 0%, transparent 65%),
    radial-gradient(ellipse 40% 60% at 15% 40%, rgba(6, 182, 212, 0.06) 0%, transparent 60%);
  pointer-events: none;
}

.hero-inner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 36px;
  padding-bottom: 12px;
  gap: 24px;
}

.hero-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.8);
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 5px 12px;
  border-radius: 20px;
  width: fit-content;
}

.badge-dot {
  width: 7px;
  height: 7px;
  background: #FFD700;
  border-radius: 50%;
  flex-shrink: 0;
  animation: pulse-dot 2s infinite;
}

.hero-title {
  font-family: 'Rajdhani', sans-serif;
  font-size: 52px;
  font-weight: 700;
  color: #fff;
  line-height: 1.05;
  margin: 0;
}

.hero-accent {
  color: #FFD700;
}

@media (max-width: 640px) {
  .hero-title { font-size: 36px; }
}

.hero-sub {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.55);
  margin: 0;
  line-height: 1.55;
  max-width: 380px;
}

.hero-cta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #FFD700;
  color: #000;
  font-weight: 800;
  font-size: 14px;
  padding: 11px 24px;
  border-radius: 10px;
  text-decoration: none;
  width: fit-content;
  transition: background 0.15s, transform 0.15s;
}

.hero-cta:hover {
  background: #e5c500;
  transform: translateY(-1px);
}

/* ── HERO ART ──────────────────────────────────────────────────────── */
.hero-art {
  flex-shrink: 0;
  position: relative;
  height: 210px;
  width: 260px;
}

@media (max-width: 640px) {
  .hero-art { display: none; }
}

.bingo-card {
  position: absolute;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 3px;
  padding: 8px;
  border-radius: 12px;
}

.bingo-card--front {
  width: 148px;
  right: 90px;
  top: 12px;
  transform: rotate(-5deg);
  z-index: 2;
  border: 1px solid rgba(255, 215, 0, 0.45);
  background: rgba(0, 0, 0, 0.38);
  box-shadow: 0 0 24px rgba(255, 215, 0, 0.12);
}

.bingo-card--back {
  width: 120px;
  right: 8px;
  top: 48px;
  transform: rotate(4deg);
  opacity: 0.4;
  z-index: 1;
  border: 1px solid rgba(6, 182, 212, 0.4);
  background: rgba(0, 0, 0, 0.3);
}

.bc-cell {
  aspect-ratio: 1;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
  font-size: 9px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Rajdhani', sans-serif;
}

.bc-cell--blue  { background: #0891b2; color: #fff; }
.bc-cell--gold  { background: #b45309; color: #fff; }
.bc-cell--free  { background: #FFD700; color: #000; font-size: 6px; font-weight: 900; }

.hero-dots {
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: center;
  gap: 5px;
  margin-top: 20px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
}

.dot--active {
  background: #FFD700;
  width: 20px;
  border-radius: 3px;
}

/* ── FEATURED GAME CARD (hero art replacement) ───────────────────────── */
.featured-game-card {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(245,158,11,0.3);
  border-radius: 20px;
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 220px;
  backdrop-filter: blur(8px);
}
.fg-label {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: #f59e0b;
  text-transform: uppercase;
}
.fg-title {
  font-size: 22px;
  font-weight: 800;
  color: #fff;
  line-height: 1.2;
}
.fg-price {
  font-size: 32px;
  font-weight: 900;
  color: #f59e0b;
  line-height: 1;
}
.fg-etb {
  font-size: 16px;
  font-weight: 700;
  color: rgba(245,158,11,0.7);
}
.fg-meta {
  font-size: 13px;
  color: rgba(255,255,255,0.55);
  font-weight: 600;
}
.fg-join {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #f59e0b;
  color: #000;
  font-weight: 800;
  font-size: 14px;
  padding: 10px 20px;
  border-radius: 10px;
  text-decoration: none;
  transition: background 0.15s;
  align-self: flex-start;
}
.fg-join:hover { background: #fbbf24; }
.fg-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #4ade80;
  font-weight: 800;
  font-size: 14px;
}

/* ── TABS BAR ────────────────────────────────────────────────────────── */
.tabs-bar {
  background: rgba(0, 10, 56, 0.85);
  border-bottom: 1px solid #132b5e;
}

.tabs-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tabs-group {
  display: flex;
  align-items: center;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 14px 16px;
  font-size: 13px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.45);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s;
  text-decoration: none;
  font-family: 'Nunito', sans-serif;
  margin-bottom: -1px;
}

.tab:hover { color: rgba(255, 255, 255, 0.75); }

.tab--active {
  color: #FFD700;
  border-bottom-color: #FFD700;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid #1e3a6e;
  border-radius: 8px;
  padding: 7px 14px;
  color: rgba(255, 255, 255, 0.35);
  font-size: 13px;
  font-family: 'Nunito', sans-serif;
  min-width: 200px;
  cursor: text;
  transition: border-color 0.15s;
}

.search-bar:focus-within {
  border-color: rgba(255, 215, 0, 0.4);
}

.search-input {
  background: none;
  border: none;
  outline: none;
  color: rgba(255, 255, 255, 0.75);
  font-size: 13px;
  font-family: 'Nunito', sans-serif;
  width: 100%;
}

.search-input::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

@media (max-width: 640px) { .search-bar { display: none; } }

/* ── SECTIONS ────────────────────────────────────────────────────────── */
.section {
  padding: 22px 0 4px;
}

.section-hdr {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.section-title {
  font-family: 'Rajdhani', sans-serif;
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.01em;
}

.collapse-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid #1e3a6e;
  color: rgba(255, 255, 255, 0.6);
  border-radius: 8px;
  padding: 5px 14px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s;
  font-family: 'Nunito', sans-serif;
}

.collapse-btn:hover { background: rgba(255, 255, 255, 0.1); }

/* ── TOP GAMES SCROLL ────────────────────────────────────────────────── */
.games-scroll {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  padding-bottom: 10px;
  scrollbar-width: none;
  -ms-overflow-style: none;
  margin: 0 -20px;
  padding-left: 20px;
  padding-right: 20px;
}

.games-scroll::-webkit-scrollbar { display: none; }

/* ── GAME CARD (TOP GAMES) ───────────────────────────────────────────── */
.game-card {
  width: 180px;
  flex-shrink: 0;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid #1e3a6e;
  background: rgba(7, 24, 72, 0.8);
  cursor: pointer;
  transition: transform 0.2s, border-color 0.2s;
}

.game-card:hover {
  transform: translateY(-3px);
  border-color: rgba(255, 215, 0, 0.3);
}

.game-card--soon { cursor: default; }
.game-card--soon:hover { transform: none; border-color: #1e3a6e; }

.gc-thumb {
  height: 125px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.gc-thumb--bingo { background: linear-gradient(135deg, #0d1f4a, #1a3a6e); }
.gc-thumb--soon {
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid #1e3a6e;
}

.mini-grid {
  width: 90px;
  padding: 5px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 9px;
  border: 1px solid rgba(255, 215, 0, 0.2);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 2px;
}

.mg-cell {
  aspect-ratio: 1;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 7px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Rajdhani', sans-serif;
}

.mg-cell--m { background: #0891b2; color: #fff; }
.mg-cell--f { background: #FFD700; color: #000; font-size: 5px; font-weight: 900; }

.gc-live-badge {
  position: absolute;
  top: 7px;
  left: 7px;
  background: #ef4444;
  color: #fff;
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 9px;
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: 4px;
  letter-spacing: 0.04em;
}

.live-dot {
  width: 5px;
  height: 5px;
  background: #fff;
  border-radius: 50%;
  animation: blink 1s infinite;
  flex-shrink: 0;
}

.soon-art {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.soon-label {
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.4);
  letter-spacing: 0.08em;
}

.soon-badge {
  position: absolute;
  top: 7px;
  right: 7px;
  background: rgba(139, 92, 246, 0.2);
  border: 1px solid rgba(139, 92, 246, 0.35);
  color: #c4b5fd;
  border-radius: 5px;
  padding: 2px 7px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.gc-info {
  padding: 10px 12px;
}

.gc-name {
  font-family: 'Rajdhani', sans-serif;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
}

.gc-meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  margin-top: 2px;
}

/* ── ROOMS GRID ──────────────────────────────────────────────────────── */
.rooms-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  padding-bottom: 0;
}

@media (min-width: 700px) {
  .rooms-grid {
    grid-template-columns: repeat(3, 1fr);
    padding-bottom: 40px;
  }
}

/* ── ROOM CARD ───────────────────────────────────────────────────────── */
.room-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid #1e3a6e;
  border-radius: 14px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: fadeUp 0.35s ease both;
  animation-delay: var(--delay, 0ms);
  transition: border-color 0.2s;
}

.room-card:hover { border-color: rgba(255, 215, 0, 0.25); }

.rc-row-1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rc-ticket-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.4);
}

.rc-pattern {
  background: rgba(6, 182, 212, 0.1);
  border: 1px solid rgba(6, 182, 212, 0.25);
  color: #06b6d4;
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.rc-row-2 {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
}

.rc-price-block {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.rc-price {
  font-family: 'Rajdhani', sans-serif;
  font-size: 40px;
  font-weight: 700;
  color: #fff;
  line-height: 1;
}

.rc-etb {
  font-size: 15px;
  color: rgba(255, 255, 255, 0.5);
  font-weight: 600;
}

.rc-timer {
  font-family: 'Rajdhani', sans-serif;
  font-size: 26px;
  font-weight: 700;
  color: #FFD700;
  display: flex;
  align-items: center;
  gap: 5px;
  line-height: 1;
}

.rc-timer--live {
  color: #10b981;
  font-size: 16px;
  font-family: 'Nunito', sans-serif;
  font-weight: 800;
}

.live-dot-sm {
  width: 7px;
  height: 7px;
  background: #10b981;
  border-radius: 50%;
  animation: blink 1s infinite;
  flex-shrink: 0;
}

.rc-row-3 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.rc-players {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.55);
  font-weight: 600;
}

.rc-player-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.rc-join {
  background: #FFD700;
  color: #000;
  border: none;
  border-radius: 22px;
  padding: 9px 18px;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.15s;
  display: inline-flex;
  align-items: center;
  font-family: 'Nunito', sans-serif;
  white-space: nowrap;
  flex-shrink: 0;
}

.rc-join:hover { background: #e5c500; }

.rc-join--live {
  background: #10b981;
  color: #fff;
  cursor: default;
}

.rc-join--live:hover { background: #10b981; }

/* ── STATE MESSAGES ──────────────────────────────────────────────────── */
.state-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.5);
  padding: 3rem 0;
  font-size: 14px;
  text-align: center;
}

.state-msg--error { flex-direction: column; color: #ef4444; }

.retry-btn {
  padding: 6px 16px;
  border-radius: 8px;
  background: transparent;
  border: 1px solid rgba(255, 215, 0, 0.4);
  color: #FFD700;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s;
  font-family: 'Nunito', sans-serif;
}

.retry-btn:hover { background: rgba(255, 215, 0, 0.08); }

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-top-color: #FFD700;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

/* ── PROVIDER GAME CARD (Top Games row) ──────────────────────────────── */
.gc-thumb--provider {
  background: #0d1f4a;
  overflow: hidden;
}

.gc-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.gc-placeholder-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.gc-cat-badge {
  position: absolute;
  top: 7px;
  left: 7px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255,255,255,0.15);
  color: rgba(255,255,255,0.8);
  border-radius: 5px;
  padding: 2px 7px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

/* ── PROVIDER GAMES GRID ─────────────────────────────────────────────── */
.provider-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  padding-bottom: 8px;
}

@media (min-width: 480px) { .provider-grid { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 700px) { .provider-grid { grid-template-columns: repeat(4, 1fr); } }
@media (min-width: 900px) { .provider-grid { grid-template-columns: repeat(5, 1fr); } }

.pg-card {
  border-radius: 12px;
  overflow: hidden;
  background: rgba(7, 24, 72, 0.8);
  border: 1px solid #1e3a6e;
  text-decoration: none;
  transition: transform 0.2s, border-color 0.2s;
  cursor: pointer;
}

.pg-card:hover {
  transform: translateY(-3px);
  border-color: rgba(255, 215, 0, 0.3);
}

.pg-thumb {
  aspect-ratio: 3/4;
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, #0d1f4a, #1a3a6e);
  display: flex;
  align-items: center;
  justify-content: center;
}

.pg-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pg-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.pg-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s;
}

.pg-card:hover .pg-overlay { opacity: 1; }

.pg-play-btn {
  background: #FFD700;
  color: #000;
  font-weight: 800;
  font-size: 13px;
  padding: 8px 22px;
  border-radius: 8px;
  font-family: 'Nunito', sans-serif;
}

.pg-name {
  padding: 8px 10px;
  font-family: 'Rajdhani', sans-serif;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.load-more-wrap {
  display: flex;
  justify-content: center;
  padding: 20px 0 8px;
}

.load-more-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid #1e3a6e;
  color: rgba(255, 255, 255, 0.7);
  border-radius: 10px;
  padding: 10px 32px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s;
  font-family: 'Nunito', sans-serif;
}

.load-more-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
.load-more-btn:disabled { opacity: 0.5; cursor: default; }

/* ── KEYFRAMES ───────────────────────────────────────────────────────── */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.2; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
</style>
