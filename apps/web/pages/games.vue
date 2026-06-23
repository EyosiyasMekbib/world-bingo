<script setup lang="ts">
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import { useProviderGamesStore } from '~/store/provider-games'
import type { ProviderGame } from '~/store/provider-games'
import type { Game } from '@world-bingo/shared-types'

const auth = useAuthStore()
const gameStore = useGameStore()
const providerStore = useProviderGamesStore()
const { connect } = useSocket()
const config = useRuntimeConfig()
const { patternLabel } = usePatternLabel()
const { track } = useAnalytics()

// ── Hero carousel ─────────────────────────────────────────────────────────
const slides = [
  {
    kicker: 'Welcome Offer',
    title: '100% Welcome Bonus up to 5,000 ETB',
    sub: 'Sign up today and double your first deposit. More cards, more chances to shout BINGO!',
    cta: 'Claim Bonus',
    ghost: 'WIN',
    to: '/auth/register',
    bg: 'linear-gradient(120deg,#0a1628 0%,#14305c 55%,#1d4a8a 100%)',
  },
  {
    kicker: 'Live Now',
    title: 'Play Arada Bingo Rooms',
    sub: 'New rooms open every hour with growing jackpots. Join thousands of players online right now.',
    cta: 'Play Bingo',
    ghost: 'BINGO',
    to: '/games',
    bg: 'linear-gradient(120deg,#1a1206 0%,#3a2a08 50%,#6b4d0c 100%)',
  },
  {
    kicker: 'High Flyer',
    title: 'Win Big on Arada Tournaments',
    sub: 'Climb the leaderboard and grab a share of weekly prize pools across every game.',
    cta: 'View Tournaments',
    ghost: 'X10',
    to: '/tournaments',
    bg: 'linear-gradient(120deg,#0a1628 0%,#0f2e2a 55%,#136b5a 100%)',
  },
]
const current = ref(0)
let heroTimer: ReturnType<typeof setInterval> | null = null
const trackTransform = computed(() => `translateX(-${current.value * 100}%)`)
function goSlide(i: number) { current.value = (i + slides.length) % slides.length }
function nextSlide() { goSlide(current.value + 1) }
function prevSlide() { goSlide(current.value - 1) }

// ── Winners ───────────────────────────────────────────────────────────────
type WinnerPeriod = 'daily' | 'weekly' | 'monthly'
const winnerPeriod = ref<WinnerPeriod>('weekly')

interface Winner {
  username: string
  amount: number
  createdAt: string
  gameId: string | null
}

const winners = ref<Winner[]>([])
const winnersLoading = ref(false)

const WINNER_BG = [
  'linear-gradient(150deg,#1d4a8a,#0a1628)',
  'linear-gradient(150deg,#a8521a,#3c1a08)',
  'linear-gradient(150deg,#1a7a4a,#062c1a)',
  'linear-gradient(150deg,#7a2a8a,#2a0a3c)',
  'linear-gradient(150deg,#0e6b7a,#04222c)',
]

async function fetchWinners(period: WinnerPeriod) {
  winnerPeriod.value = period
  winnersLoading.value = true
  try {
    winners.value = await $fetch<Winner[]>(
      `${config.public.apiBase}/games/recent-winners?period=${period}`,
    )
  } catch {
    winners.value = []
  } finally {
    winnersLoading.value = false
  }
}

