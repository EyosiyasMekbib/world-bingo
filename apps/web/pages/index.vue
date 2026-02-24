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

    <!-- ── Page heading ──────────────────────────────────────────────── -->
    <div class="lobby-heading">
      <h2 class="lobby-title">Available Games</h2>
      <p class="lobby-subtitle">Pick a game and join the action</p>
    </div>

    <!-- ── States ────────────────────────────────────────────────────── -->
    <div v-if="gameStore.loadingGames" class="state-message">
      <span class="spinner-lg" />
      Loading games…
    </div>
    <div v-else-if="gameStore.error" class="state-message error-state">
      <svg class="w-5 h-5 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <span>Could not load games — {{ gameStore.error }}</span>
      <button class="retry-btn" @click="gameStore.fetchAvailableGames()">Retry</button>
    </div>
    <div v-else-if="!gameStore.availableGames.length" class="state-message">
      No games available right now. Check back soon!
    </div>

    <!-- ── Games Grid ─────────────────────────────────────────────────── -->
    <div v-else class="games-grid">
      <div
        v-for="(game, idx) in gameStore.availableGames"
        :key="game.id"
        class="game-card"
        :style="{ '--delay': `${idx * 60}ms` }"
      >
        <!-- Card header ribbon -->
        <div class="game-card-ribbon">
          <span class="badge" :class="`badge--${game.status.toLowerCase()}`">{{ game.status }}</span>
          <span class="game-price">{{ game.ticketPrice }} ETB</span>
        </div>

        <!-- Title -->
        <h3 class="game-title">{{ game.title }}</h3>

        <!-- Meta rows -->
        <ul class="game-meta">
          <li>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            <span>{{ (game as any).currentPlayers ?? 0 }} / {{ game.maxPlayers }} players</span>
          </li>
          <li>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h8" /></svg>
            <span>{{ game.pattern }}</span>
          </li>
        </ul>

        <!-- Countdown timer (shown when minPlayers reached) -->
        <GameCountdown
          v-if="gameStore.countdowns[game.id]"
          :starts-at="gameStore.countdowns[game.id]"
        />

        <!-- CTA -->
        <NuxtLink :to="`/quick/${game.id}`" class="join-btn">
          Join Game
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
        </NuxtLink>
      </div>
    </div>

    <!-- Modals — triggered from header (default layout) -->
    <DepositModal v-model="showDeposit" @deposited="(auth as any).fetchWallet()" />
    <WithdrawalModal
      v-model="showWithdraw"
      :balance="Number(auth.wallet?.balance ?? 0)"
      @withdrawn="(auth as any).fetchWallet()"
    />
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

const showDeposit = ref(false)
const showWithdraw = ref(false)

// T59 — Progressive jackpot
const jackpotAmount = ref(0)
const jackpotWinner = ref<{ winnerId: string; amount: number } | null>(null)

const fetchJackpot = async () => {
  try {
    const data = await $fetch<{ amount: number }>(`${config.public.apiBase}/jackpot`)
    jackpotAmount.value = data.amount
  } catch { /* non-critical */ }
}

// Initial fetch — swallow errors so the page still renders when the API is down
try {
  await Promise.all([gameStore.fetchAvailableGames(), fetchJackpot()])
} catch { /* errors are stored in gameStore.error */ }

onMounted(() => {
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
  padding: 1.5rem 2rem 3rem;
  max-width: 1200px;
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
  padding: 1rem 1.5rem;
  margin-bottom: 2rem;
  flex-wrap: wrap;
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 24px rgba(124, 58, 237, 0.15);
}
.jackpot-banner-inner {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}
.jackpot-label {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #c4b5fd;
}
.jackpot-amount {
  font-size: 1.75rem;
  font-weight: 900;
  color: #fbbf24;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-game, 'Rajdhani', sans-serif);
  text-shadow: 0 0 20px rgba(251, 191, 36, 0.4);
}
.jackpot-hint {
  font-size: 0.78rem;
  color: #9ca3af;
}

/* ── Lobby heading ───────────────────────────────────────────────────── */
.lobby-heading {
  margin-bottom: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.lobby-title {
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  margin: 0;
  letter-spacing: -0.01em;
}
.lobby-subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary, #94a3b8);
  margin: 0;
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
  flex-wrap: wrap;
}
.retry-btn {
  padding: 0.3rem 0.9rem;
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

/* ── Games grid ──────────────────────────────────────────────────────── */
.games-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.25rem;
}

/* ── Game card ───────────────────────────────────────────────────────── */
.game-card {
  background: rgba(17, 24, 39, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 16px;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  backdrop-filter: blur(8px);
  transition: border-color 0.25s, transform 0.25s var(--ease-out, cubic-bezier(0.16,1,0.3,1)), box-shadow 0.25s;
  animation: card-fadein 0.4s var(--ease-out) both;
  animation-delay: var(--delay, 0ms);
}
.game-card:hover {
  border-color: rgba(245, 158, 11, 0.5);
  transform: translateY(-3px);
  box-shadow: 0 12px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(245,158,11,0.15);
}
@keyframes card-fadein {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}

.game-card-ribbon {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.game-price {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--brand-primary, #f59e0b);
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.25);
  padding: 0.2rem 0.6rem;
  border-radius: 20px;
}

.game-title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary, #f1f5f9);
  margin: 0;
  letter-spacing: -0.01em;
}

.game-meta {
  list-style: none;
  padding: 0; margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.game-meta li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--text-secondary, #94a3b8);
}
.game-meta li svg {
  width: 14px; height: 14px;
  flex-shrink: 0;
  color: var(--text-disabled, #475569);
}

/* Status badges */
.badge {
  font-size: 0.7rem;
  padding: 0.2rem 0.55rem;
  border-radius: 20px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.badge--waiting    { background: rgba(234,179,8,0.12); color: #fbbf24; }
.badge--in_progress { background: rgba(34,197,94,0.12); color: #4ade80; }
.badge--starting   { background: rgba(99,102,241,0.12); color: #a5b4fc; }
.badge--finished   { background: rgba(148,163,184,0.1); color: #94a3b8; }

/* CTA */
.join-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  margin-top: auto;
  padding: 0.6rem 1.1rem;
  background: var(--brand-primary, #f59e0b);
  color: #000;
  text-decoration: none;
  border-radius: 10px;
  font-weight: 700;
  font-size: 0.88rem;
  transition: background 0.2s, box-shadow 0.2s, transform 0.15s;
  box-shadow: 0 0 14px rgba(245, 158, 11, 0.2);
}
.join-btn svg { width: 14px; height: 14px; }
.join-btn:hover {
  background: #fbbf24;
  box-shadow: 0 0 24px rgba(245, 158, 11, 0.4);
  transform: translateY(-1px);
}

/* ── Responsive ──────────────────────────────────────────────────────── */
@media (max-width: 640px) {
  .lobby-page { padding: 1rem 1rem 2rem; }
  .jackpot-banner { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
  .jackpot-amount { font-size: 1.4rem; }
}
</style>
