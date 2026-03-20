<script setup lang="ts">
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import type { Game } from '@world-bingo/shared-types'

const auth = useAuthStore()
const gameStore = useGameStore()
const { connect } = useSocket()
const config = useRuntimeConfig()
const { patternLabel, patternIcon } = usePatternLabel()

// Fetch data on mount
onMounted(async () => {
  try {
    await gameStore.fetchAvailableGames()
  } catch { /* errors are stored in gameStore.error */ }

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
    <div class="hero">
      <div class="hero-bg"></div>
      <div class="hero-grid-overlay"></div>
      <div class="hero-content">
        <div class="hero-text">
          <div class="hero-badge">
            <svg width="8" height="8" viewBox="0 0 8 8" style="flex-shrink:0">
              <circle cx="4" cy="4" r="4" fill="#FFD700" />
            </svg>
            Now Live
          </div>
          <h1 class="hero-title">Play Bingo,<br><span>Win Real ETB</span></h1>
          <p class="hero-sub">Join thousands of players. Real money, real wins.</p>
          <NuxtLink to="/" class="hero-cta">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0">
              <path d="M8 5v14l11-7z" />
            </svg>
            Play Now
          </NuxtLink>
        </div>
        <div class="hero-art">
          <div class="bingo-preview">
            <div class="bp-cell">7</div>
            <div class="bp-cell m">23</div>
            <div class="bp-cell">41</div>
            <div class="bp-cell">54</div>
            <div class="bp-cell m">68</div>
            <div class="bp-cell m">12</div>
            <div class="bp-cell">29</div>
            <div class="bp-cell m">43</div>
            <div class="bp-cell">58</div>
            <div class="bp-cell">71</div>
            <div class="bp-cell">3</div>
            <div class="bp-cell m">30</div>
            <div class="bp-cell f">FREE</div>
            <div class="bp-cell">60</div>
            <div class="bp-cell m">75</div>
            <div class="bp-cell">14</div>
            <div class="bp-cell">27</div>
            <div class="bp-cell">44</div>
            <div class="bp-cell m">57</div>
            <div class="bp-cell">72</div>
            <div class="bp-cell m">9</div>
            <div class="bp-cell">32</div>
            <div class="bp-cell">46</div>
            <div class="bp-cell">62</div>
            <div class="bp-cell m">74</div>
          </div>
          <div class="bingo-preview bingo-preview--2">
            <div class="bp-cell">5</div>
            <div class="bp-cell">18</div>
            <div class="bp-cell">38</div>
            <div class="bp-cell m">51</div>
            <div class="bp-cell">66</div>
            <div class="bp-cell">11</div>
            <div class="bp-cell m">25</div>
            <div class="bp-cell">40</div>
            <div class="bp-cell">55</div>
            <div class="bp-cell">70</div>
            <div class="bp-cell m">6</div>
            <div class="bp-cell">28</div>
            <div class="bp-cell f">FREE</div>
            <div class="bp-cell m">59</div>
            <div class="bp-cell">73</div>
            <div class="bp-cell">13</div>
            <div class="bp-cell">26</div>
            <div class="bp-cell m">45</div>
            <div class="bp-cell">56</div>
            <div class="bp-cell">69</div>
            <div class="bp-cell">8</div>
            <div class="bp-cell m">31</div>
            <div class="bp-cell">47</div>
            <div class="bp-cell">63</div>
            <div class="bp-cell">72</div>
          </div>
        </div>
      </div>
      <div class="hero-dots">
        <span class="dot dot--active"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    </div>

    <!-- ── BONUS STRIP ────────────────────────────────────────── -->
    <div class="bonus-strip">
      <div class="bonus-text">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
          <polyline points="20 12 20 22 4 22 4 12" />
          <rect x="2" y="7" width="20" height="5" />
          <line x1="12" y1="22" x2="12" y2="7" />
          <path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z" />
          <path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z" />
        </svg>
        <span>100% bonus on first deposit</span>
      </div>
      <button class="bonus-btn" @click="$emit('deposit')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="flex-shrink:0">
          <path d="M12 4v16m8-8H4" />
        </svg>
        Claim Now
      </button>
    </div>

    <!-- ── GAME TYPE TABS ─────────────────────────────────────── -->
    <div class="game-tabs-bar">
      <div class="game-tabs">
        <button class="gtab gtab--active">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
          Lobby
        </button>
        <NuxtLink v-if="true" to="/tournaments" class="gtab">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9H4.5a2.5 2.5 0 010-5H6" />
            <path d="M18 9h1.5a2.5 2.5 0 000-5H18" />
            <path d="M4 22h16" />
            <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
            <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
            <path d="M18 2H6v7a6 6 0 0012 0V2z" />
          </svg>
          Tournaments
        </NuxtLink>
      </div>
      <div class="search-bar hidden sm:flex">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; opacity:0.4">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span>Search games…</span>
      </div>
    </div>

    <!-- ── TOP GAMES ROW ──────────────────────────────────────── -->
    <div class="section">
      <div class="section-hdr">
        <span class="section-title">Top Games</span>
      </div>
      <div class="games-scroll">

        <!-- Bingo — LIVE -->
        <div class="game-card-mini">
          <div class="gcm-thumb gcm-thumb--bingo">
            <div class="thumb-grid">
              <div class="tc">7</div>
              <div class="tc m">23</div>
              <div class="tc">41</div>
              <div class="tc">54</div>
              <div class="tc m">68</div>
              <div class="tc m">12</div>
              <div class="tc">29</div>
              <div class="tc m">43</div>
              <div class="tc">58</div>
              <div class="tc">71</div>
              <div class="tc">3</div>
              <div class="tc m">30</div>
              <div class="tc f">FR</div>
              <div class="tc">60</div>
              <div class="tc m">75</div>
              <div class="tc">14</div>
              <div class="tc">27</div>
              <div class="tc">44</div>
              <div class="tc m">57</div>
              <div class="tc">72</div>
              <div class="tc m">9</div>
              <div class="tc">32</div>
              <div class="tc">46</div>
              <div class="tc">62</div>
              <div class="tc m">74</div>
            </div>
            <div class="live-badge"><span class="live-dot"></span> LIVE</div>
          </div>
          <div class="gcm-info">
            <div class="gcm-name">Bingo</div>
            <div class="gcm-meta">Live now</div>
          </div>
        </div>

        <!-- Aviator — Coming Soon -->
        <div class="game-card-mini game-card-mini--soon">
          <div class="gcm-thumb gcm-thumb--soon">
            <div class="cs-art">
              <span class="cs-icon">✈️</span>
              <span class="cs-label">AVIATOR</span>
            </div>
            <div class="soon-badge">Soon</div>
          </div>
          <div class="gcm-info">
            <div class="gcm-name">Aviator</div>
            <div class="gcm-meta">Coming soon</div>
          </div>
        </div>

        <!-- Slots -->
        <div class="game-card-mini game-card-mini--soon">
          <div class="gcm-thumb gcm-thumb--soon">
            <div class="cs-art">
              <span class="cs-icon">🎰</span>
              <span class="cs-label">SLOTS</span>
            </div>
            <div class="soon-badge">Soon</div>
          </div>
          <div class="gcm-info">
            <div class="gcm-name">Slots</div>
            <div class="gcm-meta">Coming soon</div>
          </div>
        </div>

        <!-- Crash -->
        <div class="game-card-mini game-card-mini--soon">
          <div class="gcm-thumb gcm-thumb--soon">
            <div class="cs-art">
              <span class="cs-icon">🚀</span>
              <span class="cs-label">CRASH</span>
            </div>
            <div class="soon-badge">Soon</div>
          </div>
          <div class="gcm-info">
            <div class="gcm-name">Crash</div>
            <div class="gcm-meta">Coming soon</div>
          </div>
        </div>

        <!-- Cards -->
        <div class="game-card-mini game-card-mini--soon">
          <div class="gcm-thumb gcm-thumb--soon">
            <div class="cs-art">
              <span class="cs-icon">🃏</span>
              <span class="cs-label">CARDS</span>
            </div>
            <div class="soon-badge">Soon</div>
          </div>
          <div class="gcm-info">
            <div class="gcm-name">Cards</div>
            <div class="gcm-meta">Coming soon</div>
          </div>
        </div>

      </div>
    </div>

    <!-- ── LIVE ROOMS ──────────────────────────────────────────── -->
    <div class="section">
      <div class="section-hdr">
        <span class="section-title">Live Rooms</span>
      </div>

      <div v-if="gameStore.loadingGames" class="state-msg">
        <span class="spinner-lg"></span> Loading games…
      </div>
      <div v-else-if="gameStore.error" class="state-msg state-msg--error">
        Could not load games
        <button class="retry-btn" @click="gameStore.fetchAvailableGames()">Retry</button>
      </div>
      <div v-else-if="!gameStore.availableGames.length" class="state-msg">
        No games available right now. Check back soon!
      </div>

      <div v-else class="rooms-list">
        <div
          v-for="(game, idx) in gameStore.availableGames"
          :key="game.id"
          class="room-card"
          :style="{ '--delay': `${idx * 60}ms` }"
        >
          <div class="rc-top">
            <div class="rc-left">
              <span class="rc-lbl">TICKET</span>
              <span class="rc-price">{{ Number(game.ticketPrice).toLocaleString() }} <span class="rc-birr">Birr</span></span>
            </div>
            <div class="rc-right">
              <span class="rc-pattern">{{ patternLabel(game.pattern) }}</span>
              <span class="rc-timer" :class="{ 'rc-timer--live': game.status !== 'WAITING' }">
                <GameCountdown
                  v-if="gameStore.countdowns[game.id]"
                  :starts-at="gameStore.countdowns[game.id]"
                  compact
                />
                <template v-else>
                  {{ game.status === 'WAITING' ? '1:00' : 'LIVE' }}
                </template>
              </span>
            </div>
          </div>
          <div class="rc-bottom">
            <div class="rc-players">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="rc-player-icon">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span>{{ gameStore.livePlayers[game.id] ?? (game as any).currentPlayers ?? 0 }}</span>
            </div>
            <NuxtLink v-if="game.status === 'WAITING'" :to="`/quick/${game.id}`" class="rc-join">
              Join Game →
            </NuxtLink>
            <div v-else class="rc-join rc-join--live">
              {{ game.status === 'STARTING' ? 'Starting...' : 'Game Live' }}
            </div>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* ── Page wrapper ────────────────────────────────────────────────────── */
.lobby-page {
  min-height: 100vh;
  background: #000A38;
  font-family: 'Nunito', sans-serif;
  padding-bottom: 80px;
}

/* ── HERO ────────────────────────────────────────────────────────────── */
.hero {
  position: relative;
  overflow: hidden;
  height: 160px;
  background: linear-gradient(135deg, #020e2e 0%, #061840 40%, #0a254f 100%);
}

@media (min-width: 640px) {
  .hero {
    height: 220px;
  }
}

.hero-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 60% 80% at 80% 50%, rgba(255, 215, 0, 0.08) 0%, transparent 70%),
    radial-gradient(ellipse 50% 60% at 20% 50%, rgba(6, 182, 212, 0.07) 0%, transparent 60%);
  pointer-events: none;
}

.hero-grid-overlay {
  position: absolute;
  inset: 0;
  opacity: 0.05;
  background-image:
    linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px);
  background-size: 32px 32px;
  pointer-events: none;
}

