<template>
  <div class="play-page">
    <!-- ── Loading ─────────────────────────────────────────────────────── -->
    <div v-if="loading" class="state-message">
      <div class="spinner" />
      <p>Loading game…</p>
    </div>

    <!-- ── Error ──────────────────────────────────────────────────────── -->
    <div v-else-if="errorMsg" class="state-message error">
      <p>{{ errorMsg }}</p>
      <button class="back-btn" @click="router.push('/')">Back to Lobby</button>
    </div>

    <!-- ── Winner Overlay ─────────────────────────────────────────────── -->
    <Transition name="overlay-fade">
      <div v-if="showWinnerOverlay" class="overlay winner-overlay">
        <div class="overlay-card winner-card">
          <div v-if="isWinner" class="confetti-row">🎊🎊🎊</div>
          <div class="trophy">🏆</div>
          <h2 v-if="isWinner" class="you-won">You Won!</h2>
          <template v-else>
            <h2 class="you-lost">You Lost</h2>
            <p class="other-won-sub">{{ gameStore.winner?.username }} is the winner!</p>
          </template>
          <p class="prize-amount">
            <span class="prize-label">{{ isWinner ? 'You Won' : 'Prize' }}</span>
            {{ gameStore.winner?.prizeAmount?.toFixed(2) }} ETB
          </p>
          <p class="redirect-hint">Returning to lobby in {{ redirectCountdown }}s…</p>
          <button class="back-btn" @click="goToLobby">Go Now</button>
        </div>
      </div>
    </Transition>

    <!-- ── Cancelled / Refund Overlay ─────────────────────────────────── -->
    <Transition name="overlay-fade">
      <div v-if="showCancelledOverlay" class="overlay cancelled-overlay">
        <div class="overlay-card cancelled-card">
          <div class="cancel-icon">❌</div>
          <h2>Game Cancelled</h2>
          <p>Not enough players joined in time.</p>
          <p class="refund-note">💰 Your entry fee has been <strong>refunded</strong> to your wallet.</p>
          <p class="redirect-hint">Returning to lobby in {{ redirectCountdown }}s…</p>
          <button class="back-btn" @click="goToLobby">Go Now</button>
        </div>
      </div>
    </Transition>

    <!-- ── Main Content ────────────────────────────────────────────────── -->
    <template v-if="!loading && !errorMsg && gameStore.currentGame">

      <!-- Game Header (always visible) -->
      <div class="game-header">
        <div class="header-left">
          <h2 class="game-title">{{ gameStore.currentGame.title }}</h2>
          <div class="header-badges">
            <span class="status-badge" :class="statusClass">{{ displayStatus }}</span>
            <span class="pattern-badge">{{ (gameStore.currentGame as any).pattern?.replace(/_/g, ' ') }}</span>
            <span class="stake-badge">{{ (gameStore.currentGame as any).ticketPrice }} ETB / card</span>
            <span class="players-badge">
              👥 {{ livePlayerCount }}
            </span>
            <span v-if="gameStore.gameStatus === 'active'" class="ball-count-badge">
              🎱 {{ gameStore.calledBalls.length }}/75
            </span>
          </div>
        </div>
        <div class="header-right">
          <button class="audio-btn" @click="unlockAudio(); audioEnabled = !audioEnabled" :title="audioEnabled ? 'Mute' : 'Unmute'">
            <svg v-if="audioEnabled" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="23" y1="9" x2="17" y2="15"/>
              <line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- ══════════════════════════════════════════════════════════════ -->
      <!-- PHASE 1: JOIN — select cartelas and pay                       -->
      <!-- ══════════════════════════════════════════════════════════════ -->
      <div v-if="phase === 'join'" class="join-phase">

        <!-- Error banner -->
        <Transition name="err-slide">
          <div v-if="joinError" class="join-error-banner">
            <span>⚠️ {{ joinError }}</span>
            <button class="err-close" @click="joinError = ''">✕</button>
          </div>
        </Transition>

        <div class="join-hero">
          <div class="join-icon">🎱</div>
          <h3>Select Your Cards to Join</h3>
          <div class="join-meta-row">
            <span class="join-price-chip">
              🎟 <strong>{{ (gameStore.currentGame as any).ticketPrice }} ETB</strong> / card
            </span>
            <span class="wallet-chip" :class="{ 'low-balance': walletBalance < totalCost && selectedSerials.length > 0 }">
              💰 Balance: <strong>{{ walletBalance.toFixed(2) }} ETB</strong>
            </span>
          </div>
          <p v-if="selectedSerials.length > 0" class="selected-summary">
            {{ selectedSerials.length }} card{{ selectedSerials.length > 1 ? 's' : '' }} selected
            = <strong class="total-cost">{{ totalCost.toFixed(2) }} ETB</strong>
            <span v-if="walletBalance < totalCost" class="insufficient">⚠ Insufficient balance</span>
          </p>
          <p class="join-hint">{{ gameStore.availableCartelas.filter(c => !(c as any).isTaken).length }} cards available — tap to select</p>
        </div>

        <div class="cartela-picker">
          <div
            v-for="(cartela, idx) in gameStore.availableCartelas"
            :key="cartela.id"
            class="cartela-tile"
            :class="{
              selected: selectedSerials.includes(cartela.serial),
              taken: (cartela as any).isTaken,
            }"
            @click="!(cartela as any).isTaken && toggleCartela(cartela.serial)"
          >
            <span class="tile-num">#{{ idx + 1 }}</span>
            <span v-if="selectedSerials.includes(cartela.serial)" class="tile-check">✓</span>
            <span v-if="(cartela as any).isTaken" class="tile-taken-x">✕</span>
          </div>
        </div>

        <button
          class="join-btn"
          :disabled="!selectedSerials.length || joining || walletBalance < totalCost"
          @click="handleJoin"
        >
          <span v-if="joining">
            <span class="btn-spinner" /> Joining…
          </span>
          <span v-else-if="walletBalance < totalCost && selectedSerials.length > 0">
            Insufficient Balance
          </span>
          <span v-else-if="!selectedSerials.length">Select a Card to Join</span>
          <span v-else>Pay {{ totalCost.toFixed(2) }} ETB &amp; Join</span>
        </button>
      </div>

      <!-- ══════════════════════════════════════════════════════════════ -->
      <!-- PHASE 2: WAITING — lobby timer, player count, 60s countdown  -->
      <!-- ══════════════════════════════════════════════════════════════ -->
      <div v-else-if="phase === 'waiting'" class="waiting-phase">

        <!-- Players joined progress bar -->
        <div class="players-progress-wrap">
          <div class="players-progress-label">
            <span>Players Joined</span>
            <span class="pp-count">
              <strong style="color:#4ade80">{{ livePlayerCount }}</strong>
              players
            </span>
          </div>
          <div class="players-progress-bar">
            <div class="players-progress-fill" :style="{ width: playerProgressPct + '%' }" />
          </div>
        </div>

        <!-- Countdown ring (shows while waiting for the timer to expire) -->
        <div v-if="countdownStartsAt || (gameStore.liveTimers[gameId] !== undefined && gameStore.liveTimers[gameId] > 0)" class="countdown-block">
          <div class="countdown-ring-wrap">
            <svg class="countdown-ring" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" class="ring-track" />
              <circle cx="60" cy="60" r="52" class="ring-fill" :style="{ strokeDashoffset: ringOffset }" />
            </svg>
            <div class="countdown-inner">
              <span class="countdown-secs">{{ gameStore.liveTimers[gameId] ?? countdownRemaining }}</span>
              <span class="countdown-label">sec</span>
            </div>
          </div>
          <p class="countdown-title">🟢 Get ready!</p>
          <p class="countdown-sub">Game starts when timer hits zero</p>
          <p v-if="gameStore.livePots[gameId]" class="pot-display">
            💰 Net Prize: <strong>{{ netPrize.toFixed(2) }} ETB</strong>
          </p>
          <button class="leave-queue-btn" :disabled="leaving" @click="handleLeaveGame">
            <span v-if="leaving" class="btn-spinner"></span>
            {{ leaving ? 'Leaving...' : 'Leave Game & Refund' }}
          </button>
          <p class="countdown-warn">
            The game will begin instantly. Good luck!
          </p>
        </div>

        <!-- Still waiting (edge case if connection is slow) -->
        <div v-else class="still-waiting">
          <div class="waiting-spinner" />
          <h3>Waiting...</h3>
          <p class="waiting-sub">
            The game will start soon.
          </p>
        </div>

        <!-- Preview of your cards while waiting -->
        <div v-if="gameStore.myEntries.length" class="waiting-cards-section">
          <h4 class="wc-title">Your Cards (preview)</h4>
          <div class="cartelas-grid">
            <div v-for="entry in gameStore.myEntries" :key="entry.id" class="cartela-card preview-card">
              <template v-if="entry.cartela">
                <div class="card-header">
                  <span class="card-serial">Card #{{ shortSerial(entry.cartela.serial) }}</span>
                  <span class="preview-badge">Preview</span>
                </div>
                <div class="bingo-card-grid">
                  <div class="bcg-header">
                    <span v-for="col in COLUMNS" :key="col" class="bcg-hcell" :class="`gcol-${col.toLowerCase()}`">{{ col }}</span>
                  </div>
                  <div v-for="(row, r) in getGrid(entry.cartela.grid)" :key="r" class="bcg-row">
                    <div v-for="(num, c) in row" :key="`${r}-${c}`" class="bcg-cell" :class="{ 'free-space': r === 2 && c === 2 }">
                      <span v-if="r === 2 && c === 2" class="free-star">★</span>
                      <span v-else>{{ num }}</span>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- ══════════════════════════════════════════════════════════════ -->
      <!-- PHASE 3: ACTIVE — live game, ball board, mark & claim bingo  -->
      <!-- ══════════════════════════════════════════════════════════════ -->
      <template v-else-if="phase === 'active'">
        <!-- Top strip: hero ball + recent calls -->
        <div class="live-top-strip">
          <!-- Hero ball -->
          <div class="hero-ball-wrap">
            <div class="hb-label">Called</div>
            <Transition name="ball-bounce" mode="out-in">
              <div
                v-if="gameStore.lastCalledBall !== null"
                :key="gameStore.lastCalledBall"
                class="hero-ball"
                :class="ballColumnClass(gameStore.lastCalledBall)"
              >
                <span class="hb-letter">{{ ballLetter(gameStore.lastCalledBall) }}</span>
                <span class="hb-num">{{ gameStore.lastCalledBall }}</span>
              </div>
              <div v-else class="hero-ball placeholder">
                <span class="hb-letter">—</span>
              </div>
            </Transition>
          </div>

          <!-- Recent balls strip -->
          <div class="recent-strip">
            <div class="rs-label">Recent</div>
            <TransitionGroup name="ball-list" tag="div" class="rs-balls">
              <div
                v-for="ball in [...gameStore.calledBalls].reverse().slice(0, 12)"
                :key="ball"
                class="rs-ball"
                :class="ballColumnClass(ball)"
              >
                <span class="rs-letter">{{ ballLetter(ball) }}</span>
                <span class="rs-num">{{ ball }}</span>
              </div>
            </TransitionGroup>
          </div>

          <!-- Ball counter -->
          <div class="ball-counter">
            <div class="bc-num">{{ gameStore.calledBalls.length }}</div>
            <div class="bc-label">/ 75 balls</div>
          </div>
        </div>

        <!-- 75-ball master board -->
        <div class="master-board">
          <div class="mb-cols">
            <div v-for="(col, ci) in COLUMNS" :key="col" class="mb-col" :class="`mbc-${col.toLowerCase()}`">
              <div class="mb-col-header">{{ col }}</div>
              <div
                v-for="n in 15"
                :key="n"
                class="mb-cell"
                :class="{
                  called: gameStore.calledBalls.includes(ci * 15 + n),
                  'last-called': gameStore.lastCalledBall === ci * 15 + n,
                }"
              >{{ ci * 15 + n }}</div>
            </div>
          </div>
        </div>

        <!-- Player cartelas -->
        <div v-if="gameStore.myEntries.length" class="cartelas-section">
          <div class="cartelas-grid">
            <div
              v-for="entry in gameStore.myEntries"
              :key="entry.id"
              class="cartela-card"
              :class="{ 'has-bingo': entry.cartela && canClaimBingo(entry.cartela, entry.id) }"
            >
              <template v-if="entry.cartela">
                <div class="card-top">
                  <span class="card-serial">Card #{{ shortSerial(entry.cartela.serial) }}</span>
                  <span v-if="canClaimBingo(entry.cartela, entry.id)" class="bingo-indicator pulse">BINGO!</span>
                </div>

                <div class="bingo-card-grid">
                  <div class="bcg-header">
                    <span v-for="col in COLUMNS" :key="col" class="bcg-hcell" :class="`gcol-${col.toLowerCase()}`">{{ col }}</span>
                  </div>
                  <div v-for="(row, r) in getGrid(entry.cartela.grid)" :key="r" class="bcg-row">
                    <div
                      v-for="(num, c) in row"
                      :key="`${r}-${c}`"
                      class="bcg-cell"
                      :class="{
                        'free-space': r === 2 && c === 2,
                        'manually-ticked': isManuallyTicked(entry.id, num, r, c),
                      }"
                      @click="!(r === 2 && c === 2) && toggleTick(entry.id, num)"
                    >
                      <span v-if="r === 2 && c === 2" class="free-star">★</span>
                      <span v-else>{{ num }}</span>
                      <span v-if="isManuallyTicked(entry.id, num, r, c)" class="tick-mark">✓</span>
                    </div>
                  </div>
                </div>

                <!-- BINGO button — always shown, enabled when pattern complete -->
                <button
                  class="bingo-button"
                  :class="{ active: canClaimBingo(entry.cartela, entry.id), pulsing: canClaimBingo(entry.cartela, entry.id) }"
                  :disabled="claimingBingo || !canClaimBingo(entry.cartela, entry.id)"
                  @click="handleClaimBingo(entry.cartela.id)"
                >
                  <span v-if="claimingBingo && canClaimBingo(entry.cartela, entry.id)">Checking…</span>
                  <span v-else>🎉 BINGO!</span>
                </button>
              </template>
            </div>
          </div>
        </div>
      </template>

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
const claimingBingo = ref(false)
const showWinnerOverlay = ref(false)
const showCancelledOverlay = ref(false)
const redirectCountdown = ref(10)
const audioEnabled = ref(true)