function winnerGlyph(name: string) { return (name?.[0] ?? '?').toUpperCase() }
function winnerDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} | ${p(d.getHours())}:${p(d.getMinutes())}`
}
function winnerAmount(n: number) {
  return n.toLocaleString('en-ET', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

const winnerTabs: { key: WinnerPeriod; label: string }[] = [
  { key: 'daily', label: 'Daily Top Winners' },
  { key: 'weekly', label: 'Weekly Winners' },
  { key: 'monthly', label: 'Monthly Winners' },
]

// ── Categories / providers ──────────────────────────────────────────────────
const BINGO_CAT = 'BINGO'
const activeCategory = ref('ALL')
const favView = ref(false)

const allCategories = computed(() => {
  const providerCats = providerStore.categories.filter((c) => c !== BINGO_CAT && c !== 'ALL')
  return ['ALL', BINGO_CAT, ...providerCats]
})

function catLabel(cat: string) {
  if (cat === 'ALL') return 'All Games'
  return cat.charAt(0) + cat.slice(1).toLowerCase().replace(/_/g, ' ')
}

function selectCategory(cat: string) {
  favView.value = false
  activeCategory.value = cat
  if (cat !== BINGO_CAT) {
    providerStore.fetchGames({ reset: true, category: cat === 'ALL' ? undefined : cat })
  }
}

const activeProvider = ref('')
const providersExpanded = ref(false)

function selectProvider(code: string) {
  activeProvider.value = code
  providerStore.activeProviderCode = code
  providerStore.fetchCategories(code)
  providerStore.fetchGames({ reset: true })
}

// ── Favorites (local) ────────────────────────────────────────────────────────
const favorites = ref<string[]>([])
const FAV_KEY = 'ab_favorites'

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    if (raw) favorites.value = JSON.parse(raw)
  } catch { /* ignore */ }
}
function toggleFav(key: string) {
  const i = favorites.value.indexOf(key)
  if (i >= 0) favorites.value.splice(i, 1)
  else favorites.value.push(key)
  try { localStorage.setItem(FAV_KEY, JSON.stringify(favorites.value)) } catch { /* ignore */ }
}
function isFav(key: string) { return favorites.value.includes(key) }

// ── Unified game cards ───────────────────────────────────────────────────────
interface Card {
  key: string
  kind: 'bingo' | 'provider'
  name: string
  tag: string
  glyph: string
  thumb: string
  image: string | null
  statusLabel?: string
  statusColor?: string
  players?: number
  raw: any
}

const BINGO_THUMB = 'linear-gradient(150deg,#1d4a8a,#0a1628)'
const PROVIDER_THUMBS = [
  'linear-gradient(150deg,#7a2a8a,#2a0a3c)',
  'linear-gradient(150deg,#0e6b7a,#04222c)',
  'linear-gradient(150deg,#a8521a,#3c1a08)',
  'linear-gradient(150deg,#1a7a4a,#062c1a)',
]

function bingoStatusLabel(status: string) {
  if (status === 'IN_PROGRESS') return 'Live'
  if (status === 'STARTING') return 'Starting'
  if (status === 'LOCKING') return 'Full'
  if (status === 'WAITING') return 'Open'
  return status
}
function bingoStatusColor(status: string) {
  if (status === 'IN_PROGRESS') return 'var(--status-success)'
  if (status === 'STARTING') return 'var(--brand-primary)'
  if (status === 'LOCKING') return 'var(--status-error)'
  return 'rgba(255,255,255,0.4)'
}

function hasImage(g: ProviderGame) { return !!(g.imageSquare || g.imageLandscape) }

const bingoCards = computed<Card[]>(() => {
  if (activeCategory.value !== BINGO_CAT && activeCategory.value !== 'ALL') return []
  return gameStore.availableGames.map((g) => ({
    key: `bingo:${g.id}`,
    kind: 'bingo',
    name: g.title,
    tag: 'Bingo',
    glyph: 'B',
    thumb: BINGO_THUMB,
    image: null,
    statusLabel: bingoStatusLabel(g.status),
    statusColor: bingoStatusColor(g.status),
    players: gameStore.livePlayers[g.id] ?? (g as any).currentPlayers ?? 0,
    raw: g,
  }))
})

const providerCards = computed<Card[]>(() => {
  if (activeCategory.value === BINGO_CAT) return []
  return providerStore.games.filter(hasImage).map((g, i) => ({
    key: `provider:${g.gameCode}`,
    kind: 'provider',
    name: g.gameName,
    tag: g.vendorCode || 'Casino',
    glyph: (g.gameName?.[0] ?? 'G').toUpperCase(),
    thumb: PROVIDER_THUMBS[i % PROVIDER_THUMBS.length],
    image: g.imageSquare || g.imageLandscape,
    raw: g,
  }))
})

const allCards = computed<Card[]>(() => [...bingoCards.value, ...providerCards.value])

const displayCards = computed<Card[]>(() => {
  if (favView.value) return allCards.value.filter((c) => isFav(c.key))
  return allCards.value
})

const headingLabel = computed(() =>
  favView.value ? 'Favorites' : catLabel(activeCategory.value),
)

// ── Launch / join ─────────────────────────────────────────────────────────
const showAuthPrompt = ref(false)
const launching = ref<string | null>(null)

function playCard(card: Card) {
  if (card.kind === 'bingo') return joinBingo(card.raw.id)
  return launchGame(card.raw as ProviderGame)
}

async function launchGame(game: ProviderGame) {
  if (!auth.isAuthenticated) { showAuthPrompt.value = true; return }
  launching.value = `provider:${game.gameCode}`
  try {
    const url = await providerStore.launchGame(providerStore.activeProviderCode, game.gameCode)
    if (url) window.location.href = url
  } finally {
    launching.value = null
  }
}
function joinBingo(gameId: string) {
  if (!auth.isAuthenticated) { showAuthPrompt.value = true; return }
  navigateTo(`/quick/${gameId}`)
}

// ── Infinite scroll ──────────────────────────────────────────────────────────
const feedSentinel = ref<HTMLElement | null>(null)
let feedObserver: IntersectionObserver | null = null
function setupFeedObserver() {
  if (!feedSentinel.value) return
  feedObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && providerStore.hasMore && !providerStore.loading) {
        providerStore.loadMore()
      }
    },
    { rootMargin: '600px' },
  )
  feedObserver.observe(feedSentinel.value)
}

function onImgLoad(e: Event) { (e.currentTarget as HTMLImageElement).classList.add('loaded') }

// ── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(async () => {
  track('games_lobby_view')
  loadFavorites()

  heroTimer = setInterval(nextSlide, 5500)

  await gameStore.fetchAvailableGames()
  await providerStore.fetchProviders()
  if (providerStore.providers.length > 0) {
    activeProvider.value = providerStore.activeProviderCode
    await providerStore.fetchCategories()
    await providerStore.fetchGames({ reset: true })
  }
  await fetchWinners('weekly')

  await nextTick()
  setupFeedObserver()

  const socket = connect()
  if (!socket) return
  socket.emit('lobby:subscribe')
  socket.on('lobby:game-added', (game: Game) => gameStore.onLobbyGameAdded(game))
  socket.on('lobby:game-removed', (id: string) => gameStore.onLobbyGameRemoved(id))
  socket.on('game:updated', (game: Game) => gameStore.onGameUpdated(game))
  ;(socket as any).on('player_count_update', (p: { gameId: string; playerCount: number }) =>
    gameStore.onPlayerCountUpdate(p.gameId, p.playerCount),
  )
})

onUnmounted(() => {
  feedObserver?.disconnect()
  if (heroTimer) clearInterval(heroTimer)
  connect()?.emit('lobby:unsubscribe')
})
</script>

<template>
  <div class="lobby">
    <!-- ═══════════ HERO CAROUSEL ═══════════ -->
    <section class="wrap hero-sect">
      <div class="hero-frame">
        <div class="hero-track" :style="{ transform: trackTransform }">
          <div v-for="(s, i) in slides" :key="i" class="hero-slide" :style="{ background: s.bg }">
            <div class="hero-orb" />
            <div class="hero-ghost">{{ s.ghost }}</div>
            <div class="hero-body">
              <span class="hero-kicker">{{ s.kicker }}</span>
              <h1 class="hero-title">{{ s.title }}</h1>
              <p class="hero-sub">{{ s.sub }}</p>
              <NuxtLink :to="s.to" class="hero-cta">{{ s.cta }}</NuxtLink>
            </div>
          </div>
        </div>
        <button class="hero-arrow hero-prev" aria-label="Previous" @click="prevSlide">‹</button>
        <button class="hero-arrow hero-next" aria-label="Next" @click="nextSlide">›</button>
        <div class="hero-dots">
          <button
            v-for="(s, i) in slides"
            :key="i"
            class="hero-dot"
            :class="{ on: i === current }"
            :aria-label="`Slide ${i + 1}`"
            @click="goSlide(i)"
          />
        </div>
      </div>
    </section>

    <!-- ═══════════ WINNERS ═══════════ -->
    <section class="wrap winners-sect">
      <div class="winners-tabs">
        <button
          v-for="t in winnerTabs"
          :key="t.key"
          class="winners-tab"
          :class="{ on: winnerPeriod === t.key }"
          @click="fetchWinners(t.key)"
        >
          {{ t.label }}
        </button>
      </div>
      <div class="winners-row noscroll">
        <div v-if="winnersLoading" class="winners-empty">Loading winners…</div>
        <div v-else-if="!winners.length" class="winners-empty">No winners yet for this period.</div>
        <div v-for="(w, i) in winners" :key="i" class="winner-card">
          <div class="winner-glyph" :style="{ background: WINNER_BG[i % WINNER_BG.length] }">
            {{ winnerGlyph(w.username) }}
          </div>
          <div class="winner-info">
            <div class="winner-amt">{{ winnerAmount(w.amount) }} <span>ETB</span></div>
            <div class="winner-name">{{ w.username }}</div>
            <div class="winner-date">{{ winnerDate(w.createdAt) }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ═══════════ CATEGORY FILTERS ═══════════ -->
    <section class="wrap filter-sect">
      <div class="filter-row noscroll">
        <button
          v-for="cat in allCategories"
          :key="cat"
          class="cat-pill"
          :class="{ on: !favView && activeCategory === cat }"
          @click="selectCategory(cat)"
        >
          {{ catLabel(cat) }}
        </button>
      </div>
      <button class="fav-btn" :class="{ on: favView }" @click="favView = !favView">
        <svg viewBox="0 0 24 24" :fill="favView ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z" /></svg>
        Favorites
      </button>
    </section>

    <!-- ═══════════ PROVIDERS ═══════════ -->
    <section v-if="!favView && activeCategory !== BINGO_CAT && providerStore.providers.length > 1" class="wrap provider-sect">
      <div class="provider-row noscroll" :class="{ expanded: providersExpanded }">
        <button
          v-for="p in providerStore.providers"
          :key="p.code"
          class="provider-pill"
          :class="{ on: activeProvider === p.code }"
          @click="selectProvider(p.code)"
        >
          {{ p.name }}
        </button>
      </div>
      <button class="provider-toggle" @click="providersExpanded = !providersExpanded">
        Providers <span class="caret" :class="{ up: providersExpanded }">▾</span>
      </button>
    </section>

    <!-- ═══════════ GAME GRID ═══════════ -->
    <section class="wrap grid-sect">
      <div class="grid-head">
        <h2>{{ headingLabel }}</h2>
        <span class="grid-count">{{ displayCards.length }} games</span>
      </div>

      <div v-if="providerStore.loading && !displayCards.length" class="game-grid">
        <div v-for="i in 8" :key="i" class="skeleton" />
      </div>

      <div v-else-if="!displayCards.length" class="grid-empty">
        {{ favView ? 'No favorites yet — tap the star on a game to save it.' : 'No games match your selection.' }}
      </div>

      <div v-else class="game-grid">
        <div
          v-for="card in displayCards"
          :key="card.key"
          class="game-card"
          :class="{ launching: launching === card.key }"
        >
          <div class="game-thumb" :style="{ background: card.thumb }" @click="playCard(card)">
            <div class="thumb-sheen" />
            <img
              v-if="card.image"
              :src="card.image"
              :alt="card.name"
              class="game-img"
              loading="lazy"
              @load="onImgLoad"
            />
            <span v-else class="thumb-glyph">{{ card.glyph }}</span>

            <span class="game-tag">{{ card.tag }}</span>
            <span
              v-if="card.statusLabel"
              class="game-status"
              :style="{ background: card.statusColor }"
            >
              {{ card.statusLabel }}
            </span>
            <span v-if="card.players != null" class="game-players">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>
              {{ card.players }}
            </span>

            <div class="play-overlay">
              <span v-if="launching === card.key" class="play-spin">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              </span>
              <span v-else class="play-btn">Play</span>
            </div>
          </div>
          <div class="game-meta">
            <span class="game-name">{{ card.name }}</span>
            <button
              class="game-fav"
              :class="{ on: isFav(card.key) }"
              :aria-label="isFav(card.key) ? 'Remove favorite' : 'Add favorite'"
              @click.stop="toggleFav(card.key)"
            >
              <svg viewBox="0 0 24 24" :fill="isFav(card.key) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z" /></svg>
            </button>
          </div>
        </div>
      </div>

      <div ref="feedSentinel" class="feed-sentinel" />
      <div v-if="providerStore.loading && displayCards.length" class="load-more">
        <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
      </div>
    </section>

    <AuthPromptModal v-model="showAuthPrompt" />
  </div>
</template>

<style scoped>
.lobby { background: var(--surface-base); color: var(--text-primary); }
.wrap { max-width: 1480px; margin: 0 auto; padding-left: 28px; padding-right: 28px; }
.noscroll::-webkit-scrollbar { display: none; }
.noscroll { -ms-overflow-style: none; scrollbar-width: none; }

/* ── Hero ── */
.hero-sect { padding-top: 20px; padding-bottom: 4px; }
.hero-frame {
  position: relative;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.4);
}
.hero-track {
  display: flex;
  transition: transform 0.55s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.hero-slide {
  flex: 0 0 100%;
  height: 300px;
  position: relative;
  display: flex;
  align-items: center;
  overflow: hidden;
}
.hero-orb {
  position: absolute;
  right: -60px;
  top: -60px;
  width: 380px;
  height: 380px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--brand-primary) 26%, transparent), transparent 70%);
}
.hero-ghost {
  position: absolute;
  right: 50px;
  bottom: 30px;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 150px;
  color: rgba(255, 255, 255, 0.05);
  line-height: 0.8;
  pointer-events: none;
}
.hero-body { position: relative; padding: 0 56px; max-width: 600px; }
.hero-kicker {
  display: inline-block;
  background: color-mix(in srgb, var(--brand-primary) 18%, transparent);
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 2px;
  text-transform: uppercase;
  padding: 5px 12px;
  border-radius: 18px;
  margin-bottom: 14px;
}
.hero-title {
  font-family: var(--font-heading);
  font-weight: 700;
  font-size: 46px;
  line-height: 1.02;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 12px;
  text-wrap: balance;
}
.hero-sub {
  font-size: 16px;
  color: rgba(255, 255, 255, 0.78);
  margin-bottom: 22px;
  max-width: 440px;
  line-height: 1.5;
}
.hero-cta {
  display: inline-block;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 17px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 13px 30px;
  border-radius: 9px;
  text-decoration: none;
  box-shadow: 0 8px 22px color-mix(in srgb, var(--brand-primary) 40%, transparent);
  transition: transform 0.12s;
}
.hero-cta:hover { transform: translateY(-1px); }
.hero-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(10, 22, 40, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.hero-arrow:hover { background: rgba(10, 22, 40, 0.8); }
.hero-prev { left: 14px; }
.hero-next { right: 14px; }
.hero-dots {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 7px;
}
.hero-dot {
  width: 7px;
  height: 7px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.4);
  border: none;
  cursor: pointer;
  transition: width 0.3s, background 0.3s;
}
.hero-dot.on { width: 24px; background: var(--brand-primary); }

/* ── Winners ── */
.winners-sect { padding-top: 22px; padding-bottom: 6px; }
.winners-tabs {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.winners-tab {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 1px;
  text-transform: uppercase;
  padding: 8px 14px;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.winners-tab.on { color: var(--brand-primary); border-bottom-color: var(--brand-primary); }
.winners-row { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 6px; }
.winners-empty { color: rgba(255, 255, 255, 0.45); font-size: 14px; padding: 14px 2px; }
.winner-card {
  flex: none;
  width: 280px;
  display: flex;
  align-items: center;
  gap: 14px;
  background: var(--surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  padding: 12px;
}
.winner-glyph {
  width: 64px;
  height: 64px;
  flex: none;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 26px;
  color: rgba(255, 255, 255, 0.85);
}
.winner-info { min-width: 0; line-height: 1.35; }
.winner-amt { font-family: var(--font-ui); font-weight: 700; font-size: 21px; }
.winner-amt span { font-size: 12px; color: var(--brand-primary); }
.winner-name { font-size: 13px; color: rgba(255, 255, 255, 0.65); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.winner-date { font-size: 12px; color: rgba(255, 255, 255, 0.4); margin-top: 2px; }

/* ── Filters ── */
.filter-sect {
  display: flex;
  gap: 10px;
  align-items: center;
  padding-top: 14px;
  padding-bottom: 4px;
  position: sticky;
  top: 114px;
  z-index: 20;
  background: color-mix(in srgb, var(--surface-base) 92%, transparent);
  backdrop-filter: blur(10px);
}
.filter-row { display: flex; gap: 8px; overflow-x: auto; flex: 1; padding-bottom: 4px; }
.cat-pill {
  flex: none;
  background: var(--surface-raised);
  color: rgba(255, 255, 255, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 9px 20px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.cat-pill:hover { color: var(--text-primary); border-color: rgba(255, 255, 255, 0.25); }
.cat-pill.on {
  background: var(--brand-primary);
  color: var(--text-on-brand);
  border-color: var(--brand-primary);
}
.fav-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  background: var(--surface-raised);
  color: var(--brand-primary);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 50%, transparent);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 9px 18px;
  border-radius: 8px;
  cursor: pointer;
}
.fav-btn svg { width: 16px; height: 16px; }
.fav-btn.on { background: var(--brand-primary); color: var(--text-on-brand); border-color: var(--brand-primary); }

/* ── Providers ── */
.provider-sect { display: flex; gap: 10px; align-items: center; padding-top: 8px; padding-bottom: 4px; }
.provider-row { display: flex; gap: 8px; overflow-x: auto; flex: 1; padding-bottom: 4px; }
.provider-row.expanded { flex-wrap: wrap; overflow: visible; }
.provider-pill {
  flex: none;
  background: var(--surface-raised);
  color: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  padding: 7px 16px;
  border-radius: 18px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.provider-pill:hover { color: var(--text-primary); }
.provider-pill.on {
  background: color-mix(in srgb, var(--brand-primary) 15%, transparent);
  color: var(--brand-primary);
  border-color: var(--brand-primary);
}
.provider-toggle {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-raised);
  color: var(--text-primary);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  padding: 7px 16px;
  border-radius: 8px;
  cursor: pointer;
}
.provider-toggle .caret { transition: transform 0.15s; }
.provider-toggle .caret.up { transform: rotate(180deg); }

/* ── Grid ── */
.grid-sect { padding-top: 16px; padding-bottom: 48px; }
.grid-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.grid-head h2 {
  font-family: var(--font-heading);
  font-weight: 600;
  font-size: 24px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.grid-count { font-size: 13px; color: rgba(255, 255, 255, 0.5); }

.game-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }

.game-card {
  background: var(--surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  overflow: hidden;
  transition: transform 0.15s, border-color 0.15s;
}
.game-card:hover {
  border-color: color-mix(in srgb, var(--brand-primary) 40%, transparent);
  transform: translateY(-3px);
}
.game-card.launching { pointer-events: none; opacity: 0.75; }

.game-thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
}
.thumb-sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(155deg, rgba(255, 255, 255, 0.14), transparent 48%);
}
.game-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.25s;
}
.game-img.loaded { opacity: 1; }
.thumb-glyph {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 54px;
  color: rgba(255, 255, 255, 0.22);
  line-height: 1;
}
.game-tag {
  position: absolute;
  top: 8px;
  left: 8px;
  background: rgba(10, 22, 40, 0.7);
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 6px;
}
.game-status {
  position: absolute;
  top: 8px;
  right: 8px;
  color: #fff;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 6px;
}
.game-players {
  position: absolute;
  bottom: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  background: rgba(10, 22, 40, 0.6);
  padding: 2px 7px;
  border-radius: 6px;
}
.game-players svg { width: 12px; height: 12px; }
.play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 22, 40, 0.55);
  opacity: 0;
  transition: opacity 0.15s;
}
.game-thumb:hover .play-overlay,
.game-card.launching .play-overlay { opacity: 1; }
.play-btn {
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 9px 22px;
  border-radius: 8px;
}
.play-spin svg { width: 28px; height: 28px; color: var(--brand-primary); animation: spin 0.8s linear infinite; }

.game-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px;
}
.game-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.game-fav {
  flex: none;
  background: transparent;
  border: none;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.45);
  line-height: 0;
  padding: 2px;
  transition: color 0.12s;
}
.game-fav:hover { color: rgba(255, 255, 255, 0.8); }
.game-fav.on { color: var(--brand-primary); }
.game-fav svg { width: 18px; height: 18px; }

/* ── Skeleton / empty / load-more ── */
.skeleton {
  aspect-ratio: 16 / 10;
  border-radius: 12px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.08) 50%, rgba(255, 255, 255, 0.04));
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.grid-empty { padding: 60px 0; text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 15px; }
.feed-sentinel { height: 1px; }
.load-more { display: flex; justify-content: center; padding: 20px; color: var(--brand-primary); }
.load-more svg { width: 24px; height: 24px; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Responsive (design swaps at 860px) ── */
@media (max-width: 860px) {
  .wrap { padding-left: 14px; padding-right: 14px; }
  .game-grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .hero-slide { height: 200px; }
  .hero-body { padding: 0 22px; }
  .hero-title { font-size: 30px; }
  .hero-sub { font-size: 14px; -webkit-line-clamp: 3; }
  .hero-ghost { font-size: 96px; right: 16px; }
  .filter-sect { position: static; backdrop-filter: none; }
  .fav-btn { padding: 9px 12px; font-size: 0; gap: 0; }
  .fav-btn svg { width: 18px; height: 18px; }
  .thumb-glyph { font-size: 42px; }
}
@media (max-width: 520px) {
  .winner-card { width: 240px; }
}
</style>
