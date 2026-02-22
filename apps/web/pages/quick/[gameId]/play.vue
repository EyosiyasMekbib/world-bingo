<template>
  <div class="play-page">
    <!-- Loading state -->
    <div v-if="loading" class="state-message">
      <div class="spinner" />
      <p>Loading game…</p>
    </div>

    <!-- Error state -->
    <div v-else-if="errorMsg" class="state-message error">
      <p>{{ errorMsg }}</p>
      <button class="back-btn" @click="router.push('/')">Back to Lobby</button>
    </div>

    <!-- ── Winner Overlay ────────────────────────────────────────────── -->
    <Transition name="overlay-fade">
      <div v-if="showWinnerOverlay" class="overlay winner-overlay">
        <div class="overlay-card winner-card">
          <div class="confetti" v-if="isWinner">🎊</div>
          <div class="trophy">🏆</div>
          <h2 v-if="isWinner" class="you-won">You Won!</h2>
          <h2 v-else>{{ gameStore.winner?.username }} Won!</h2>
          <p class="prize-amount">
            <span class="prize-label">Prize</span>
            {{ gameStore.winner?.prizeAmount?.toFixed(2) }} ETB
          </p>
          <p class="redirect-hint">Returning to lobby in {{ redirectCountdown }}s…</p>
          <button class="back-btn" @click="goToLobby">Go Now</button>
        </div>
      </div>
    </Transition>

    <!-- ── Cancelled Overlay ─────────────────────────────────────────── -->
    <Transition name="overlay-fade">
      <div v-if="showCancelledOverlay" class="overlay cancelled-overlay">
        <div class="overlay-card cancelled-card">
          <div class="icon">❌</div>
          <h2>Game Cancelled</h2>
          <p>The game was cancelled. Your entry fee has been refunded to your wallet.</p>
          <p class="redirect-hint">Returning to lobby in {{ redirectCountdown }}s…</p>
          <button class="back-btn" @click="goToLobby">Go Now</button>
        </div>
      </div>
    </Transition>

    <!-- ── Main Game UI ──────────────────────────────────────────────── -->
    <template v-if="!loading && !errorMsg && gameStore.currentGame">

      <!-- Top bar: game info + ball display -->
      <div class="top-bar">
        <div class="game-meta">
          <h2 class="game-title">{{ gameStore.currentGame.title }}</h2>
          <span class="status-badge" :class="statusClass">
            {{ displayStatus }}
          </span>
          <span class="ball-count-badge">
            {{ gameStore.calledBalls.length }} / 75 balls
          </span>
          <span class="pattern-badge">
            {{ gameStore.currentGame.pattern?.replace(/_/g, ' ') }}
          </span>
        </div>
      </div>

      <!-- Current ball hero -->
      <div class="ball-hero-section">
        <Transition name="ball-bounce" mode="out-in">
          <div
            v-if="gameStore.lastCalledBall !== null"
            :key="gameStore.lastCalledBall"
            class="hero-ball"
            :class="ballColumnClass(gameStore.lastCalledBall)"
          >
            <span class="hero-ball-letter">{{ ballLetter(gameStore.lastCalledBall) }}</span>
            <span class="hero-ball-number">{{ gameStore.lastCalledBall }}</span>
          </div>
          <div v-else class="hero-ball placeholder">
            <span class="hero-ball-letter">?</span>
            <span class="hero-ball-number">—</span>
          </div>
        </Transition>

        <!-- Called balls history strip -->
        <div class="called-strip">
          <div class="called-strip-label">Called Balls</div>
          <div class="called-balls-scroll">
            <TransitionGroup name="ball-list">
              <div
                v-for="ball in [...gameStore.calledBalls].reverse()"
                :key="ball"
                class="mini-ball"
                :class="ballColumnClass(ball)"
              >
                {{ ball }}
              </div>
            </TransitionGroup>
          </div>
        </div>
      </div>

      <!-- ── Cartela Cards (swipeable tabs) ────────────────────────── -->
      <div class="cartela-section" v-if="gameStore.myEntries.length">
        <!-- Tab selector for multiple cards -->
        <div class="card-tabs" v-if="gameStore.myEntries.length > 1">
          <button
            v-for="(entry, idx) in gameStore.myEntries"
            :key="entry.id"
            class="card-tab"
            :class="{ active: activeCardIndex === idx }"
            @click="activeCardIndex = idx"
          >
            Card #{{ entry.cartela.serial }}
            <span v-if="canClaimBingo(entry.cartela)" class="tab-bingo-dot" />
          </button>
        </div>

        <!-- Active cartela grid -->
        <div class="cartela-card" v-if="activeEntry">
          <h4 class="cartela-serial">Card #{{ activeEntry.cartela.serial }}</h4>

          <div class="bingo-grid">
            <!-- Column headers -->
            <div class="grid-header">
              <span v-for="col in COLUMNS" :key="col" class="col-label">{{ col }}</span>
            </div>

            <!-- Rows -->
            <div v-for="(row, r) in getGrid(activeEntry.cartela.grid)" :key="r" class="grid-row">
              <div
                v-for="(num, c) in row"
                :key="`${r}-${c}`"
                class="grid-cell"
                :class="{
                  marked: isCellMarked(num, r, c),
                  'free-space': r === 2 && c === 2,
                  'just-called': num === gameStore.lastCalledBall && r !== 2 && c !== 2,
                }"
              >
                <span v-if="r === 2 && c === 2" class="free-star">★</span>
                <span v-else>{{ num }}</span>
              </div>
            </div>
          </div>

          <!-- Bingo button -->
          <Transition name="bingo-pop">
            <button
              v-if="canClaimBingo(activeEntry.cartela)"
              class="bingo-button pulse"
              :disabled="claimingBingo"
              @click="handleClaimBingo(activeEntry.cartela.id)"
            >
              <span v-if="claimingBingo">Checking…</span>
              <span v-else>🎉 BINGO!</span>
            </button>
          </Transition>
        </div>
      </div>

      <!-- Waiting state (game not started yet) -->
      <div v-else-if="gameStore.gameStatus === 'waiting' || gameStore.gameStatus === 'starting'" class="waiting-state">
        <div class="waiting-spinner" />
        <h3>Waiting for the game to start…</h3>
        <p class="waiting-hint">The game host will begin calling numbers shortly.</p>
      </div>

      <!-- Not joined state -->
      <div v-else-if="!gameStore.hasJoined" class="state-message">
        <p>You haven't joined this game yet.</p>
        <button class="back-btn" @click="router.push(`/quick/${gameId}`)">Go Back &amp; Join</button>
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