.hero-content {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  padding: 0 18px;
  gap: 12px;
}

.hero-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: rgba(255, 215, 0, 0.1);
  border: 1px solid rgba(255, 215, 0, 0.3);
  color: #FFD700;
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 3px 8px;
  border-radius: 20px;
  width: fit-content;
}

.hero-title {
  font-family: 'Rajdhani', sans-serif;
  font-size: 28px;
  font-weight: 700;
  color: #fff;
  line-height: 1.1;
  margin: 0;
}

.hero-title span {
  color: #FFD700;
}

@media (min-width: 640px) {
  .hero-title {
    font-size: 42px;
  }
}

.hero-sub {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  margin: 0;
  line-height: 1.4;
}

@media (min-width: 640px) {
  .hero-sub {
    font-size: 13px;
  }
}

.hero-cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #FFD700;
  color: #000;
  font-weight: 800;
  font-size: 12px;
  padding: 7px 14px;
  border-radius: 8px;
  text-decoration: none;
  width: fit-content;
  transition: background 0.15s, transform 0.15s;
}

.hero-cta:hover {
  background: #cca800;
  transform: translateY(-1px);
}

.hero-art {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  position: relative;
}

.bingo-preview {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 3px;
  width: 108px;
  padding: 6px;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 10px;
  border: 1px solid rgba(255, 215, 0, 0.35);
  box-shadow: 0 0 18px rgba(255, 215, 0, 0.12);
  transform: rotate(-5deg);
  flex-shrink: 0;
}

