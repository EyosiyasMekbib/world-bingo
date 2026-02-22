<template>
  <div class="tournament-detail">
    <!-- Loading -->
    <div v-if="loading" class="loading">
      <div class="spinner" />
    </div>

    <!-- Not Found -->
    <div v-else-if="!tournament" class="error-state">
      <p>Tournament not found.</p>
      <NuxtLink to="/tournaments">← Back to Tournaments</NuxtLink>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="detail-header">
        <NuxtLink to="/tournaments" class="back-link">← Tournaments</NuxtLink>
        <div class="header-info">
          <div class="header-left">
            <span class="status-badge" :class="`badge-${tournament.status.toLowerCase()}`">
              {{ statusLabel(tournament.status) }}
            </span>
            <h1 class="tournament-title">{{ tournament.title }}</h1>
          </div>
          <div class="prize-display">
            <div class="prize-label">Prize Pool</div>
            <div class="prize-amount">{{ tournament.prizePool.toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} ETB</div>
          </div>
        </div>
      </div>

      <!-- Stats Bar -->
      <div class="stats-bar">
        <div class="stat-item">
          <span class="stat-label">Entry Fee</span>
          <span class="stat-value">{{ tournament.entryFee.toLocaleString() }} ETB</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Players</span>
          <span class="stat-value">{{ tournament.currentPlayers }} / {{ tournament.maxPlayers }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Rounds Played</span>
          <span class="stat-value">{{ tournament.rounds }}</span>
        </div>
        <div class="stat-item" v-if="tournament.scheduledAt">
          <span class="stat-label">Scheduled</span>
          <span class="stat-value">{{ formatDate(tournament.scheduledAt) }}</span>
        </div>
      </div>

      <!-- Winner Banner -->
      <div v-if="tournament.status === 'COMPLETED' && tournament.winnerId" class="winner-banner">
        <div class="winner-icon">🏆</div>
        <div class="winner-info">
          <div class="winner-label">Tournament Winner</div>
          <div class="winner-name">{{ winnerUsername }}</div>
          <div class="winner-prize">{{ tournament.prizePool.toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} ETB</div>
        </div>
      </div>

      <!-- Registration CTA -->
      <div v-if="tournament.status === 'REGISTRATION' && isAuthenticated && !isRegistered" class="register-box">
        <div class="register-info">
          <div class="register-title">Ready to compete?</div>
          <div class="register-sub">Entry fee: <strong>{{ tournament.entryFee.toLocaleString() }} ETB</strong> · Your balance: <strong>{{ walletBalance.toLocaleString() }} ETB</strong></div>
        </div>
        <button
          class="btn-register"
          :disabled="registering || walletBalance < tournament.entryFee"
          @click="registerForTournament"
        >
          <span v-if="registering">Registering...</span>
          <span v-else-if="walletBalance < tournament.entryFee">Insufficient Balance</span>
          <span v-else>Register Now</span>
        </button>
      </div>

      <div v-if="isRegistered" class="registered-badge">
        ✅ You are registered for this tournament
      </div>

      <div v-if="tournament.status === 'REGISTRATION' && !isAuthenticated" class="login-cta">
        <NuxtLink to="/auth/login" class="btn-primary">Login to Register</NuxtLink>
      </div>

      <!-- Current Round Game Link -->
      <div v-if="currentGameId && tournament.status === 'IN_PROGRESS' && isRegistered && !isEliminated" class="round-game-box">
        <div class="round-game-title">Round {{ tournament.rounds }} is Live!</div>
        <NuxtLink :to="`/quick/${currentGameId}`" class="btn-play">▶ Play Round {{ tournament.rounds }}</NuxtLink>
      </div>

      <div v-if="isEliminated" class="eliminated-box">
        <span>😢 You were eliminated from this tournament</span>
      </div>

      <!-- Leaderboard -->
      <section class="leaderboard-section">
        <h2 class="section-title">Leaderboard</h2>
        <div v-if="leaderboard.length" class="leaderboard-table">
          <div class="leaderboard-header">
            <span>Rank</span>
            <span>Player</span>
            <span>Wins</span>
            <span>Status</span>
          </div>
          <div
            v-for="entry in leaderboard"
            :key="entry.userId"
            class="leaderboard-row"
            :class="{ 'row-eliminated': entry.eliminated, 'row-me': entry.userId === auth.user?.id }"
          >
            <span class="rank">
              <span v-if="entry.rank === 1 && !entry.eliminated">🥇</span>
              <span v-else-if="entry.rank === 2 && !entry.eliminated">🥈</span>
              <span v-else-if="entry.rank === 3 && !entry.eliminated">🥉</span>
              <span v-else>#{{ entry.rank }}</span>
            </span>
            <span class="username">{{ entry.username }} <span v-if="entry.userId === auth.user?.id" class="you-tag">(You)</span></span>
            <span class="score">{{ entry.score }}</span>
            <span class="entry-status">
              <span v-if="entry.eliminated" class="elim">Eliminated</span>
              <span v-else class="alive">Active</span>
            </span>
          </div>
        </div>
        <div v-else class="empty-leaderboard">No players yet.</div>
      </section>
    </template>

    <!-- Toast -->
    <div v-if="toast.show" class="toast" :class="`toast-${toast.type}`">
      {{ toast.message }}
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TournamentDto, TournamentLeaderboardEntry } from '@world-bingo/shared-types'
import { TournamentStatus } from '@world-bingo/shared-types'
import { useSocket } from '~/composables/useSocket'

const route = useRoute()
const config = useRuntimeConfig()
const auth = useAuth()
const { socket } = useSocket()

const tournamentId = route.params.id as string

const loading = ref(true)
const tournament = ref<TournamentDto | null>(null)
const leaderboard = ref<TournamentLeaderboardEntry[]>([])
const registering = ref(false)
const currentGameId = ref<string | null>(null)

const isAuthenticated = computed(() => auth.isAuthenticated)
const walletBalance = computed(() => Number(auth.wallet?.balance ?? 0))

const winnerUsername = computed(() => {
  if (!tournament.value?.winnerId) return ''
  const entry = leaderboard.value.find((e) => e.userId === tournament.value!.winnerId)
  return entry?.username ?? ''
})

const isRegistered = computed(() =>
  leaderboard.value.some((e) => e.userId === auth.user?.id),
)

const isEliminated = computed(() =>
  leaderboard.value.find((e) => e.userId === auth.user?.id)?.eliminated ?? false,
)

const toast = ref({ show: false, message: '', type: 'info' })

function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  toast.value = { show: true, message, type }
  setTimeout(() => { toast.value.show = false }, 3500)
}

function statusLabel(status: string): string {
  switch (status) {
    case TournamentStatus.REGISTRATION: return '📋 Open'
    case TournamentStatus.IN_PROGRESS: return '🔴 Live'
    case TournamentStatus.COMPLETED: return '✅ Completed'
    case TournamentStatus.CANCELLED: return '❌ Cancelled'
    default: return status
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-ET', { dateStyle: 'medium', timeStyle: 'short' })
}

async function fetchTournament() {
  loading.value = true
  try {
    const [t, lb] = await Promise.all([
      $fetch<TournamentDto>(`${config.public.apiBase}/tournaments/${tournamentId}`),
      $fetch<TournamentLeaderboardEntry[]>(`${config.public.apiBase}/tournaments/${tournamentId}/leaderboard`),
    ])
    tournament.value = t
    leaderboard.value = lb
  } catch (e) {
    tournament.value = null
  } finally {
    loading.value = false
  }
}

async function registerForTournament() {
  if (!isAuthenticated.value) return
  registering.value = true
  try {
    await auth.apiFetch(`/tournaments/${tournamentId}/register`, { method: 'POST' })
    showToast('Successfully registered! 🎉', 'success')
    await fetchTournament()
    await auth.fetchWallet()
  } catch (err: any) {
    showToast(err?.data?.error ?? 'Registration failed', 'error')
  } finally {
    registering.value = false
  }
}

onMounted(() => {
  fetchTournaments()

  socket.value?.on('tournament:updated', (payload: any) => {
    if (payload.tournamentId !== tournamentId) return
    if (tournament.value) {
      tournament.value.status = payload.status
      tournament.value.currentPlayers = payload.currentPlayers
      tournament.value.prizePool = payload.prizePool
    }
  })

  socket.value?.on('tournament:round-started', (payload: any) => {
    if (payload.tournamentId !== tournamentId) return
    currentGameId.value = payload.gameId
    showToast(`Round ${payload.round} has started!`, 'info')
    fetchTournament()
  })

  socket.value?.on('tournament:eliminated', (payload: any) => {
    if (payload.tournamentId !== tournamentId) return
    fetchTournament()
    if (payload.userId === auth.user?.id) {
      showToast('You have been eliminated 😢', 'error')
    }
  })

  socket.value?.on('tournament:winner', (payload: any) => {
    if (payload.tournamentId !== tournamentId) return
    if (tournament.value) {
      tournament.value.status = TournamentStatus.COMPLETED
      tournament.value.winnerId = payload.winnerId
    }
    fetchTournament()
    if (payload.winnerId === auth.user?.id) {
      showToast(`🏆 You won the tournament! ${payload.prizeAmount.toLocaleString()} ETB!`, 'success')
    } else {
      showToast(`Tournament over! Winner: ${payload.username}`, 'info')
    }
  })
})

onUnmounted(() => {
  socket.value?.off('tournament:updated')
  socket.value?.off('tournament:round-started')
  socket.value?.off('tournament:eliminated')
  socket.value?.off('tournament:winner')
})

// Fix typo: fetchTournaments → fetchTournament in onMounted
function fetchTournaments() { fetchTournament() }

useHead({ title: computed(() => tournament.value ? `${tournament.value.title} — World Bingo` : 'Tournament') })
</script>

<style scoped>
.tournament-detail {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.back-link {
  color: #818cf8;
  text-decoration: none;
  font-size: 0.9rem;
  display: inline-block;
  margin-bottom: 1rem;
}

.detail-header { margin-bottom: 1.5rem; }
.header-info {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.header-left { display: flex; flex-direction: column; gap: 0.5rem; }
.tournament-title {
  font-size: 1.75rem;
  font-weight: 800;
  color: #fff;
  margin: 0;
}
.status-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.7rem;
  border-radius: 999px;
  width: fit-content;
}
.badge-registration { background: #1a5c38; color: #4ade80; }
.badge-in_progress  { background: #5c1a1a; color: #f87171; }
.badge-completed    { background: #2a2a2a; color: #9ca3af; }
.badge-cancelled    { background: #1f1f1f; color: #6b7280; }

.prize-display { text-align: right; }
.prize-label { font-size: 0.7rem; color: #6b7280; text-transform: uppercase; }
.prize-amount { font-size: 1.75rem; font-weight: 800; color: #f5c518; }

.stats-bar {
  display: flex;
  gap: 1rem;
  background: #111;
  border-radius: 10px;
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}
.stat-item { display: flex; flex-direction: column; gap: 0.2rem; }
.stat-label { font-size: 0.65rem; color: #6b7280; text-transform: uppercase; }
.stat-value { font-size: 0.95rem; font-weight: 700; color: #e5e7eb; }

.winner-banner {
  background: linear-gradient(135deg, #1a3a1a, #2a5a2a);
  border: 1px solid #4ade80;
  border-radius: 12px;
  padding: 1.5rem;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
}
.winner-icon { font-size: 2.5rem; }
.winner-label { font-size: 0.75rem; color: #86efac; text-transform: uppercase; }
.winner-name { font-size: 1.4rem; font-weight: 800; color: #fff; }
.winner-prize { font-size: 1.1rem; color: #f5c518; font-weight: 700; }

.register-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #1a1a2e;
  border: 1px solid #4f46e5;
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
  gap: 1rem;
}
.register-title { font-size: 1rem; font-weight: 700; color: #fff; }
.register-sub { font-size: 0.85rem; color: #9ca3af; margin-top: 0.25rem; }
.register-sub strong { color: #e5e7eb; }

.btn-register {
  background: linear-gradient(135deg, #f5c518, #e6a817);
  color: #000;
  font-weight: 700;
  padding: 0.7rem 1.5rem;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  font-size: 0.95rem;
  transition: opacity 0.2s;
  white-space: nowrap;
}
.btn-register:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-register:not(:disabled):hover { opacity: 0.9; }

.registered-badge {
  background: #1a3a1a;
  color: #4ade80;
  padding: 0.6rem 1rem;
  border-radius: 8px;
  font-size: 0.9rem;
  margin-bottom: 1.5rem;
  text-align: center;
}
.eliminated-box {
  background: #2a1a1a;
  color: #f87171;
  padding: 0.6rem 1rem;
  border-radius: 8px;
  font-size: 0.9rem;
  margin-bottom: 1.5rem;
  text-align: center;
}

.login-cta { text-align: center; margin-bottom: 1.5rem; }
.btn-primary {
  display: inline-block;
  background: linear-gradient(135deg, #f5c518, #e6a817);
  color: #000;
  font-weight: 700;
  padding: 0.65rem 1.5rem;
  border-radius: 8px;
  text-decoration: none;
}

.round-game-box {
  background: linear-gradient(135deg, #1a1a3e, #2a2a5e);
  border: 1px solid #818cf8;
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  margin-bottom: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.round-game-title { font-size: 1rem; font-weight: 700; color: #fff; }
.btn-play {
  background: #818cf8;
  color: #000;
  font-weight: 700;
  padding: 0.65rem 1.25rem;
  border-radius: 8px;
  text-decoration: none;
}

/* Leaderboard */
.section-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: #fff;
  margin-bottom: 1rem;
  border-bottom: 2px solid #2a2a2a;
  padding-bottom: 0.5rem;
}

.leaderboard-table { border-radius: 10px; overflow: hidden; }
.leaderboard-header, .leaderboard-row {
  display: grid;
  grid-template-columns: 60px 1fr 80px 100px;
  padding: 0.75rem 1rem;
  font-size: 0.9rem;
}
.leaderboard-header {
  background: #1a1a2e;
  color: #6b7280;
  font-size: 0.75rem;
  text-transform: uppercase;
  font-weight: 600;
}
.leaderboard-row { background: #111; border-bottom: 1px solid #1f1f1f; }
.leaderboard-row.row-eliminated { opacity: 0.4; }
.leaderboard-row.row-me { background: #1a1a3e; }

.rank { font-weight: 700; }
.username { font-weight: 600; color: #e5e7eb; }
.you-tag { font-size: 0.75rem; color: #818cf8; }
.score { font-weight: 700; color: #f5c518; }
.alive { color: #4ade80; font-size: 0.8rem; }
.elim { color: #f87171; font-size: 0.8rem; }

.empty-leaderboard { color: #6b7280; text-align: center; padding: 1.5rem; }

/* Toast */
.toast {
  position: fixed;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.85rem 1.5rem;
  border-radius: 10px;
  font-weight: 600;
  z-index: 1000;
  animation: slideUp 0.3s ease;
}
.toast-success { background: #1a5c38; color: #4ade80; }
.toast-error   { background: #5c1a1a; color: #f87171; }
.toast-info    { background: #1a1a3e; color: #818cf8; }

@keyframes slideUp {
  from { transform: translateX(-50%) translateY(20px); opacity: 0; }
  to   { transform: translateX(-50%) translateY(0); opacity: 1; }
}

/* Loading */
.loading { text-align: center; padding: 4rem; }
.spinner {
  width: 40px; height: 40px;
  border: 3px solid #2a2a4a;
  border-top-color: #f5c518;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto;
}
@keyframes spin { to { transform: rotate(360deg); } }

.error-state { text-align: center; padding: 3rem; color: #ccc; }
</style>