// ── State ──────────────────────────────────────────────────────────────────
const loading = ref(true)
const errorMsg = ref('')
const activeCardIndex = ref(0)
const claimingBingo = ref(false)
const showWinnerOverlay = ref(false)
const showCancelledOverlay = ref(false)
const redirectCountdown = ref(10)
let countdownTimer: ReturnType<typeof setInterval> | null = null

const COLUMNS = ['B', 'I', 'N', 'G', 'O']

// ── Computed ───────────────────────────────────────────────────────────────
const isWinner = computed(() => gameStore.winner?.username === auth.user?.username)

const activeEntry = computed(() => gameStore.myEntries[activeCardIndex.value] ?? null)

const statusClass = computed(() => {
  const s = gameStore.currentGame?.status?.toLowerCase() ?? ''
  return s.replace(/_/g, '-')
})

const displayStatus = computed(() => {
  if (gameStore.gameStatus === 'active') return 'In Progress'
  if (gameStore.gameStatus === 'starting') return 'Starting…'
  if (gameStore.gameStatus === 'waiting') return 'Waiting'
  if (gameStore.gameStatus === 'ended') return 'Ended'
  return gameStore.currentGame?.status ?? 'Unknown'
})

// ── Helpers ────────────────────────────────────────────────────────────────
function getGrid(jsonGrid: unknown): number[][] {
  if (typeof jsonGrid === 'string') return JSON.parse(jsonGrid)
  return jsonGrid as number[][]
}

function isCellMarked(num: number, r: number, c: number): boolean {
  if (r === 2 && c === 2) return true // free space
  return gameStore.calledBalls.includes(num)
}

function ballLetter(ball: number): string {
  if (ball <= 15) return 'B'
  if (ball <= 30) return 'I'
  if (ball <= 45) return 'N'
  if (ball <= 60) return 'G'
  return 'O'
}

function ballColumnClass(ball: number): string {
  if (ball <= 15) return 'col-b'
  if (ball <= 30) return 'col-i'
  if (ball <= 45) return 'col-n'
  if (ball <= 60) return 'col-g'
  return 'col-o'
}

function canClaimBingo(cartela: Cartela): boolean {
  if (gameStore.gameStatus !== 'active') return false
  const grid = getGrid(cartela.grid)
  const calledSet = new Set<number>(gameStore.calledBalls)
  try {
    return checkPattern(gameStore.currentGame!.pattern as PatternName, grid, calledSet)
  } catch {
    return false
  }
}