.bingo-preview--2 {
  opacity: 0.35;
  transform: rotate(3deg) translateY(12px) translateX(-16px);
  width: 88px;
  border-color: rgba(6, 182, 212, 0.4);
  box-shadow: 0 0 12px rgba(6, 182, 212, 0.08);
}

.bp-cell {
  aspect-ratio: 1;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 8px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Rajdhani', sans-serif;
}

.bp-cell.m {
  background: #0891b2;
  color: #fff;
}

.bp-cell.f {
  background: #FFD700;
  color: #000;
  font-size: 6px;
  font-weight: 800;
}

.hero-dots {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 5px;
  z-index: 2;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.25);
}

.dot--active {
  background: #FFD700;
  width: 16px;
  border-radius: 3px;
}

/* ── BONUS STRIP ─────────────────────────────────────────────────────── */
.bonus-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  background: linear-gradient(90deg, rgba(255, 215, 0, 0.07) 0%, rgba(255, 215, 0, 0.03) 100%);
  border-bottom: 1px solid rgba(255, 215, 0, 0.2);
}

.bonus-text {
  display: flex;
  align-items: center;
  gap: 8px;
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  font-weight: 600;
}

.bonus-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: #FFD700;
  color: #000;
  font-weight: 800;
  font-size: 11px;
  padding: 5px 12px;
  border-radius: 20px;
  border: none;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}