const selectedSerials = ref<string[]>([])
const joining = ref(false)
const joinError = ref('')

const countdownStartsAt = ref<string | null>(null)
const countdownRemaining = ref(0)
const COUNTDOWN_TOTAL = 60

const livePlayerCount = ref(0)

// Manual ticks: entryId -> Set of numbers the player manually ticked
const manualTicks = ref<Record<string, Set<number>>>({})

let countdownTickTimer: ReturnType<typeof setInterval> | null = null
let redirectTimer: ReturnType<typeof setInterval> | null = null
let audioCtx: AudioContext | null = null
let audioUnlocked = false
// Pool of reusable <audio> elements for ball sounds
const audioElPool: HTMLAudioElement[] = []

const COLUMNS = ['B', 'I', 'N', 'G', 'O']

// ── Computed ───────────────────────────────────────────────────────────────
const isWinner = computed(() => gameStore.winner?.username === auth.user?.username)

/** Current wallet balance from persisted auth store */
const walletBalance = computed(() => Number(auth.wallet?.realBalance ?? 0) + Number(auth.wallet?.bonusBalance ?? 0))

/** Resolved UI phase driven by gameStore.gameStatus + hasJoined */
const phase = computed<'join' | 'waiting' | 'active'>(() => {
  if (gameStore.gameStatus === 'active') return 'active'
  if (gameStore.hasJoined) return 'waiting'
  return 'join'
})

