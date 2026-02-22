<template>
  <div class="lobby-page">
    <!-- T59 — Progressive Jackpot Banner -->
    <Transition name="jackpot-fade">
      <div v-if="jackpotWinner" class="jackpot-win-toast">
        🎰 JACKPOT! Someone just won <strong>{{ jackpotWinner.amount.toFixed(2) }} ETB</strong>!
      </div>
    </Transition>

    <div class="jackpot-banner">
      <span class="jackpot-label">🎰 Progressive Jackpot</span>
      <span class="jackpot-amount">{{ jackpotAmount.toFixed(2) }} ETB</span>
      <span class="jackpot-hint">Win with a full card in ≤ 20 balls!</span>
    </div>

    <div class="lobby-header">
      <h2>Available Games</h2>
      <div class="wallet-summary" v-if="auth.wallet">
        <span class="balance-label">Balance:</span>
        <span class="balance-value">{{ Number(auth.wallet.balance).toFixed(2) }} ETB</span>
        <button class="btn-deposit" @click="showDeposit = true">+ Deposit</button>
        <button class="btn-withdraw" @click="showWithdraw = true">Withdraw</button>
      </div>
    </div>

    <div v-if="gameStore.loadingGames" class="state-message">Loading games…</div>
    <div v-else-if="!gameStore.availableGames.length" class="state-message">
      No games available right now. Check back soon!
    </div>
    <div v-else class="games-grid">
      <div
        v-for="game in gameStore.availableGames"
        :key="game.id"
        class="game-card"
      >
        <h3>{{ game.title }}</h3>
        <p>
          <span class="label">Price:</span>
          <span class="value">{{ game.ticketPrice }} ETB</span>
        </p>
        <p>
          <span class="label">Players:</span>
          <span class="value">{{ (game as any).currentPlayers ?? 0 }} / {{ game.maxPlayers }}</span>
        </p>
        <p>
          <span class="label">Pattern:</span>
          <span class="value">{{ game.pattern }}</span>
        </p>
        <p>
          <span class="label">Status:</span>
          <span class="badge" :class="game.status.toLowerCase()">{{ game.status }}</span>
        </p>
        <NuxtLink :to="`/quick/${game.id}`" class="join-btn">Join Game →</NuxtLink>
      </div>
    </div>

    <!-- Deposit Modal (T29) -->
    <DepositModal v-model="showDeposit" @deposited="auth.fetchWallet()" />
    <!-- Withdrawal Modal (T38) -->
    <WithdrawalModal
      v-model="showWithdraw"
      :balance="Number(auth.wallet?.balance ?? 0)"
      @withdrawn="auth.fetchWallet()"
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

// Initial fetch
await Promise.all([gameStore.fetchAvailableGames(), fetchJackpot()])

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
.lobby-page {
  padding: 2rem;
}

.lobby-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
  gap: 1rem;
}

.lobby-header h2 {
  margin: 0;
}

.wallet-summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: rgba(255, 255, 255, 0.05);
  padding: 0.5rem 1rem;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.balance-label {
  color: #aaa;
  font-size: 0.9rem;
}

.balance-value {
  color: var(--color-primary, #c9a96e);
  font-weight: 700;
  font-size: 1rem;
}

.btn-deposit,
.btn-withdraw {
  padding: 0.35rem 0.8rem;
  border-radius: 6px;
  font-size: 0.85rem;
  cursor: pointer;
  border: none;
  font-weight: 600;
}

.btn-deposit {
  background: var(--color-primary, #c9a96e);
  color: #000;
}

.btn-withdraw {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #ccc;
}

.state-message {
  text-align: center;
  color: #888;
  padding: 3rem 0;
  font-size: 1rem;
}

.games-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}

.game-card {
  padding: 1.25rem;
  background: var(--color-surface, #1a1a2e);
  border: 1px solid rgba(201, 169, 110, 0.3);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  transition: border-color 0.2s;
}

.game-card:hover {
  border-color: var(--color-primary, #c9a96e);
}

.game-card h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  color: #fff;
}

.game-card p {
  margin: 0;
  font-size: 0.875rem;
  display: flex;
  gap: 0.4rem;
}

.label {
  color: #888;
}

.value {
  color: #ddd;
  font-weight: 600;
}

.badge {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 20px;
  font-weight: 600;
  text-transform: uppercase;
}

.badge.waiting {
  background: rgba(234, 179, 8, 0.15);
  color: #fbbf24;
}

.badge.in_progress {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
}

.badge.starting {
  background: rgba(99, 102, 241, 0.15);
  color: #a5b4fc;
}

.join-btn {
  display: inline-block;
  margin-top: 0.75rem;
  padding: 0.5rem 1rem;
  background: var(--color-primary, #c9a96e);
  color: #000;
  text-decoration: none;
  border-radius: 6px;
  font-weight: 600;
  font-size: 0.9rem;
  text-align: center;
  transition: opacity 0.2s;
}

.join-btn:hover {
  opacity: 0.85;
}

/* T59 — Jackpot styles */
.jackpot-banner {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: linear-gradient(135deg, #1a0533, #3b0764);
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 12px;
  padding: 0.875rem 1.25rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.jackpot-label {
  font-size: 0.85rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #c4b5fd;
}

.jackpot-amount {
  font-size: 1.6rem;
  font-weight: 900;
  color: #fbbf24;
  font-variant-numeric: tabular-nums;
}

.jackpot-hint {
  font-size: 0.75rem;
  color: #9ca3af;
  margin-left: auto;
}

.jackpot-win-toast {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  background: linear-gradient(135deg, #7c3aed, #dc2626);
  color: white;
  padding: 0.875rem 1.5rem;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  text-align: center;
}

.jackpot-fade-enter-active,
.jackpot-fade-leave-active {
  transition: opacity 0.5s, transform 0.5s;
}

.jackpot-fade-enter-from,
.jackpot-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-20px);
}
</style>
