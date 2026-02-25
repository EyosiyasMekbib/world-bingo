<template>
  <div class="tournaments-page">
    <div class="page-header">
      <h1 class="page-title">🏆 Tournaments</h1>
      <p class="page-subtitle">Compete in multi-round bingo tournaments to win the prize pool!</p>
    </div>

    <!-- Active / Upcoming Tournaments -->
    <section v-if="activeTournaments.length" class="section">
      <h2 class="section-title">Active &amp; Open Tournaments</h2>
      <div class="tournament-grid">
        <div
          v-for="t in activeTournaments"
          :key="t.id"
          class="tournament-card"
          :class="`status-${t.status.toLowerCase()}`"
        >
          <div class="card-top">
            <span class="status-badge" :class="`badge-${t.status.toLowerCase()}`">
              {{ statusLabel(t.status) }}
            </span>
            <span class="rounds-badge" v-if="t.rounds > 1">Round {{ t.rounds }}</span>
          </div>

          <h3 class="card-title">{{ t.title }}</h3>

          <div class="card-stats">
            <div class="stat">
              <span class="stat-label">Entry Fee</span>
              <span class="stat-value">{{ t.entryFee.toLocaleString() }} ETB</span>
            </div>
            <div class="stat">
              <span class="stat-label">Prize Pool</span>
              <span class="stat-value prize">{{ t.prizePool.toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} ETB</span>
            </div>
            <div class="stat">
              <span class="stat-label">Players</span>
              <span class="stat-value">{{ t.currentPlayers }} / {{ t.maxPlayers }}</span>
            </div>
          </div>

          <div class="card-footer">
            <NuxtLink :to="`/tournaments/${t.id}`" class="btn-primary">
              {{ t.status === 'REGISTRATION' ? 'View &amp; Register' : 'Watch Live' }}
            </NuxtLink>
          </div>
        </div>
      </div>
    </section>

    <!-- No tournaments -->
    <div v-if="!loading && !activeTournaments.length" class="empty-state">
      <div class="empty-icon">🏆</div>
      <h3>No Active Tournaments</h3>
      <p>Check back soon for upcoming tournaments!</p>
      <NuxtLink to="/" class="btn-secondary">Back to Lobby</NuxtLink>
    </div>

    <!-- Past Tournaments -->
    <section v-if="pastTournaments.length" class="section past-section">
      <h2 class="section-title">Past Tournaments</h2>
      <div class="past-list">
        <div v-for="t in pastTournaments" :key="t.id" class="past-item">
          <span class="past-title">{{ t.title }}</span>
          <span class="past-prize">Prize: {{ t.prizePool.toLocaleString('en-ET', { minimumFractionDigits: 2 }) }} ETB</span>
          <span class="past-players">{{ t.currentPlayers }} players</span>
          <NuxtLink :to="`/tournaments/${t.id}`" class="past-link">Details →</NuxtLink>
        </div>
      </div>
    </section>

    <!-- Loading -->
    <div v-if="loading" class="loading">
      <div class="spinner" />
      <p>Loading tournaments...</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TournamentDto } from '@world-bingo/shared-types'
import { TournamentStatus } from '@world-bingo/shared-types'
import { useSocket } from '~/composables/useSocket'

const config = useRuntimeConfig()
const { socket } = useSocket()
const { tournamentsEnabled } = useFeatureFlags()

// Redirect to home if tournaments feature is disabled
watch(tournamentsEnabled, (enabled) => {
  if (!enabled) navigateTo('/')
}, { immediate: true })

const loading = ref(true)
const tournaments = ref<TournamentDto[]>([])

const activeTournaments = computed(() =>
  tournaments.value.filter(
    (t) => t.status === TournamentStatus.REGISTRATION || t.status === TournamentStatus.IN_PROGRESS,
  ),
)
const pastTournaments = computed(() =>
  tournaments.value.filter(
    (t) => t.status === TournamentStatus.COMPLETED || t.status === TournamentStatus.CANCELLED,
  ),
)

function statusLabel(status: string): string {
  switch (status) {
    case TournamentStatus.REGISTRATION: return '📋 Open for Registration'
    case TournamentStatus.IN_PROGRESS: return '🔴 Live'
    case TournamentStatus.COMPLETED: return '✅ Completed'
    case TournamentStatus.CANCELLED: return '❌ Cancelled'
    default: return status
  }
}