const totalCost = computed(
  () => selectedSerials.value.length * Number((gameStore.currentGame as any)?.ticketPrice ?? 0),
)

const statusClass = computed(() => {
  const s = gameStore.currentGame?.status?.toLowerCase() ?? ''
  return s.replace(/_/g, '-')
})

const displayStatus = computed(() => {
  if (gameStore.gameStatus === 'active') return 'Live'
  if (gameStore.gameStatus === 'starting') return 'Starting…'
  if (gameStore.gameStatus === 'waiting') return 'Waiting'
  if (gameStore.gameStatus === 'ended') return 'Ended'
  return gameStore.currentGame?.status ?? 'Unknown'
})

const playerProgressPct = computed(() => {
  return 100 // Progress bar is now just fully green
})

const netPrize = computed(() => {
  const pot = gameStore.livePots[gameId] ?? 0
  const houseEdge = Number((gameStore.currentGame as any)?.houseEdgePct ?? 0) / 100
  return pot * (1 - houseEdge)
})

// SVG countdown ring: circumference = 2π×52 ≈ 326.73
const RING_CIRC = 2 * Math.PI * 52
const ringOffset = computed(() => {
  const secs = gameStore.liveTimers[gameId] ?? countdownRemaining.value
  const pct = Math.max(0, secs) / COUNTDOWN_TOTAL
  return RING_CIRC * (1 - pct)
})

// ── Helpers ────────────────────────────────────────────────────────────────
function boardNumber(ci: number, row: number): number {
  return ci * 15 + row
}

function getGrid(jsonGrid: unknown): number[][] {
  if (typeof jsonGrid === 'string') return JSON.parse(jsonGrid)
  return jsonGrid as number[][]
}

function isCellMarked(num: number, r: number, c: number): boolean {
  if (r === 2 && c === 2) return true
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

function shortSerial(serial: string): string {
  return serial.slice(-6).replace(/^-/, '')
}

function canClaimBingo(cartela: Cartela, entryId: string): boolean {
  if (gameStore.gameStatus !== 'active' || !gameStore.currentGame) return false
  const grid = getGrid(cartela.grid)
  const calledSet = new Set<number>(gameStore.calledBalls)
  const ticks = manualTicks.value[entryId] || new Set<number>()

  const validMarkedSet = new Set<number>()
  grid.forEach((row, r) => {
    row.forEach((num, c) => {
      if (r === 2 && c === 2) return
      if (calledSet.has(num) && ticks.has(num)) validMarkedSet.add(num)
    })
  })

  try {
    return checkPattern(gameStore.currentGame!.pattern as PatternName, grid, validMarkedSet)
  } catch {
    return false
  }
}

function toggleCartela(serial: string) {
  const idx = selectedSerials.value.indexOf(serial)
  if (idx === -1) selectedSerials.value.push(serial)
  else selectedSerials.value.splice(idx, 1)
}

function isManuallyTicked(entryId: string, num: number, r: number, c: number): boolean {
  if (r === 2 && c === 2) return false
  return manualTicks.value[entryId]?.has(num) ?? false
}

function toggleTick(entryId: string, num: number) {
  if (!manualTicks.value[entryId]) manualTicks.value[entryId] = new Set()
  const ticks = manualTicks.value[entryId]
  if (ticks.has(num)) ticks.delete(num)
  else ticks.add(num)
}

// ── Ball column helper ──────────────────────────────────────────────────────
function getBallColumn(ball: number): string {
  if (ball <= 15) return 'b'
  if (ball <= 30) return 'i'
  if (ball <= 45) return 'n'
  if (ball <= 60) return 'g'
  return 'o'
}

// ── Audio ──────────────────────────────────────────────────────────────────
// Ball sounds use plain HTMLAudioElement (simple, reliable across all browsers).
// Countdown beeps & win melody use AudioContext (oscillator synthesis).

function ensureAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
  return audioCtx
}

// Get or create a reusable <audio> element from the pool.
function getPooledAudio(): HTMLAudioElement {
  let el = audioElPool.find(a => a.paused && !a.seeking)
  if (!el) {
    el = new Audio()
    el.preload = 'auto'
    audioElPool.push(el)
  }
  return el
}

// Called on first user gesture — unlocks both HTMLAudioElement and AudioContext.
function unlockAudio() {
  if (audioUnlocked) return
  audioUnlocked = true

  // 1) Unlock HTMLAudioElement by playing a tiny silent WAV from a data URI.
  //    This satisfies iOS/Android autoplay policy for all future .play() calls.
  const silentEl = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=')
  silentEl.volume = 0.01
  silentEl.play().then(() => silentEl.remove()).catch(() => {})

  // 2) Unlock AudioContext for oscillator beeps
  const ctx = ensureAudioCtx()
  if (ctx) {
    const buf = ctx.createBuffer(1, 1, 22050)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(0)
  }

  console.log('[Audio] Unlocked via user gesture')
  document.removeEventListener('touchstart', unlockAudio)
  document.removeEventListener('click', unlockAudio)
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && audioCtx?.state === 'suspended') {
    audioCtx.resume().catch(() => {})
  }
}

