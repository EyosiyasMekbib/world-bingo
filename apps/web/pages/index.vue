<template>
  <div class="lobby-page">

    <!-- ── Jackpot Winner Toast ───────────────────────────────────────── -->
    <Transition name="toast-pop">
      <div v-if="jackpotWinner" class="jackpot-toast" role="status">
        🎰 JACKPOT! Someone just won
        <strong>{{ jackpotWinner.amount.toFixed(2) }} ETB</strong>!
      </div>
    </Transition>

    <!-- ── Progressive Jackpot Banner ───────────────────────────────── -->
    <div class="jackpot-banner">
      <div class="jackpot-banner-inner">
        <span class="jackpot-label">🎰 Progressive Jackpot</span>
        <span class="jackpot-amount">{{ jackpotAmount.toFixed(2) }} ETB</span>
      </div>
      <span class="jackpot-hint">Full card in ≤ 20 balls to win!</span>
    </div>

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
            <span class="game-label">{{ patternLabel(game.pattern) }}</span>
            <span class="game-value game-value--time">
              <GameCountdown
                v-if="gameStore.countdowns[game.id]"
                :starts-at="gameStore.countdowns[game.id]"
                compact
              />
              <template v-else>1:00</template>
            </span>
          </div>
        </div>

        <!-- Bottom row: players + CTA -->
        <div class="game-card-bottom">
          <div class="player-count">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="player-icon">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span>{{ (game as any).currentPlayers ?? 0 }}</span>
          </div>
          <NuxtLink :to="`/quick/${game.id}`" class="join-btn">
            Join Game
          </NuxtLink>
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

// T59 — Progressive jackpot
const jackpotAmount = ref(0)
const jackpotWinner = ref<{ winnerId: string; amount: number } | null>(null)

const fetchJackpot = async () => {
  try {
    const data = await $fetch<{ amount: number }>(`${config.public.apiBase}/jackpot`)
    jackpotAmount.value = data.amount
  } catch { /* non-critical */ }
}

// Fetch data on mount to avoid top-level await issues with ssr:false
onMounted(async () => {
  try {
    await Promise.all([gameStore.fetchAvailableGames(), fetchJackpot()])
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

  // Listen for countdown events (game reached minPlayers, 60s countdown started)
  socket.on('game:countdown', (payload: { gameId: string; countdownSecs: number; startsAt: string }) => {
    gameStore.onGameCountdown(payload)
  })

  // T59 — Listen for jackpot updates
  socket.on('jackpot:update', ({ amount }: { amount: number }) => {
    jackpotAmount.value = amount
  })

  socket.on('jackpot:won', (payload: { winnerId: string; amount: number }) => {
    jackpotWinner.value = payload
    jackpotAmount.value = 0
    // Auto-dismiss after 8s
    setTimeout(() => { jackpotWinner.value = null }, 8000)
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
  padding: 1rem 1rem 3rem;
  max-width: 600px;
  margin: 0 auto;
}

/* ── Jackpot toast ───────────────────────────────────────────────────── */
.jackpot-toast {
  position: fixed;
  top: 4.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  background: linear-gradient(135deg, #7c3aed, #dc2626);
  color: white;
  padding: 0.875rem 1.75rem;
  border-radius: 14px;
  font-size: 1rem;
  font-weight: 600;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  white-space: nowrap;
}
.toast-pop-enter-active { transition: opacity 0.4s, transform 0.4s var(--ease-bounce, cubic-bezier(0.34,1.56,0.64,1)); }
.toast-pop-enter-from   { opacity: 0; transform: translateX(-50%) translateY(-20px) scale(0.9); }
.toast-pop-leave-active { transition: opacity 0.3s, transform 0.3s; }
.toast-pop-leave-to     { opacity: 0; transform: translateX(-50%) translateY(-12px); }

/* ── Jackpot banner ──────────────────────────────────────────────────── */
.jackpot-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: linear-gradient(120deg, rgba(26,5,51,0.85) 0%, rgba(59,7,100,0.85) 100%);
  border: 1px solid rgba(167, 139, 250, 0.3);
  border-radius: 14px;
  padding: 1rem 1.25rem;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 24px rgba(124, 58, 237, 0.15);
}
.jackpot-banner-inner {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.jackpot-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #c4b5fd;
}
.jackpot-amount {
  font-size: 1.5rem;
  font-weight: 900;
  color: #fbbf24;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-game, 'Rajdhani', sans-serif);
  text-shadow: 0 0 20px rgba(251, 191, 36, 0.4);
}
.jackpot-hint {
  font-size: 0.72rem;
  color: #9ca3af;
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

/* ── Games list — stacked cards like reference app ───────────────────── */
.games-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* ── Game card — ticket/time layout ──────────────────────────────────── */
.game-card {
  background: linear-gradient(135deg, #1a2550 0%, #1e3060 100%);
  border: 1.5px solid rgba(255, 255, 255, 0.12);
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
  border-color: rgba(251, 191, 36, 0.5);
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
  color: rgba(255, 255, 255, 0.5);
}

.game-value {
  font-size: 1.35rem;
  font-weight: 800;
  color: #fff;
  font-family: var(--font-game, 'Rajdhani', sans-serif);
  line-height: 1.2;
}

.game-value--time {
  color: #fbbf24;
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
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
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
  color: rgba(255, 255, 255, 0.6);
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
  box-shadow: 0 2px 12px rgba(245, 158, 11, 0.3);
  letter-spacing: 0.01em;
}
.join-btn:hover {
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  box-shadow: 0 4px 20px rgba(245, 158, 11, 0.5);
  transform: translateY(-1px);
}

/* ── Responsive ──────────────────────────────────────────────────────── */
@media (min-width: 640px) {
  .lobby-page { max-width: 600px; padding: 1.5rem 1.5rem 3rem; }
}
</style>