async function handleClaimBingo(cartelaId: string) {
  claimingBingo.value = true
  try {
    // Try socket first for lowest latency
    const socket = connect()
    if (socket?.connected) {
      socket.emit('game:claim-bingo', { gameId, cartelaId })
    } else {
      // Fallback to REST
      await gameStore.claimBingo(gameId, cartelaId)
    }
  } catch {
    // Error already in store
  } finally {
    claimingBingo.value = false
  }
}

function startRedirectCountdown() {
  redirectCountdown.value = 10
  countdownTimer = setInterval(() => {
    redirectCountdown.value--
    if (redirectCountdown.value <= 0) {
      goToLobby()
    }
  }, 1000)
}

function goToLobby() {
  if (countdownTimer) clearInterval(countdownTimer)
  gameStore.resetGame()
  router.push('/')
}

// ── Initialization ─────────────────────────────────────────────────────────
async function init() {
  loading.value = true
  errorMsg.value = ''
  try {
    const game = await gameStore.fetchGameDetails(gameId)
    if (!game) {
      errorMsg.value = 'Game not found.'
      return
    }

    // Check if the player is already in this game
    const existingEntries = (game as any)?.entries?.filter(
      (e: any) => e.userId === auth.user?.id,
    )
    if (existingEntries?.length) {
      gameStore.myEntries = existingEntries
      // Set status based on game state
      if (game.status === 'IN_PROGRESS') {
        gameStore.gameStatus = 'active'
      } else if (game.status === 'WAITING') {
        gameStore.gameStatus = 'waiting'
      } else if (game.status === 'STARTING') {
        gameStore.gameStatus = 'starting'
      }
    }
  } catch (e: any) {
    errorMsg.value = e?.message ?? 'Failed to load game.'
  } finally {
    loading.value = false
  }
}

await init()

