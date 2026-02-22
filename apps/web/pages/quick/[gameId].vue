<template>
  <div class="game-room">
    <!-- Loading -->
    <div v-if="gameStore.loadingGame" class="state-message">Loading game…</div>

    <!-- Winner overlay -->
    <Transition name="fade">
      <div v-if="showWinnerOverlay" class="winner-overlay">
        <div class="winner-card">
          <div class="trophy">🏆</div>
          <h2 v-if="isWinner">You Won!</h2>
          <h2 v-else>{{ gameStore.winner?.username }} Won!</h2>
          <p class="prize">Prize: {{ gameStore.winner?.prizeAmount?.toFixed(2) }} ETB</p>
          <p class="redirect-hint">Returning to lobby in {{ redirectCountdown }}s…</p>
        </div>
      </div>
    </Transition>

    <!-- Cancelled overlay -->
    <Transition name="fade">
      <div v-if="showCancelledOverlay" class="cancelled-overlay">
        <div class="cancelled-card">
          <div class="icon">❌</div>
          <h2>Game Cancelled</h2>
          <p>The game was cancelled. Your entry fee has been refunded to your wallet.</p>
          <p class="redirect-hint">Returning to lobby in {{ redirectCountdown }}s…</p>
        </div>
      </div>
    </Transition>

    <template v-if="gameStore.currentGame">
      <!-- Header -->
      <div class="game-header">
        <div class="game-info">
          <h2>{{ gameStore.currentGame.title }}</h2>
          <span class="status-badge" :class="gameStore.currentGame.status.toLowerCase()">
            {{ gameStore.currentGame.status }}
          </span>
        </div>
        <div v-if="gameStore.lastCalledBall !== null" class="last-called">
          <span class="ball-label">Last Ball</span>
          <span class="ball-number">{{ gameStore.lastCalledBall }}</span>
        </div>
        <div class="called-history">
          <span
            v-for="ball in gameStore.calledBalls.slice(-10)"
            :key="ball"
            class="called-ball"
          >{{ ball }}</span>
        </div>
      </div>

      <!-- ── PLAY AREA (joined) ──────────────────────────────────── -->
      <div v-if="gameStore.hasJoined" class="play-area">
        <div class="cartelas-list">
          <div v-for="entry in gameStore.myEntries" :key="entry.id" class="my-cartela">
            <h4>Card #{{ entry.cartela.serial }}</h4>
            <div class="grid">
              <div class="grid-header">
                <span v-for="col in ['B','I','N','G','O']" :key="col" class="col-header">{{ col }}</span>
              </div>
              <div v-for="(row, r) in getGrid(entry.cartela.grid)" :key="r" class="row">
                <div
                  v-for="(num, c) in row"
                  :key="c"
                  class="cell"
                  :class="{
                    marked: isMarked(num),
                    'free-space': r === 2 && c === 2
                  }"
                >
                  {{ (r === 2 && c === 2) ? '★' : num }}
                </div>
              </div>
            </div>
            <button
              v-if="canClaimBingo(entry.cartela)"
              class="bingo-btn pulse"
              @click="claimBingo(entry.cartela.id)"
            >
              BINGO!
            </button>
          </div>
        </div>
      </div>

      <!-- ── JOIN AREA (not yet joined) ────────────────────────── -->
      <div v-else class="join-area">
        <h3>Select Your Card(s) to Join</h3>
        <p class="price-info">
          Entry: <strong>{{ gameStore.currentGame.ticketPrice }} ETB</strong> per card
          <span v-if="selectedSerials.length > 1">
            × {{ selectedSerials.length }} = <strong>{{ totalCost.toFixed(2) }} ETB</strong>
          </span>
        </p>

        <div class="cartela-grid">
          <div
            v-for="cartela in gameStore.availableCartelas"
            :key="cartela.id"
            class="cartela-tile"
            :class="{
              selected: selectedSerials.includes(cartela.serial),
              taken: (cartela as any).isTaken
            }"
            @click="toggleCartela(cartela.serial)"
          >
            <span class="serial">{{ cartela.serial }}</span>
          </div>
        </div>

        <p v-if="joinError" class="msg error">{{ joinError }}</p>

        <button
          class="join-btn"
          :disabled="!selectedSerials.length || joining"
          @click="joinGame"
        >
          <span v-if="joining">Joining…</span>
          <span v-else>Pay {{ totalCost.toFixed(2) }} ETB &amp; Join</span>
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import type { Cartela } from '@world-bingo/shared-types'
import { checkPattern } from '@world-bingo/game-logic'
import type { PatternName } from '@world-bingo/game-logic'