.bonus-btn:hover {
  background: #cca800;
}

/* ── GAME TYPE TABS ──────────────────────────────────────────────────── */
.game-tabs-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #132b5e;
  background: rgba(0, 10, 56, 0.7);
  padding: 0 18px;
}

.game-tabs {
  display: flex;
  align-items: center;
}

.gtab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.45);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  text-decoration: none;
  font-family: 'Nunito', sans-serif;
}

.gtab:hover {
  color: rgba(255, 255, 255, 0.75);
}

.gtab--active {
  color: #FFD700;
  border-bottom-color: #FFD700;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid #132b5e;
  border-radius: 8px;
  padding: 6px 12px;
  color: rgba(255, 255, 255, 0.35);
  font-size: 12px;
  font-family: 'Nunito', sans-serif;
}

/* ── SECTIONS ────────────────────────────────────────────────────────── */
.section {
  padding: 16px 0 8px;
}

.section-hdr {
  padding: 0 18px;
  margin-bottom: 12px;
}

.section-title {
  font-family: 'Rajdhani', sans-serif;
  font-size: 17px;
  font-weight: 700;
  color: #fff;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

@media (min-width: 640px) {
  .section {
    max-width: 680px;
    margin: 0 auto;
    width: 100%;
    padding: 16px 0 8px;
  }
}

/* ── GAMES SCROLL ROW ────────────────────────────────────────────────── */
.games-scroll {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 0 18px 8px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.games-scroll::-webkit-scrollbar {
  display: none;
}

/* ── GAME CARD MINI ──────────────────────────────────────────────────── */
.game-card-mini {
  width: 130px;
  flex-shrink: 0;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid #132b5e;
  cursor: pointer;
  transition: transform 0.2s, border-color 0.2s;
}

.game-card-mini:hover {
  transform: translateY(-3px);
  border-color: rgba(255, 215, 0, 0.3);
}

.gcm-thumb {
  height: 95px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.gcm-thumb--bingo {
  background: linear-gradient(135deg, #0d1f4a, #1a3a6e);
}

.gcm-thumb--soon {
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px dashed #132b5e;
}

.thumb-grid {
  width: 76px;
  padding: 4px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  border: 1px solid rgba(255, 215, 0, 0.2);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 2px;
}

.tc {
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

.tc.m {
  background: #0891b2;
  color: #fff;
}

.tc.f {
  background: #FFD700;
  color: #000;
  font-size: 5px;
  font-weight: 800;
}

.live-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: #ef4444;
  color: #fff;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 9px;
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: 3px;
  font-family: 'Nunito', sans-serif;
  letter-spacing: 0.05em;
}

.live-dot {
  width: 5px;
  height: 5px;
  background: #fff;
  border-radius: 50%;
  animation: blink 1s infinite;
  flex-shrink: 0;
}

.cs-art {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 100%;
  width: 100%;
}

.cs-icon {
  font-size: 26px;
  opacity: 0.7;
  line-height: 1;
}

.cs-label {
  font-size: 9px;
  font-weight: 800;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.4);
  letter-spacing: 0.08em;
  font-family: 'Nunito', sans-serif;
}

.soon-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(139, 92, 246, 0.25);
  border: 1px solid rgba(139, 92, 246, 0.35);
  color: #c4b5fd;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 8px;
  font-weight: 800;
  font-family: 'Nunito', sans-serif;
  letter-spacing: 0.04em;
}

.gcm-info {
  padding: 8px 10px;
  background: #071848;
}

.gcm-name {
  font-family: 'Rajdhani', sans-serif;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  line-height: 1.2;
}

.gcm-meta {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.4);
  margin-top: 1px;
}

/* ── ROOMS LIST ──────────────────────────────────────────────────────── */
.rooms-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 18px 80px;
}

