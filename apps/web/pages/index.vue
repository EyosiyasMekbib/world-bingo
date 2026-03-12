<template>
  <div class="lobby-page">

    <!-- ── States ────────────────────────────────────────────────────── -->
    <div v-if="gameStore.loadingGames" class="state-message">
      <span class="spinner-lg" />
      Loading games…
    </div>
    <div v-else-if="gameStore.error" class="state-message error-state">
      <span>⚠️ Could not load games</span>
      <button class="retry-btn" @click="gameStore.fetchAvailableGames()">Retry</button>
    </div>
    <div v-else-if="!gameStore.availableGames.length" class="state-message">
      No games available right now. Check back soon!
    </div>

    <!-- ── Games List ─────────────────────────────────────────────────── -->
    <div v-else class="games-list">
      <div
        v-for="(game, idx) in gameStore.availableGames"
        :key="game.id"
        class="game-card"
        :style="{ '--delay': `${idx * 60}ms` }"
      >
        <!-- Top row: ticket + time -->
        <div class="game-card-top">
          <div class="game-card-col">
            <span class="game-label">TICKET</span>
            <span class="game-value">{{ Number(game.ticketPrice).toLocaleString() }} Birr</span>
          </div>
          <div class="game-card-col game-card-col--right">
            <span class="game-pattern-badge">{{ patternLabel(game.pattern) }}</span>
            <span class="game-value game-value--time" :class="{ 'game-value--live': game.status !== 'WAITING' }">
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

        <!-- Bottom row: players + CTA -->
        <div class="game-card-bottom">
          <div class="player-count">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="player-icon">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span>{{ gameStore.livePlayers[game.id] ?? (game as any).currentPlayers ?? 0 }}</span>
          </div>
          <NuxtLink v-if="game.status === 'WAITING'" :to="`/quick/${game.id}`" class="join-btn">
            Join Game
          </NuxtLink>
          <div v-else class="join-btn join-btn--live">
            {{ game.status === 'STARTING' ? 'Starting...' : 'Game Live' }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

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

<style scoped>
/* ── Page wrapper ────────────────────────────────────────────────────── */
.lobby-page {
  padding: 1.5rem 1rem 3rem;
  max-width: 600px;
  margin: 0 auto;
}

/* ── Loading / empty state ───────────────────────────────────────────── */
.state-message {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  text-align: center;
  color: var(--text-secondary, #94a3b8);
  padding: 4rem 0;
  font-size: 0.95rem;
}
.error-state {
  color: #f87171;
  flex-direction: column;
  gap: 1rem;
}
.retry-btn {
  padding: 0.4rem 1rem;
  border-radius: 8px;
  background: rgba(248, 113, 113, 0.15);
  border: 1px solid rgba(248, 113, 113, 0.3);
  color: #f87171;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}
.retry-btn:hover { background: rgba(248, 113, 113, 0.25); }
.spinner-lg {
  width: 20px; height: 20px;
  border: 2px solid rgba(255,255,255,0.1);
  border-top-color: var(--brand-primary, #f59e0b);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Games list ──────────────────────────────────────────────────────── */
.games-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* ── Game card — matches profile/wallet card style ───────────────────── */
.game-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  padding: 1.25rem 1.25rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  transition: border-color 0.25s, transform 0.25s;
  animation: card-fadein 0.4s ease both;
  animation-delay: var(--delay, 0ms);
}
.game-card:hover {
  border-color: rgba(245, 158, 11, 0.35);
  transform: translateY(-2px);
}
@keyframes card-fadein {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

.game-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.game-card-col {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.game-card-col--right {
  text-align: right;
  align-items: flex-end;
}

.game-label {
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.45);
}

.game-value {
  font-size: 1.35rem;
  font-weight: 800;
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-game, 'Rajdhani', sans-serif);
  line-height: 1.2;
}

.game-value--time {
  color: #fbbf24;
}

.game-value--live {
  color: #f87171;
  text-shadow: 0 0 8px rgba(248, 113, 113, 0.4);
}

.game-pattern-badge {
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.15rem 0.5rem;
  border-radius: 20px;
  background: rgba(201, 169, 110, 0.12);
  color: var(--color-primary, #c9a96e);
}

.game-card-bottom {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.player-count {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 0.5rem 0.85rem;
  font-size: 0.9rem;
  font-weight: 700;
  color: #fff;
  min-width: 60px;
  justify-content: center;
}

.player-icon {
  width: 16px;
  height: 16px;
  color: rgba(255, 255, 255, 0.5);
}

/* CTA */
.join-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.65rem 1rem;
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #000;
  text-decoration: none;
  border-radius: 50px;
  font-weight: 700;
  font-size: 0.95rem;
  transition: background 0.2s, box-shadow 0.2s, transform 0.15s;
  box-shadow: 0 2px 12px rgba(245, 158, 11, 0.25);
  letter-spacing: 0.01em;
}
.join-btn:hover {
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  box-shadow: 0 4px 20px rgba(245, 158, 11, 0.45);
  transform: translateY(-1px);
}

.join-btn--live {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.4);
  cursor: default;
  box-shadow: none;
}
.join-btn--live:hover {
  transform: none;
  background: rgba(255, 255, 255, 0.04);
}

/* ── Responsive ──────────────────────────────────────────────────────── */
@media (min-width: 640px) {
  .lobby-page { max-width: 600px; padding: 1.5rem 1.5rem 3rem; }
}
</style>