const route = useRoute()
const router = useRouter()
const gameId = route.params.gameId as string
const gameStore = useGameStore()
const auth = useAuthStore()
const { connect } = useSocket()

const selectedSerials = ref<string[]>([])
const joining = ref(false)
const joinError = ref('')
const showWinnerOverlay = ref(false)
const showCancelledOverlay = ref(false)
const redirectCountdown = ref(10)
let countdownTimer: ReturnType<typeof setInterval> | null = null

const isWinner = computed(() => gameStore.winner?.username === auth.user?.username)
const totalCost = computed(
  () => selectedSerials.value.length * Number(gameStore.currentGame?.ticketPrice ?? 0),
)

function toggleCartela(serial: string) {
  const idx = selectedSerials.value.indexOf(serial)
  if (idx === -1) {
    selectedSerials.value.push(serial)
  } else {
    selectedSerials.value.splice(idx, 1)
  }
}

function getGrid(jsonGrid: unknown): number[][] {
  if (typeof jsonGrid === 'string') return JSON.parse(jsonGrid)
  return jsonGrid as number[][]
}

function isMarked(num: number): boolean {
  if (num === 0) return true
  return gameStore.calledBalls.includes(num)
}

function canClaimBingo(cartela: Cartela): boolean {
  if (gameStore.gameStatus !== 'active') return false
  const grid = getGrid(cartela.grid)
  const calledSet = new Set(gameStore.calledBalls)
  try {
    return checkPattern(gameStore.currentGame!.pattern as PatternName, grid, calledSet)
  } catch {
    return false
  }
}

async function joinGame() {
  if (!selectedSerials.value.length) return
  joining.value = true
  joinError.value = ''
  try {
    await gameStore.joinGame(gameId, selectedSerials.value)
    // Join the socket room after successful join
    const socket = connect()
    socket?.emit('game:join-room', { gameId })
  } catch (e: any) {
    joinError.value = e?.data?.message ?? e?.message ?? 'Failed to join game'
  } finally {
    joining.value = false
  }
}

async function claimBingo(cartelaId: string) {
  try {
    await gameStore.claimBingo(gameId, cartelaId)
  } catch (e: any) {
    // Error already set in store
  }
}

function startRedirectCountdown() {
  redirectCountdown.value = 10
  countdownTimer = setInterval(() => {
    redirectCountdown.value--
    if (redirectCountdown.value <= 0) {
      if (countdownTimer) clearInterval(countdownTimer)
      gameStore.resetGame()
      router.push('/')
    }
  }, 1000)
}

// Initial data load
await gameStore.fetchGameDetails(gameId)
await gameStore.fetchAvailableCartelas(gameId)

// Check if player is already in game
const existingEntries = (gameStore.currentGame as any)?.entries?.filter(
  (e: any) => e.userId === auth.user?.id,
)
if (existingEntries?.length) {
  gameStore.myEntries = existingEntries
}

onMounted(() => {
  const socket = connect()
  if (!socket) return

  socket.emit('game:join-room', { gameId })

  socket.on('game:updated', gameStore.onGameUpdated)
  socket.on('game:started', gameStore.onGameStarted)
  socket.on('game:ball-called', gameStore.onBallCalled)
  socket.on('game:winner', (payload) => {
    gameStore.onGameWinner(payload)
    showWinnerOverlay.value = true
    startRedirectCountdown()
  })
  socket.on('game:ended', (game) => {
    gameStore.onGameEnded(game)
    if (!showWinnerOverlay.value) {
      showWinnerOverlay.value = true
      startRedirectCountdown()
    }
  })
  socket.on('game:cancelled', (payload) => {
    gameStore.onGameCancelled(payload)
    showCancelledOverlay.value = true
    startRedirectCountdown()
  })
})

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})
</script>

<style scoped>
.game-room {
  padding: 1rem 2rem;
  max-width: 1100px;
  margin: 0 auto;
}

.state-message {
  text-align: center;
  color: #888;
  padding: 3rem 0;
}

