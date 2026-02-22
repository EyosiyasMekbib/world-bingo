<template>
  <div class="lobby-page">
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

const showDeposit = ref(false)
const showWithdraw = ref(false)

// Initial fetch
await gameStore.fetchAvailableGames()

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
</style>