@media (min-width: 640px) {
  .rooms-list {
    max-width: 680px;
    margin: 0 auto;
    width: 100%;
    padding: 0 18px 40px;
  }
}

/* ── ROOM CARD ───────────────────────────────────────────────────────── */
.room-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid #132b5e;
  border-radius: 14px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: fadeUp 0.35s ease both;
  animation-delay: var(--delay, 0ms);
  cursor: pointer;
  transition: border-color 0.2s;
}

.room-card:hover {
  border-color: rgba(255, 215, 0, 0.3);
}

.rc-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.rc-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rc-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.rc-lbl {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.4);
  font-family: 'Nunito', sans-serif;
}

.rc-price {
  font-family: 'Rajdhani', sans-serif;
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  line-height: 1.1;
}

.rc-birr {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.4);
  font-weight: 600;
}

.rc-pattern {
  background: rgba(6, 182, 212, 0.1);
  border: 1px solid rgba(6, 182, 212, 0.2);
  color: #06b6d4;
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 700;
  font-family: 'Nunito', sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.rc-timer {
  font-family: 'Rajdhani', sans-serif;
  font-size: 20px;
  font-weight: 700;
  color: #FFD700;
  line-height: 1;
}

.rc-timer--live {
  color: #ef4444;
  text-shadow: 0 0 8px rgba(239, 68, 68, 0.4);
}

.rc-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rc-players {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 6px 12px;
  font-weight: 700;
  font-family: 'Nunito', sans-serif;
}

.rc-player-icon {
  width: 14px;
  height: 14px;
  color: rgba(255, 255, 255, 0.4);
}

.rc-join {
  background: #FFD700;
  color: #000;
  border: none;
  border-radius: 20px;
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.15s;
  display: inline-flex;
  align-items: center;
  font-family: 'Nunito', sans-serif;
}

.rc-join:hover {
  background: #cca800;
}

.rc-join--live {
  background: #10b981;
  color: #fff;
  cursor: default;
}

.rc-join--live:hover {
  background: #10b981;
}

/* ── STATE MESSAGES ──────────────────────────────────────────────────── */
.state-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.5);
  padding: 3rem 18px;
  font-size: 14px;
  text-align: center;
  font-family: 'Nunito', sans-serif;
}

.state-msg--error {
  flex-direction: column;
  color: #ef4444;
}

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

.retry-btn:hover {
  background: rgba(255, 215, 0, 0.08);
}

.spinner-lg {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-top-color: #FFD700;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

/* ── KEYFRAMES ───────────────────────────────────────────────────────── */
@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