/* Header */
.game-header {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 1rem 1.25rem;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 10px;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.game-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.game-info h2 {
  margin: 0;
  font-size: 1.2rem;
}

.status-badge {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 20px;
  font-weight: 600;
  text-transform: uppercase;
}

.status-badge.waiting { background: rgba(234, 179, 8, 0.15); color: #fbbf24; }
.status-badge.in_progress { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
.status-badge.starting { background: rgba(99, 102, 241, 0.15); color: #a5b4fc; }

.last-called {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-left: auto;
}

.ball-label {
  font-size: 0.7rem;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ball-number {
  font-size: 2.5rem;
  font-weight: 900;
  color: var(--color-primary, #c9a96e);
  line-height: 1;
}

.called-history {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.called-ball {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(201, 169, 110, 0.15);
  border: 1px solid rgba(201, 169, 110, 0.3);
  border-radius: 50%;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-primary, #c9a96e);
}

/* Cartela Grid */
.play-area {
  margin-top: 1rem;
}

.cartelas-list {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
  justify-content: center;
}

.my-cartela {
  background: rgba(255, 255, 255, 0.03);
  padding: 1rem;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.my-cartela h4 {
  margin: 0 0 0.75rem;
  color: var(--color-primary, #c9a96e);
  font-size: 0.9rem;
}

.grid-header {
  display: grid;
  grid-template-columns: repeat(5, 44px);
  gap: 4px;
  margin-bottom: 2px;
}

.col-header {
  width: 44px;
  text-align: center;
  font-weight: 900;
  font-size: 0.9rem;
  color: var(--color-primary, #c9a96e);
}

.row {
  display: grid;
  grid-template-columns: repeat(5, 44px);
  gap: 4px;
  margin-bottom: 4px;
}

.cell {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  font-weight: 700;
  font-size: 0.9rem;
  transition: background 0.2s, transform 0.1s;
}

.cell.marked {
  background: var(--color-primary, #c9a96e);
  color: #000;
  transform: scale(1.05);
}

.cell.free-space {
  background: rgba(255, 255, 255, 0.12);
  color: var(--color-primary, #c9a96e);
  font-size: 1.1rem;
}

.bingo-btn {
  width: 100%;
  padding: 0.75rem;
  background: #ef4444;
  color: #fff;
  font-weight: 900;
  font-size: 1.1rem;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  margin-top: 0.75rem;
  letter-spacing: 0.05em;
}

.pulse {
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

/* Join Area */
.join-area {
  padding: 1rem 0;
}

.join-area h3 {
  margin: 0 0 0.5rem;
}

.price-info {
  color: #aaa;
  font-size: 0.95rem;
  margin-bottom: 1rem;
}

.price-info strong {
  color: var(--color-primary, #c9a96e);
}

.cartela-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.cartela-tile {
  width: 50px;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 700;
  transition: all 0.15s;
  background: rgba(255, 255, 255, 0.04);
}

.cartela-tile:hover:not(.taken) {
  border-color: var(--color-primary, #c9a96e);
  background: rgba(201, 169, 110, 0.1);
}

.cartela-tile.selected {
  border-color: var(--color-primary, #c9a96e);
  background: rgba(201, 169, 110, 0.2);
  color: var(--color-primary, #c9a96e);
}

.cartela-tile.taken {
  opacity: 0.25;
  cursor: not-allowed;
}

.msg {
  font-size: 0.875rem;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
}

.msg.error {
  background: rgba(220, 38, 38, 0.1);
  color: #f87171;
  border: 1px solid rgba(220, 38, 38, 0.3);
}

.join-btn {
  padding: 0.85rem 2rem;
  font-size: 1rem;
  background: var(--color-primary, #c9a96e);
  color: #000;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 700;
  transition: opacity 0.2s;
}

.join-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Overlays */
.winner-overlay,
.cancelled-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}

.winner-card,
.cancelled-card {
  background: var(--color-surface, #1a1a2e);
  border: 2px solid var(--color-primary, #c9a96e);
  border-radius: 16px;
  padding: 2.5rem;
  text-align: center;
  max-width: 380px;
  width: 90%;
}

.trophy,
.icon {
  font-size: 4rem;
  margin-bottom: 0.75rem;
}

.winner-card h2,
.cancelled-card h2 {
  font-size: 1.8rem;
  margin: 0 0 0.5rem;
  color: var(--color-primary, #c9a96e);
}

.prize {
  font-size: 1.5rem;
  font-weight: 700;
  color: #4ade80;
  margin: 0.5rem 0;
}

.redirect-hint {
  color: #888;
  font-size: 0.85rem;
  margin-top: 1rem;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