function playBallSound(ball: number) {
  if (!audioEnabled.value) return
  const key = `${getBallColumn(ball)}${ball}`
  const el = getPooledAudio()
  el.src = `/audio/${key}.mp3`
  el.currentTime = 0
  el.play().catch(err => console.warn(`[Audio] play ${key} failed:`, err))
}

function playCountdownBeep(secs: number) {
  if (!audioEnabled.value) return
  if (secs > 10 && secs % 10 !== 0) return // beep every 10s above 10, every second below
  const ctx = ensureAudioCtx()
  if (!ctx) return
  const freq = secs <= 5 ? 880 : 440
  const o = ctx.createOscillator(); const g = ctx.createGain()
  o.connect(g); g.connect(ctx.destination)
  o.type = 'square'
  o.frequency.setValueAtTime(freq, ctx.currentTime)
  g.gain.setValueAtTime(0.15, ctx.currentTime)
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12)
  o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.12)
}

function playWinSound() {
  if (!audioEnabled.value) return
  const ctx = ensureAudioCtx()
  if (!ctx) return
  const melody = [523.25, 659.25, 783.99, 1046.5, 1318.51]
  melody.forEach((freq, i) => {
    const o = ctx!.createOscillator(); const g = ctx!.createGain()
    o.connect(g); g.connect(ctx!.destination)
    o.type = 'sine'
    const t = ctx!.currentTime + i * 0.1
    o.frequency.setValueAtTime(freq, t)
    g.gain.setValueAtTime(0.3, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
    o.start(t); o.stop(t + 0.5)
  })
}

// ── Countdown ──────────────────────────────────────────────────────────────
let lastBeepSec = -1
function startCountdown(startsAt: string) {
  countdownStartsAt.value = startsAt
  if (countdownTickTimer) clearInterval(countdownTickTimer)
  const tick = () => {
    const diff = (new Date(startsAt).getTime() - Date.now()) / 1000
    const secs = Math.max(0, Math.ceil(diff))
    countdownRemaining.value = secs
    if (secs !== lastBeepSec) {
      playCountdownBeep(secs)
      lastBeepSec = secs
    }
  }
  tick()
  countdownTickTimer = setInterval(tick, 250)
}

// ── Join ───────────────────────────────────────────────────────────────────
async function handleJoin() {
  if (!selectedSerials.value.length) return
  unlockAudio()
  joining.value = true
  joinError.value = ''
  try {
    await gameStore.joinGame(gameId, selectedSerials.value)
    // Refresh wallet balance after payment
    await auth.fetchWallet()
    const socket = connect()
    socket?.emit('game:join-room', { gameId })
    // Phase will auto-switch to 'waiting' via gameStore.hasJoined
  } catch (e: any) {
    joinError.value = e?.data?.message ?? e?.message ?? 'Failed to join game'
  } finally {
    joining.value = false
  }
}

const leaving = ref(false)
async function handleLeaveGame() {
  if (!confirm('Are you sure you want to leave? Your entry fee will be refunded.')) return
  leaving.value = true
  try {
    await gameStore.leaveGame(gameId)
    goToLobby()
  } catch (e: any) {
    alert(e?.message ?? 'Failed to leave game')
  } finally {
    leaving.value = false
  }
}

// ── Bingo claim ────────────────────────────────────────────────────────────
async function handleClaimBingo(cartelaId: string) {
  claimingBingo.value = true
  try {
    const socket = connect()
    if (socket?.connected) {
      socket.emit('game:claim-bingo', { gameId, cartelaId })
    } else {
      await gameStore.claimBingo(gameId, cartelaId)
    }
  } catch {
    // store already set error
  } finally {
    claimingBingo.value = false
  }
}

// ── Redirect countdown ─────────────────────────────────────────────────────
function startRedirectCountdown() {
  redirectCountdown.value = 10
  if (redirectTimer) clearInterval(redirectTimer)
  redirectTimer = setInterval(() => {
    redirectCountdown.value--
    if (redirectCountdown.value <= 0) goToLobby()
  }, 1000)
}

function goToLobby() {
  if (countdownTickTimer) clearInterval(countdownTickTimer)
  if (redirectTimer) clearInterval(redirectTimer)
  gameStore.resetGame()
  router.push('/')
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  loading.value = true
  errorMsg.value = ''
  try {
    const game = await gameStore.fetchGameDetails(gameId)
    if (!game) { errorMsg.value = 'Game not found.'; return }

    // Set game status from server
    const rawStatus = (game.status as string)
    if (rawStatus === 'IN_PROGRESS') {
      gameStore.gameStatus = 'active'
      gameStore.calledBalls = (game as any).calledBalls ?? []
    } else if (rawStatus === 'LOCKING' || rawStatus === 'STARTING') {
      gameStore.gameStatus = 'starting'
    } else if (rawStatus === 'COMPLETED' || rawStatus === 'CANCELLED' || rawStatus === 'REFUNDING') {
      gameStore.gameStatus = 'ended'
    } else {
      // WAITING — keep as 'idle' until we know if user has joined;
      // phase computed will resolve to 'join' or 'waiting' based on myEntries
      gameStore.gameStatus = 'idle'
    }

    // Seed live player count
    livePlayerCount.value = (game as any).currentPlayers ?? (game as any)._count?.entries ?? 0

    // Load this user's entries from the game response
    const existingEntries = (game as any)?.entries?.filter(
      (e: any) => e.userId === auth.user?.id,
    )
    if (existingEntries?.length) {
      gameStore.myEntries = existingEntries
    }

    // Load cartelas for join phase only — not needed when rejoining an active game
    if (rawStatus !== 'IN_PROGRESS') {
      await gameStore.fetchAvailableCartelas(gameId)
    }

    // Refresh wallet so balance is current
    await auth.fetchWallet()

    // Restore countdown if still valid
    const storedStartsAt = gameStore.countdowns[gameId]
    if (storedStartsAt && new Date(storedStartsAt).getTime() > Date.now()) {
      startCountdown(storedStartsAt)
    }
  } catch (e: any) {
    errorMsg.value = e?.message ?? 'Failed to load game.'
  } finally {
    loading.value = false
  }
}

await init()

// ── Socket ─────────────────────────────────────────────────────────────────
onMounted(() => {
  document.addEventListener('touchstart', unlockAudio, { once: true })
  document.addEventListener('click', unlockAudio, { once: true })
  document.addEventListener('visibilitychange', handleVisibilityChange)

  const socket = connect()
  if (!socket) return

  socket.emit('game:join-room', { gameId })

  socket.on('game:updated', (game: any) => {
    gameStore.onGameUpdated(game)
    // Sync live player count
    if (game.id === gameId) {
      livePlayerCount.value = game.currentPlayers ?? game._count?.entries ?? livePlayerCount.value
    }
  })

  // New spec events from room state machine
  ;(socket as any).on('timer_update', (payload: { gameId: string; secondsLeft: number | null }) => {
    if (payload.gameId !== gameId) return
    gameStore.onTimerUpdate(gameId, payload.secondsLeft)
    if (payload.secondsLeft && payload.secondsLeft > 0) {
      // Drive the countdown ring directly from server ticks
      countdownRemaining.value = payload.secondsLeft
      if (!countdownStartsAt.value) {
        // First tick — synthesise a startsAt so the ring has a reference
        countdownStartsAt.value = new Date(Date.now() + payload.secondsLeft * 1000).toISOString()
      }
      playCountdownBeep(payload.secondsLeft)
    } else {
      // No active timer — clear local countdown state
      countdownStartsAt.value = null
      countdownRemaining.value = 0
    }
  })

  ;(socket as any).on('player_count_update', (payload: { gameId: string; playerCount: number }) => {
    if (payload.gameId !== gameId) return
    livePlayerCount.value = payload.playerCount
    gameStore.onPlayerCountUpdate(gameId, payload.playerCount)
  })

  ;(socket as any).on('pot_update', (payload: { gameId: string; pot: number }) => {
    if (payload.gameId !== gameId) return
    gameStore.onPotUpdate(gameId, payload.pot)
  })

  socket.on('game:countdown', (payload: any) => {
    gameStore.onGameCountdown(payload)
    if (payload.gameId === gameId) startCountdown(payload.startsAt)
  })

  socket.on('game:started', (game: any) => {
    gameStore.onGameStarted(game)
    if (countdownTickTimer) clearInterval(countdownTickTimer)
    countdownStartsAt.value = null
    gameStore.gameStatus = 'active'
  })

  socket.on('game:ball-called', (payload: any) => {
    gameStore.onBallCalled(payload)
  })

  ;(socket as any).on('new_call', (payload: any) => {
    gameStore.onBallCalled(payload)
    if (payload.gameId === gameId) playBallSound(payload.ball)
  })

  socket.on('game:winner', (payload: any) => {
    gameStore.onGameWinner(payload)
    playWinSound()
    showWinnerOverlay.value = true
    startRedirectCountdown()
  })

  // game_over = spec event (includes full breakdown), treat same as game:winner
  ;(socket as any).on('game_over', (payload: any) => {
    if (payload.gameId !== gameId) return
    const myWinner = payload.winners?.find((w: any) => w.userId === auth.user?.id)
    gameStore.onGameWinner({
      gameId,
      winner: myWinner ?? payload.winners?.[0] ?? { username: 'Unknown' },
      prizeAmount: myWinner?.netWin ?? payload.winners?.[0]?.netWin ?? 0,
    })
    playWinSound()
    showWinnerOverlay.value = true
    startRedirectCountdown()
  })

  socket.on('game:ended', (game: any) => {
    gameStore.onGameEnded(game)
    if (!showWinnerOverlay.value) { showWinnerOverlay.value = true; startRedirectCountdown() }
  })

  socket.on('cartelas:taken', (payload: any) => {
    gameStore.onCartelasTaken(payload)
    if (payload.gameId === gameId) {
      selectedSerials.value = selectedSerials.value.filter(
        (serial) => !payload.cartelaSerials.includes(serial)
      )
    }
  })

  socket.on('game:cancelled', (payload: any) => {
    gameStore.onGameCancelled(payload)
    if (countdownTickTimer) clearInterval(countdownTickTimer)
    countdownStartsAt.value = null
    showCancelledOverlay.value = true
    startRedirectCountdown()
  })

  // game_cancelled = spec alias
  ;(socket as any).on('game_cancelled', (payload: any) => {
    if (payload.gameId !== gameId) return
    gameStore.onGameCancelled(payload)
    if (countdownTickTimer) clearInterval(countdownTickTimer)
    countdownStartsAt.value = null
    showCancelledOverlay.value = true
    startRedirectCountdown()
  })
})

onUnmounted(() => {
  if (countdownTickTimer) clearInterval(countdownTickTimer)
  if (redirectTimer) clearInterval(redirectTimer)
  if (audioCtx) { audioCtx.close(); audioCtx = null }
  audioElPool.forEach(el => { el.pause(); el.src = '' })
  audioElPool.length = 0
  audioUnlocked = false
  document.removeEventListener('touchstart', unlockAudio)
  document.removeEventListener('click', unlockAudio)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<style scoped>
/* ── Page ───────────────────────────────────────────────────────────────── */
.play-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1rem 1.25rem 3rem;
  min-height: calc(100vh - 60px);
}

/* ── JOIN PHASE ─────────────────────────────────────────────────────────── */
.join-phase {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  padding: 1.5rem 0;
}

.join-hero {
  text-align: center;
}

.join-icon {
  font-size: 3rem;
  margin-bottom: 0.5rem;
}

.join-hero h3 {
  margin: 0 0 0.6rem;
  font-size: 1.3rem;
  font-weight: 700;
  color: #f1f5f9;
}

/* Error banner */
.join-error-banner {
  width: 100%;
  max-width: 640px;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 10px;
  padding: 0.75rem 1rem;
  color: #f87171;
  font-size: 0.9rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.err-close {
  background: none;
  border: none;
  color: #f87171;
  cursor: pointer;
  font-size: 1rem;
  padding: 0;
  line-height: 1;
  opacity: 0.7;
  flex-shrink: 0;
}
.err-close:hover { opacity: 1; }

.err-slide-enter-active { transition: all 0.25s ease; }
.err-slide-leave-active { transition: all 0.2s ease; }
.err-slide-enter-from, .err-slide-leave-to { opacity: 0; transform: translateY(-8px); }

/* Join meta row */
.join-meta-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  justify-content: center;
  margin-bottom: 0.4rem;
}

.join-price-chip {
  font-size: 0.88rem;
  background: rgba(245, 158, 11, 0.12);
  color: #fbbf24;
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 20px;
  padding: 0.25rem 0.75rem;
}

.wallet-chip {
  font-size: 0.88rem;
  background: rgba(34, 197, 94, 0.1);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.2);
  border-radius: 20px;
  padding: 0.25rem 0.75rem;
}

.wallet-chip.low-balance {
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
  border-color: rgba(239, 68, 68, 0.25);
}

.selected-summary {
  font-size: 0.9rem;
  color: #94a3b8;
  margin: 0;
}

.insufficient {
  color: #f87171;
  font-size: 0.82rem;
  margin-left: 0.5rem;
}

.tile-taken-x {
  position: absolute;
  font-size: 0.7rem;
  color: #ef4444;
  font-weight: 900;
}

.join-hint {
  font-size: 0.78rem;
  color: #475569;
  margin: 0.3rem 0 0;
}

.cartela-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
  gap: 0.5rem;
  width: 100%;
  max-width: 640px;
  max-height: 340px;
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 14px;
  background: rgba(255,255,255,0.02);
}