async function fetchTournaments() {
  loading.value = true
  try {
    const data = await $fetch<TournamentDto[]>(`${config.public.apiBase}/tournaments`)
    tournaments.value = data
  } catch (e) {
    console.error('Failed to load tournaments', e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchTournaments()

  // Live updates when a tournament status changes
  socket.value?.on('tournament:updated', (payload: any) => {
    const idx = tournaments.value.findIndex((t) => t.id === payload.tournamentId)
    if (idx !== -1) {
      tournaments.value[idx] = {
        ...tournaments.value[idx],
        status: payload.status,
        currentPlayers: payload.currentPlayers,
        prizePool: payload.prizePool,
      }
    }
  })

  socket.value?.on('tournament:winner', (payload: any) => {
    const idx = tournaments.value.findIndex((t) => t.id === payload.tournamentId)
    if (idx !== -1) {
      tournaments.value[idx] = {
        ...tournaments.value[idx],
        status: TournamentStatus.COMPLETED,
        winnerId: payload.winnerId,
      }
    }
  })
})

onUnmounted(() => {
  socket.value?.off('tournament:updated')
  socket.value?.off('tournament:winner')
})

useHead({ title: 'Tournaments — World Bingo' })
</script>

<style scoped>
.tournaments-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.page-header {
  text-align: center;
  margin-bottom: 2.5rem;
}
.page-title {
  font-size: 2rem;
  font-weight: 800;
  color: #f5c518;
  margin: 0 0 0.5rem;
}
.page-subtitle {
  color: #ccc;
  font-size: 1rem;
}

.section { margin-bottom: 3rem; }
.section-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: #fff;
  margin-bottom: 1.25rem;
  border-bottom: 2px solid #2a2a2a;
  padding-bottom: 0.5rem;
}

.tournament-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1.25rem;
}

.tournament-card {
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  transition: transform 0.2s, box-shadow 0.2s;
}
.tournament-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.card-top {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.status-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
}
.badge-registration { background: #1a5c38; color: #4ade80; }
.badge-in_progress  { background: #5c1a1a; color: #f87171; }
.badge-completed    { background: #2a2a2a; color: #9ca3af; }
.badge-cancelled    { background: #1f1f1f; color: #6b7280; }

.rounds-badge {
  font-size: 0.7rem;
  background: #2a2a4a;
  color: #818cf8;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  margin-left: auto;
}

.card-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: #fff;
  margin: 0;
}

.card-stats {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.5rem;
}
.stat {
  background: #0f0f1a;
  border-radius: 8px;
  padding: 0.5rem;
  text-align: center;
}
.stat-label {
  display: block;
  font-size: 0.65rem;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.stat-value {
  display: block;
  font-size: 0.85rem;
  font-weight: 700;
  color: #e5e7eb;
  margin-top: 0.2rem;
}
.stat-value.prize { color: #f5c518; }

.card-footer { margin-top: 0.25rem; }

.btn-primary {
  display: block;
  text-align: center;
  background: linear-gradient(135deg, #f5c518, #e6a817);
  color: #000;
  font-weight: 700;
  padding: 0.65rem 1rem;
  border-radius: 8px;
  text-decoration: none;
  transition: opacity 0.2s;
}
.btn-primary:hover { opacity: 0.9; }

.btn-secondary {
  display: inline-block;
  background: #2a2a4a;
  color: #818cf8;
  padding: 0.6rem 1.5rem;
  border-radius: 8px;
  text-decoration: none;
  font-weight: 600;
  margin-top: 1rem;
}

/* Empty State */
.empty-state {
  text-align: center;
  padding: 4rem 1rem;
  color: #ccc;
}
.empty-icon { font-size: 4rem; margin-bottom: 1rem; }
.empty-state h3 { font-size: 1.5rem; color: #fff; margin-bottom: 0.5rem; }

/* Past */
.past-section { opacity: 0.7; }
.past-list { display: flex; flex-direction: column; gap: 0.5rem; }
.past-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: #111;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  font-size: 0.9rem;
  flex-wrap: wrap;
}
.past-title { font-weight: 600; color: #e5e7eb; flex: 1; min-width: 150px; }
.past-prize { color: #f5c518; }
.past-players { color: #6b7280; }
.past-link { color: #818cf8; text-decoration: none; margin-left: auto; }

/* Loading */
.loading {
  text-align: center;
  padding: 3rem;
  color: #9ca3af;
}
.spinner {
  width: 40px; height: 40px;
  border: 3px solid #2a2a4a;
  border-top-color: #f5c518;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 1rem;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