// ── Socket Wiring ──────────────────────────────────────────────────────────
onMounted(() => {
  const socket = connect()
  if (!socket) return

  // Join game room for real-time events
  socket.emit('game:join-room', { gameId })

  socket.on('game:updated', gameStore.onGameUpdated)

  socket.on('game:started', (game: any) => {
    gameStore.onGameStarted(game)
  })

  socket.on('game:ball-called', (payload: any) => {
    gameStore.onBallCalled(payload)
  })

  socket.on('game:winner', (payload: any) => {
    gameStore.onGameWinner(payload)
    showWinnerOverlay.value = true
    startRedirectCountdown()
  })

  socket.on('game:ended', (game: any) => {
    gameStore.onGameEnded(game)
    if (!showWinnerOverlay.value) {
      showWinnerOverlay.value = true
      startRedirectCountdown()
    }
  })

  socket.on('game:cancelled', (payload: any) => {
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
/* ── Page Layout ────────────────────────────────────────────────────────── */
.play-page {
  max-width: 900px;
  margin: 0 auto;
  padding: 1rem 1.5rem 3rem;
  min-height: calc(100vh - 60px);
}

/* ── States ──────────────────────────────────────────────────────────────── */
.state-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 2rem;
  color: #888;
  gap: 1rem;
}
.state-message.error {
  color: #f87171;
}

.spinner,
.waiting-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(255,255,255,0.1);
  border-top-color: var(--color-primary, #c9a96e);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.back-btn {
  padding: 0.6rem 1.5rem;
  background: var(--color-primary, #c9a96e);
  color: #000;
  border: none;
  border-radius: 8px;
  font-weight: 700;
  cursor: pointer;
  font-size: 0.9rem;
  transition: opacity 0.2s;
}
.back-btn:hover { opacity: 0.85; }

/* ── Top Bar ─────────────────────────────────────────────────────────────── */
.top-bar {
  margin-bottom: 1.5rem;
}

.game-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.game-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
}

.status-badge,
.ball-count-badge,
.pattern-badge {
  font-size: 0.7rem;
  padding: 0.2rem 0.6rem;
  border-radius: 20px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.status-badge {
  background: rgba(34, 197, 94, 0.15);
  color: #4ade80;
}
.status-badge.waiting { background: rgba(234, 179, 8, 0.15); color: #fbbf24; }
.status-badge.starting { background: rgba(99, 102, 241, 0.15); color: #a5b4fc; }
.status-badge.in-progress { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
.status-badge.completed { background: rgba(100, 116, 139, 0.15); color: #94a3b8; }

.ball-count-badge {
  background: rgba(255,255,255,0.06);
  color: #aaa;
}

.pattern-badge {
  background: rgba(201, 169, 110, 0.12);
  color: var(--color-primary, #c9a96e);
}

/* ── Hero Ball ───────────────────────────────────────────────────────────── */
.ball-hero-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 2rem;
}

.hero-ball {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.25), transparent 60%),
    var(--ball-bg, #c9a96e);
  box-shadow: 0 6px 24px rgba(0,0,0,0.4), inset 0 -4px 10px rgba(0,0,0,0.2);
  margin-bottom: 1.25rem;
}

.hero-ball.placeholder {
  --ball-bg: rgba(255,255,255,0.08);
  box-shadow: none;
}

.hero-ball-letter {
  font-size: 0.85rem;
  font-weight: 700;
  color: rgba(0,0,0,0.6);
  line-height: 1;
}

.hero-ball-number {
  font-size: 2.5rem;
  font-weight: 900;
  color: #000;
  line-height: 1;
}

.hero-ball.placeholder .hero-ball-letter,
.hero-ball.placeholder .hero-ball-number {
  color: #555;
}

/* Ball color per column */
.col-b { --ball-bg: #3b82f6; }
.col-b .hero-ball-number,
.col-b .hero-ball-letter { color: #fff; }
.col-i { --ball-bg: #ef4444; }
.col-i .hero-ball-number,
.col-i .hero-ball-letter { color: #fff; }
.col-n { --ball-bg: #f59e0b; }
.col-g { --ball-bg: #22c55e; }
.col-g .hero-ball-number,
.col-g .hero-ball-letter { color: #fff; }
.col-o { --ball-bg: #a855f7; }
.col-o .hero-ball-number,
.col-o .hero-ball-letter { color: #fff; }

/* ── Called Balls Strip ──────────────────────────────────────────────────── */
.called-strip {
  width: 100%;
  max-width: 600px;
}

.called-strip-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  color: #666;
  letter-spacing: 0.05em;
  margin-bottom: 0.4rem;
}

.called-balls-scroll {
  display: flex;
  gap: 0.3rem;
  overflow-x: auto;
  padding: 0.35rem 0;
  scrollbar-width: thin;
}

.mini-ball {
  width: 32px;
  height: 32px;
  min-width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 0.72rem;
  font-weight: 700;
  color: #fff;
  background: var(--ball-bg, rgba(201, 169, 110, 0.3));
  border: 1px solid rgba(255,255,255,0.1);
}

/* ── Card Tabs ───────────────────────────────────────────────────────────── */
.cartela-section {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.card-tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}

.card-tab {
  position: relative;
  padding: 0.5rem 1rem;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: #aaa;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.card-tab.active {
  background: rgba(201, 169, 110, 0.15);
  border-color: var(--color-primary, #c9a96e);
  color: var(--color-primary, #c9a96e);
}

.tab-bingo-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 10px;
  height: 10px;
  background: #ef4444;
  border-radius: 50%;
  animation: pulse-dot 1s infinite;
}

@keyframes pulse-dot {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.3); opacity: 0.7; }
}

/* ── Cartela Card ────────────────────────────────────────────────────────── */
.cartela-card {
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  padding: 1.25rem;
  max-width: 320px;
  width: 100%;
}

.cartela-serial {
  margin: 0 0 0.75rem;
  text-align: center;
  color: var(--color-primary, #c9a96e);
  font-size: 0.9rem;
}

/* ── Bingo Grid ──────────────────────────────────────────────────────────── */
.bingo-grid {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.grid-header {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 3px;
  margin-bottom: 2px;
}

.col-label {
  text-align: center;
  font-weight: 900;
  font-size: 1rem;
  color: var(--color-primary, #c9a96e);
  padding: 0.25rem 0;
}

.grid-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 3px;
}

.grid-cell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255,255,255,0.05);
  border-radius: 6px;
  font-weight: 700;
  font-size: 0.95rem;
  color: #ccc;
  transition: all 0.25s ease;
  position: relative;
}

.grid-cell.marked {
  background: var(--color-primary, #c9a96e);
  color: #000;
  transform: scale(1.02);
  box-shadow: 0 0 8px rgba(201, 169, 110, 0.3);
}

.grid-cell.just-called {
  animation: just-called-pop 0.6s ease;
  z-index: 2;
}

@keyframes just-called-pop {
  0% { transform: scale(1); }
  30% { transform: scale(1.2); }
  60% { transform: scale(0.95); }
  100% { transform: scale(1.02); }
}

.grid-cell.free-space {
  background: rgba(201, 169, 110, 0.18);
  color: var(--color-primary, #c9a96e);
}

.free-star {
  font-size: 1.2rem;
}

/* ── Bingo Button ────────────────────────────────────────────────────────── */
.bingo-button {
  width: 100%;
  margin-top: 1rem;
  padding: 0.85rem;
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  color: #fff;
  font-weight: 900;
  font-size: 1.3rem;
  letter-spacing: 0.08em;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(239, 68, 68, 0.4);
  transition: transform 0.1s, box-shadow 0.1s;
}

.bingo-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(239, 68, 68, 0.5);
}

.bingo-button:active:not(:disabled) {
  transform: translateY(0);
}

.bingo-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pulse {
  animation: pulse-btn 1.5s infinite;
}

@keyframes pulse-btn {
  0%, 100% { box-shadow: 0 4px 16px rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 4px 28px rgba(239, 68, 68, 0.7); }
}

/* ── Waiting State ───────────────────────────────────────────────────────── */
.waiting-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 3rem 2rem;
  gap: 0.75rem;
  color: #aaa;
}

.waiting-state h3 {
  margin: 0;
  color: #fff;
  font-size: 1.1rem;
}

.waiting-hint {
  font-size: 0.85rem;
  color: #666;
}

/* ── Overlays ────────────────────────────────────────────────────────────── */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.88);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.overlay-card {
  background: var(--color-surface, #1a1a2e);
  border: 2px solid var(--color-primary, #c9a96e);
  border-radius: 16px;
  padding: 2.5rem;
  text-align: center;
  max-width: 400px;
  width: 90%;
  position: relative;
  overflow: hidden;
}

.confetti {
  font-size: 3rem;
  margin-bottom: 0.5rem;
  animation: confetti-bounce 0.8s ease-in-out;
}

@keyframes confetti-bounce {
  0% { transform: scale(0) rotate(-20deg); opacity: 0; }
  60% { transform: scale(1.3) rotate(5deg); opacity: 1; }
  100% { transform: scale(1) rotate(0); }
}

.trophy {
  font-size: 4rem;
  margin-bottom: 0.5rem;
}

.overlay-card h2 {
  font-size: 1.8rem;
  margin: 0 0 0.5rem;
  color: var(--color-primary, #c9a96e);
}

.you-won {
  color: #4ade80 !important;
  font-size: 2rem !important;
}

.icon {
  font-size: 3.5rem;
  margin-bottom: 0.5rem;
}

.prize-amount {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 1.8rem;
  font-weight: 700;
  color: #4ade80;
  margin: 0.5rem 0;
}

.prize-label {
  font-size: 0.75rem;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.redirect-hint {
  color: #666;
  font-size: 0.85rem;
  margin-top: 1rem;
}

.overlay-card .back-btn {
  margin-top: 1rem;
}

/* ── Transitions ─────────────────────────────────────────────────────────── */
.overlay-fade-enter-active { transition: opacity 0.3s ease; }
.overlay-fade-leave-active { transition: opacity 0.2s ease; }
.overlay-fade-enter-from,
.overlay-fade-leave-to { opacity: 0; }

.ball-bounce-enter-active {
  animation: ball-enter 0.4s ease-out;
}
.ball-bounce-leave-active {
  animation: ball-leave 0.15s ease-in;
}

@keyframes ball-enter {
  0% { transform: scale(0.3) translateY(-30px); opacity: 0; }
  60% { transform: scale(1.1) translateY(0); }
  100% { transform: scale(1) translateY(0); opacity: 1; }
}

@keyframes ball-leave {
  to { transform: scale(0.8); opacity: 0; }
}

.ball-list-enter-active { transition: all 0.3s ease; }
.ball-list-leave-active { transition: all 0.2s ease; }
.ball-list-enter-from { opacity: 0; transform: scale(0.5); }
.ball-list-leave-to { opacity: 0; }
.ball-list-move { transition: transform 0.3s ease; }

.bingo-pop-enter-active { animation: bingo-pop-in 0.4s ease-out; }
.bingo-pop-leave-active { animation: bingo-pop-out 0.2s ease-in; }

@keyframes bingo-pop-in {
  0% { transform: scale(0.5); opacity: 0; }
  70% { transform: scale(1.08); }
  100% { transform: scale(1); opacity: 1; }
}

@keyframes bingo-pop-out {
  to { transform: scale(0.8); opacity: 0; }
}

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 480px) {
  .play-page {
    padding: 0.75rem 1rem 2rem;
  }

  .hero-ball {
    width: 80px;
    height: 80px;
  }

  .hero-ball-number {
    font-size: 2rem;
  }

  .grid-cell {
    font-size: 0.85rem;
  }

  .bingo-button {
    font-size: 1.1rem;
  }
}
</style>