.cartela-tile {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1.5px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
  background: rgba(255,255,255,0.04);
  user-select: none;
}

.tile-num {
  font-size: 0.78rem;
  font-weight: 700;
  color: #94a3b8;
}

.tile-check {
  position: absolute;
  top: 2px;
  right: 4px;
  font-size: 0.6rem;
  color: #10b981;
  font-weight: 900;
}

.cartela-tile:hover:not(.taken) {
  border-color: #f59e0b;
  background: rgba(245,158,11,0.09);
}

.cartela-tile.selected {
  border-color: #f59e0b;
  background: rgba(245,158,11,0.18);
  box-shadow: 0 0 0 1px rgba(245,158,11,0.3);
}

.cartela-tile.selected .tile-num { color: #fbbf24; }

.cartela-tile.taken {
  opacity: 0.22;
  cursor: not-allowed;
}

.msg.error {
  font-size: 0.875rem;
  background: rgba(220,38,38,0.1);
  color: #f87171;
  border: 1px solid rgba(220,38,38,0.3);
  border-radius: 8px;
  padding: 0.5rem 0.85rem;
  max-width: 480px;
  text-align: center;
}

.join-btn {
  padding: 0.9rem 2.5rem;
  font-size: 1rem;
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #000;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  transition: all 0.2s;
  box-shadow: 0 0 20px rgba(245,158,11,0.25);
}

.join-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}

.join-btn:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 0 28px rgba(245,158,11,0.4);
}

.btn-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0,0,0,0.2);
  border-top-color: #000;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* ── WAITING PHASE ──────────────────────────────────────────────────────── */
.waiting-phase {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  padding: 1.25rem 0.5rem 0;
}

/* Player progress */
.players-progress-wrap {
  width: 100%;
  max-width: 480px;
}

.players-progress-label {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  color: #888;
  margin-bottom: 0.4rem;
}

.pp-count strong { font-size: 0.9rem; }

.players-progress-bar {
  height: 8px;
  background: rgba(255,255,255,0.07);
  border-radius: 10px;
  overflow: hidden;
}

.players-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #22c55e, #4ade80);
  border-radius: 10px;
  transition: width 0.5s ease;
  min-width: 4px;
}

/* Countdown block */
.countdown-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(201,169,110,0.18);
  border-radius: 16px;
  width: 100%;
  max-width: 360px;
}

.countdown-title {
  font-size: 1rem;
  font-weight: 700;
  color: #4ade80;
  margin: 0;
}

.countdown-sub {
  font-size: 0.82rem;
  color: #94a3b8;
  margin: 0;
}

.countdown-warn {
  font-size: 0.75rem;
  color: #64748b;
  text-align: center;
  margin: 0;
  max-width: 280px;
}

.countdown-warn strong { color: #fbbf24; }

.pot-display {
  font-size: 0.9rem;
  color: #94a3b8;
  text-align: center;
  margin: 0.25rem 0 0.75rem;
}

.pot-display strong {
  color: #4ade80;
  font-size: 1.05rem;
}

.leave-queue-btn {
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.leave-queue-btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.2);
  border-color: rgba(239, 68, 68, 0.5);
}

.leave-queue-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.you-lost { color: #94a3b8; font-weight: 800; }
.other-won-sub { font-size: 0.9rem; color: #64748b; margin-top: -0.5rem; }

/* Still waiting */
.still-waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  color: #888;
}

.still-waiting h3 {
  margin: 0;
  font-size: 1.1rem;
  color: #f1f5f9;
}

.waiting-sub {
  font-size: 0.85rem;
  color: #64748b;
  margin: 0;
  text-align: center;
}

.waiting-refund-note {
  font-size: 0.78rem;
  color: #475569;
  margin: 0;
  text-align: center;
}

/* Preview cards */
.waiting-cards-section {
  width: 100%;
  margin-top: 0.5rem;
}

.wc-title {
  text-align: center;
  font-size: 0.8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #555;
  margin: 0 0 0.75rem;
}

.preview-card {
  opacity: 0.72;
}

.preview-badge {
  font-size: 0.6rem;
  padding: 0.1rem 0.4rem;
  background: rgba(99,102,241,0.15);
  color: #a5b4fc;
  border-radius: 8px;
  font-weight: 600;
  text-transform: uppercase;
}

/* ── States ──────────────────────────────────────────────────────────────── */
.state-message {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  padding: 4rem 2rem; color: #888; gap: 1rem; text-align: center;
}
.state-message.error { color: #f87171; }
.spinner, .waiting-spinner {
  width: 40px; height: 40px;
  border: 3px solid rgba(255,255,255,0.1);
  border-top-color: var(--color-primary, #c9a96e);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.back-btn {
  padding: 0.6rem 1.5rem;
  background: var(--color-primary, #c9a96e);
  color: #000; border: none; border-radius: 8px;
  font-weight: 700; cursor: pointer; font-size: 0.9rem;
  transition: opacity 0.2s;
}
.back-btn:hover { opacity: 0.85; }

/* ── Game Header ─────────────────────────────────────────────────────────── */
.game-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem; padding: 0.875rem 1rem;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px; margin-bottom: 1.25rem; flex-wrap: wrap;
}
.header-left { display: flex; flex-direction: column; gap: 0.4rem; }
.game-title { margin: 0; font-size: 1.15rem; font-weight: 700; color: #f1f5f9; }
.header-badges { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.status-badge, .pattern-badge, .stake-badge, .ball-count-badge {
  font-size: 0.68rem; padding: 0.18rem 0.55rem; border-radius: 20px;
  font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
}
.status-badge { background: rgba(34,197,94,0.15); color: #4ade80; }
.status-badge.waiting { background: rgba(234,179,8,0.15); color: #fbbf24; }
.status-badge.starting { background: rgba(99,102,241,0.15); color: #a5b4fc; }
.status-badge.in-progress { background: rgba(34,197,94,0.15); color: #4ade80; }
.status-badge.completed { background: rgba(100,116,139,0.15); color: #94a3b8; }
.pattern-badge { background: rgba(201,169,110,0.12); color: var(--color-primary,#c9a96e); }
.stake-badge { background: rgba(245,158,11,0.1); color: #fbbf24; }
.players-badge { background: rgba(99,102,241,0.12); color: #a5b4fc; }
.ball-count-badge { background: rgba(255,255,255,0.06); color: #888; }
.header-right { display: flex; align-items: center; gap: 0.75rem; }
.audio-btn {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; cursor: pointer; font-size: 1rem; transition: background 0.15s;
}
.audio-btn:hover { background: rgba(255,255,255,0.1); }

/* ── 60s Countdown Ring ──────────────────────────────────────────────────── */
.countdown-section {
  display: flex; flex-direction: column; align-items: center;
  padding: 1.5rem 0 1rem; gap: 0.5rem;
}
.countdown-ring-wrap {
  position: relative; width: 140px; height: 140px; margin-bottom: 0.5rem;
}
.countdown-ring { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring-track { fill: none; stroke: rgba(255,255,255,0.07); stroke-width: 8; }
.ring-fill {
  fill: none; stroke: var(--color-primary, #c9a96e); stroke-width: 8;
  stroke-linecap: round; stroke-dasharray: 326.73; stroke-dashoffset: 0;
  transition: stroke-dashoffset 0.25s linear;
}
.countdown-inner {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.countdown-secs { font-size: 2.8rem; font-weight: 900; color: var(--color-primary, #c9a96e); line-height: 1; }
.countdown-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; color: #888; }
.countdown-msg { font-size: 0.95rem; font-weight: 600; color: #f1f5f9; margin: 0; }
.countdown-sub { font-size: 0.78rem; color: #666; margin: 0; }

/* ── Waiting (no countdown) ──────────────────────────────────────────────── */
.waiting-state {
  display: flex; flex-direction: column; align-items: center;
  padding: 2rem 1rem 1rem; gap: 0.6rem; color: #aaa;
}
.waiting-state h3 { margin: 0; color: #f1f5f9; font-size: 1.05rem; }
.waiting-hint { font-size: 0.82rem; color: #666; margin: 0; }
.waiting-cards { width: 100%; margin-top: 1.5rem; }
.waiting-cards-title {
  text-align: center; font-size: 0.85rem; font-weight: 600; color: #888;
  text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 0.75rem;
}

/* ── Live game (Phase 3) ─────────────────────────────────────────────────── */
.live-top-strip {
  display: flex;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 0.8rem 1rem;
  margin-bottom: 1rem;
  align-items: center;
  gap: 1.5rem;
}

.hero-ball-wrap {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-width: 70px;
}
.hb-label { font-size: 0.65rem; text-transform: uppercase; color: #888; letter-spacing: 0.05em; margin-bottom: 0.2rem; }
.hero-ball {
  width: 54px; height: 54px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.2);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%), var(--ball-bg, #333);
  box-shadow: 0 4px 10px rgba(0,0,0,0.5); font-weight: 900; line-height: 1; text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
.hero-ball.placeholder { --ball-bg: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1); box-shadow: inset 0 2px 5px rgba(0,0,0,0.2); }
.hb-letter { font-size: 0.65rem; opacity: 0.8; }
.hb-num { font-size: 1.25rem; }
.placeholder .hb-letter { font-size: 1.25rem; opacity: 0.3; }

.recent-strip { flex: 1; display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.rs-label { font-size: 0.65rem; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
.rs-balls { display: flex; gap: 0.4rem; overflow-x: auto; padding-bottom: 0.3rem; scrollbar-width: none; align-items: center; }
.rs-balls::-webkit-scrollbar { display: none; }
.rs-ball {
  width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: var(--ball-bg, #444); border: 1px solid rgba(255,255,255,0.15);
  box-shadow: inset 0 2px 5px rgba(255,255,255,0.1), 0 2px 4px rgba(0,0,0,0.2);
  line-height: 1;
}
.rs-letter { font-size: 0.5rem; font-weight: 800; opacity: 0.7; }
.rs-num { font-size: 0.9rem; font-weight: 900; }

.col-b { --ball-bg: #3b82f6; color: white; }
.col-i { --ball-bg: #ef4444; color: white; }
.col-n { --ball-bg: #f59e0b; color: #111; }
.col-g { --ball-bg: #22c55e; color: white; }
.col-o { --ball-bg: #a855f7; color: white; }

.ball-counter { display: flex; flex-direction: column; align-items: center; min-width: 60px; }
.bc-num { font-size: 1.2rem; font-weight: 900; color: var(--color-primary, #c9a96e); }
.bc-label { font-size: 0.65rem; color: #888; text-transform: uppercase; white-space: nowrap; }

/* ── 75-Ball Master Board (Horizontal) ───────────────────────────────────── */
.master-board {
  background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.06);
  border-radius: 10px; padding: 0.8rem; margin-bottom: 1.5rem; overflow-x: auto;
}
.mb-cols { display: flex; flex-direction: column; gap: 4px; min-width: max-content; }
.mb-col { display: flex; gap: 4px; align-items: center; }
.mb-col-header {
  width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
  font-weight: 900; border-radius: 4px; font-size: 0.8rem; flex-shrink: 0;
  color: rgba(255,255,255,0.9); text-shadow: 0 1px 2px rgba(0,0,0,0.5); box-shadow: inset 0 1px 3px rgba(255,255,255,0.2);
}
.mb-cell {
  width: 24px; height: 24px; border-radius: 4px;
  display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 600;
  background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.3); border: 1px solid transparent;
  transition: all 0.2s;
}
.mbc-b .mb-col-header { background: #3b82f6; }
.mbc-i .mb-col-header { background: #ef4444; }
.mbc-n .mb-col-header { background: #f59e0b; color: #111; text-shadow: none; }
.mbc-g .mb-col-header { background: #22c55e; }
.mbc-o .mb-col-header { background: #a855f7; }

.mb-cell.called { background: rgba(255,255,255,0.12); color: #fff; border-color: rgba(255,255,255,0.2); }
.mbc-b .mb-cell.called { background: rgba(59,130,246,0.3); border-color: rgba(59,130,246,0.5); }
.mbc-i .mb-cell.called { background: rgba(239,68,68,0.3); border-color: rgba(239,68,68,0.5); }
.mbc-n .mb-cell.called { background: rgba(245,158,11,0.3); border-color: rgba(245,158,11,0.5); color: #fcd34d; }
.mbc-g .mb-cell.called { background: rgba(34,197,94,0.3); border-color: rgba(34,197,94,0.5); }
.mbc-o .mb-cell.called { background: rgba(168,85,247,0.3); border-color: rgba(168,85,247,0.5); }

.mb-cell.last-called {
  transform: scale(1.15); border-width: 2px; border-color: #fff !important; font-weight: 900; z-index: 2;
  box-shadow: 0 0 10px rgba(255,255,255,0.5); background: var(--color-primary, #c9a96e) !important; color: #000 !important;
}

/* ── Cartelas (Tickets) & Grids ──────────────────────────────────────────── */
.cartelas-section { display: flex; flex-direction: column; width: 100%; }
.cartelas-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1.25rem; justify-items: center; }
.cartela-card {
  width: 100%; max-width: 320px; background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 1.25rem;
  box-sizing: border-box; display: flex; flex-direction: column; gap: 0.8rem;
  transition: all 0.25s ease; position: relative; overflow: hidden;
}
.cartela-card.has-bingo { border-color: #f59e0b; box-shadow: 0 0 25px rgba(245,158,11,0.15), inset 0 0 20px rgba(245,158,11,0.05); }

.card-top { display: flex; justify-content: space-between; align-items: center; }
.card-serial { font-size: 0.85rem; font-weight: 700; color: #888; }
.bingo-indicator { font-size: 0.75rem; font-weight: 900; color: #f59e0b; background: rgba(245,158,11,0.15); padding: 0.2rem 0.6rem; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.05em; }

.bingo-card-grid { display: flex; flex-direction: column; gap: 4px; }
.bcg-header, .bcg-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
.bcg-hcell {
  text-align: center; font-weight: 900; font-size: 0.9rem; padding: 0.35rem 0; border-radius: 6px;
  color: rgba(255,255,255,0.9); text-shadow: 0 1px 2px rgba(0,0,0,0.4); box-shadow: inset 0 1px 3px rgba(255,255,255,0.15);
}
.gcol-b { background: #3b82f6; }
.gcol-i { background: #ef4444; }
.gcol-n { background: #f59e0b; color: #111; text-shadow: none; }
.gcol-g { background: #22c55e; }
.gcol-o { background: #a855f7; }

.bcg-cell {
  aspect-ratio: 1; display: flex; align-items: center; justify-content: center; position: relative;
  background: rgba(255,255,255,0.04); border-radius: 6px; border: 2px solid transparent;
  font-weight: 700; font-size: 1.1rem; color: #ddd; transition: all 0.15s ease; cursor: pointer; user-select: none;
}
.bcg-cell:hover:not(.free-space) { border-color: rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); }

/* Auto-mark (server called) vs Manual Tick (user act) */
.bcg-cell.free-space { background: rgba(201,169,110,0.15); color: var(--color-primary, #c9a96e); cursor: default; border: none; font-size: 1.3rem; }
.bcg-cell.auto-marked { border-color: var(--color-primary, #c9a96e); color: #fff; background: rgba(201,169,110,0.15); opacity: 0.7; }

/* The manual tick adds a nice green gradient and tick mark if the user clicks it BEFORE it's auto-marked,
   or just makes it clearly "checked off" if both are true. */
.bcg-cell.manually-ticked {
  background: var(--color-primary, #c9a96e); color: #000; opacity: 1; transform: scale(1.04); box-shadow: 0 4px 10px rgba(0,0,0,0.3); border-color: #fcd34d;
}
.tick-mark { position: absolute; bottom: 1px; right: 2px; font-size: 0.55rem; color: #000; font-weight: 900; line-height: 1; text-shadow: none; }
.bcg-cell.manually-ticked.auto-marked { background: linear-gradient(135deg, #10b981, #059669); color: white; border-color: #34d399; }
.bcg-cell.manually-ticked.auto-marked .tick-mark { color: white; }

.bcg-cell.just-called { animation: cell-pop 0.6s ease; z-index: 2; border-color: #fff; box-shadow: 0 0 15px rgba(255,255,255,0.4); }
@keyframes cell-pop { 0% { transform: scale(1); } 40% { transform: scale(1.15); } 100% { transform: scale(1); } }

/* ── Bingo Button ───────────────────────────────────────────────────────── */
.bingo-button {
  width: 100%;
  padding: 0.9rem;
  border-radius: 10px;
  border: 2px solid rgba(255,255,255,0.08);
  font-weight: 900;
  font-size: 1.1rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  background: rgba(255,255,255,0.03);
  color: rgba(255,255,255,0.2);
  cursor: not-allowed;
  transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  margin-top: 0.75rem;
  pointer-events: none;
  filter: grayscale(1) opacity(0.4);
}
.bingo-button.active {
  background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
  border-color: #f59e0b;
  color: #fff;
  cursor: pointer;
  pointer-events: all;
  filter: none;
  box-shadow: 0 0 0 4px rgba(245,158,11,0.25), 0 8px 24px rgba(245,158,11,0.5);
  transform: scale(1.02);
  text-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.bingo-button.active:hover {
  transform: scale(1.05) translateY(-2px);
  box-shadow: 0 0 0 6px rgba(245,158,11,0.2), 0 12px 32px rgba(245,158,11,0.6);
}
.bingo-button.active:active {
  transform: scale(0.98);
  box-shadow: 0 0 0 2px rgba(245,158,11,0.4), 0 4px 12px rgba(245,158,11,0.4);
}
.bingo-button.pulsing { animation: pulse-bingo 1.2s infinite; }
@keyframes pulse-bingo {
  0%   { box-shadow: 0 0 0 4px rgba(245,158,11,0.25), 0 8px 24px rgba(245,158,11,0.5); }
  50%  { box-shadow: 0 0 0 10px rgba(245,158,11,0.1), 0 8px 32px rgba(239,68,68,0.6); }
  100% { box-shadow: 0 0 0 4px rgba(245,158,11,0.25), 0 8px 24px rgba(245,158,11,0.5); }
}

/* ── Overlays ────────────────────────────────────────────────────────────── */
.overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.88);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.overlay-card {
  background: var(--color-surface, #1a1a2e);
  border: 2px solid var(--color-primary, #c9a96e);
  border-radius: 16px; padding: 2.5rem; text-align: center;
  max-width: 400px; width: 90%; position: relative; overflow: hidden;
}
.confetti { font-size: 3rem; margin-bottom: 0.5rem; animation: confetti-bounce 0.8s ease-in-out; }
@keyframes confetti-bounce {
  0% { transform: scale(0) rotate(-20deg); opacity: 0; }
  60% { transform: scale(1.3) rotate(5deg); opacity: 1; }
  100% { transform: scale(1) rotate(0); }
}
.trophy { font-size: 4rem; margin-bottom: 0.5rem; }
.icon { font-size: 3.5rem; margin-bottom: 0.5rem; }
.overlay-card h2 { font-size: 1.8rem; margin: 0 0 0.5rem; color: var(--color-primary, #c9a96e); }
.you-won { color: #4ade80 !important; font-size: 2rem !important; }
.prize-amount {
  display: flex; flex-direction: column; align-items: center;
  font-size: 1.8rem; font-weight: 700; color: #4ade80; margin: 0.5rem 0;
}
.prize-label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.06em; }
.redirect-hint { color: #666; font-size: 0.85rem; margin-top: 1rem; }
.overlay-card .back-btn { margin-top: 1rem; }
.cancelled-card p strong { color: #fbbf24; }

/* ── Transitions ─────────────────────────────────────────────────────────── */
.overlay-fade-enter-active { transition: opacity 0.3s ease; }
.overlay-fade-leave-active { transition: opacity 0.2s ease; }
.overlay-fade-enter-from, .overlay-fade-leave-to { opacity: 0; }
.ball-bounce-enter-active { animation: ball-enter 0.4s ease-out; }
.ball-bounce-leave-active { animation: ball-leave 0.15s ease-in; }
@keyframes ball-enter {
  0% { transform: scale(0.3) translateY(-30px); opacity: 0; }
  60% { transform: scale(1.1) translateY(0); }
  100% { transform: scale(1) translateY(0); opacity: 1; }
}
@keyframes ball-leave { to { transform: scale(0.8); opacity: 0; } }
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
@keyframes bingo-pop-out { to { transform: scale(0.8); opacity: 0; } }

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 700px) {
  .game-live-section { grid-template-columns: 80px 1fr 58px; gap: 0.5rem; }
  .hero-ball { width: 70px; height: 70px; }
  .hero-ball-number { font-size: 1.7rem; }
  .board-num { font-size: 0.62rem; }
  .recent-ball { width: 36px; height: 36px; }
  .rb-num { font-size: 0.74rem; }
}
@media (max-width: 480px) {
  .play-page { padding: 0.6rem 0.75rem 2rem; }
  .game-live-section { grid-template-columns: 68px 1fr; }
  .recent-col { display: none; }
  .cartelas-grid { grid-template-columns: 1fr; }
  .cartela-card { max-width: 100%; }
}
</style>
