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
const { track } = useAnalytics()

// ── Hero carousel (slim promo banner) ───────────────────────────────────────
const slides = [
  {
    kicker: 'Welcome Offer',
    title: '100% Welcome Bonus up to 5,000 ETB',
    sub: 'Sign up today and double your first deposit.',
    cta: 'Claim Bonus',
    ghost: 'WIN',
    to: '/auth/register',
    bg: 'linear-gradient(120deg,#0a1628 0%,#14305c 55%,#1d4a8a 100%)',
  },
  {
    kicker: 'Live Now',
    title: 'Play Arada Bingo Rooms',
    sub: 'New rooms open every hour with growing jackpots.',
    cta: 'Play Bingo',
    ghost: 'BINGO',
    to: '/games',
    bg: 'linear-gradient(120deg,#1a1206 0%,#3a2a08 50%,#6b4d0c 100%)',
  },
  {
    kicker: 'High Flyer',
    title: 'Win Big on Arada Tournaments',
    sub: 'Climb the leaderboard for weekly prize pools.',
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

// ── Categories / providers ──────────────────────────────────────────────────
const BINGO_CAT = 'BINGO'
const activeCategory = ref('ALL')
const favView = ref(false)
const gridSearch = ref('')

const ORDER = ['SLOTS', 'MINI', 'INSTWIN', 'POKER', 'LIVE', 'LIVEGRAND', 'ARCADE', 'BINGO']

const allCategories = computed(() => {
  const raw = [BINGO_CAT, ...providerStore.categories.filter((c) => c !== BINGO_CAT && c !== 'ALL')]
  const sorted = [
    ...ORDER.filter((o) => raw.some((c) => c.toUpperCase() === o)),
    ...raw.filter((c) => !ORDER.includes(c.toUpperCase())),
  ].map((o) => raw.find((c) => c.toUpperCase() === o) ?? o)
  return ['ALL', ...sorted]
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
  try { const raw = localStorage.getItem(FAV_KEY); if (raw) favorites.value = JSON.parse(raw) } catch { /* ignore */ }
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
  glyph: string
  thumb: string
  image: string | null
  statusLabel?: string
  statusColor?: string
  players?: number
  raw: any
}

const BINGO_THUMBS = [
  'linear-gradient(150deg,#1d4a8a,#0a1628)',
  'linear-gradient(150deg,#143a6e,#0a1628)',
  'linear-gradient(150deg,#0e2f5e,#0a1628)',
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
  return gameStore.availableGames.map((g, i) => ({
    key: `bingo:${g.id}`,
    kind: 'bingo',
    name: g.title,
    glyph: 'BINGO',
    thumb: BINGO_THUMBS[i % BINGO_THUMBS.length],
    image: null,
    statusLabel: bingoStatusLabel(g.status),
    statusColor: bingoStatusColor(g.status),
    players: gameStore.livePlayers[g.id] ?? (g as any).currentPlayers ?? 0,
    raw: g,
  }))
})

const providerCards = computed<Card[]>(() => {
  if (activeCategory.value === BINGO_CAT) return []
  return providerStore.games.filter(hasImage).map((g) => ({
    key: `provider:${g.gameCode}`,
    kind: 'provider',
    name: g.gameName,
    glyph: (g.gameName?.[0] ?? 'G').toUpperCase(),
    thumb: 'linear-gradient(150deg,#16233f,#0a1628)',
    image: g.imageSquare || g.imageLandscape,
    raw: g,
  }))
})

const allCards = computed<Card[]>(() => [...providerCards.value, ...bingoCards.value])

const displayCards = computed<Card[]>(() => {
  let list = favView.value ? allCards.value.filter((c) => isFav(c.key)) : allCards.value
  const q = gridSearch.value.trim().toLowerCase()
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q))
  return list
})

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
    { rootMargin: '800px' },
  )
  feedObserver.observe(feedSentinel.value)
}
function onImgLoad(e: Event) { (e.currentTarget as HTMLImageElement).classList.add('loaded') }
function onImgError(e: Event) {
  const tile = (e.currentTarget as HTMLElement).closest('.tile') as HTMLElement | null
  if (tile) tile.classList.add('no-img')
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
onMounted(async () => {
  track('games_lobby_view')
  loadFavorites()
  heroTimer = setInterval(nextSlide, 6000)

  await gameStore.fetchAvailableGames()
  await providerStore.fetchProviders()
  if (providerStore.providers.length > 0) {
    activeProvider.value = providerStore.activeProviderCode
    await providerStore.fetchCategories()
    await providerStore.fetchGames({ reset: true })
  }

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
    <!-- ═══════════ HERO (slim) ═══════════ -->
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

    <!-- ═══════════ FILTER BAR ═══════════ -->
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
        <button class="cat-pill fav-pill" :class="{ on: favView }" @click="favView = !favView">
          <svg viewBox="0 0 24 24" :fill="favView ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z" /></svg>
          Favorites
        </button>
      </div>
      <div class="grid-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7" stroke-linecap="round" stroke-linejoin="round" /><path d="m20 20-3.2-3.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <input v-model="gridSearch" placeholder="Search games…" />
      </div>
    </section>

    <!-- providers -->
    <section
      v-if="!favView && activeCategory !== BINGO_CAT && providerStore.providers.length > 1"
      class="wrap provider-sect"
    >
      <div class="provider-row noscroll">
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
    </section>

    <!-- ═══════════ GAME GRID ═══════════ -->
    <section class="wrap grid-sect">
      <div v-if="providerStore.loading && !displayCards.length" class="game-grid">
        <div v-for="i in 24" :key="i" class="skeleton" />
      </div>

      <div v-else-if="!displayCards.length" class="grid-empty">
        {{ favView ? 'No favorites yet — tap the star on a game to save it.' : 'No games match your selection.' }}
      </div>

      <div v-else class="game-grid">
        <div
          v-for="card in displayCards"
          :key="card.key"
          class="game-item"
        >
          <div
            class="tile"
            :class="{ launching: launching === card.key, bingo: card.kind === 'bingo' }"
            :style="{ background: card.thumb }"
            @click="playCard(card)"
          >
            <img
              v-if="card.image"
              :src="card.image"
              :alt="card.name"
              class="tile-img"
              loading="lazy"
              @load="onImgLoad"
              @error="onImgError"
            />
            <div v-else class="tile-bingo">
              <div class="bingo-balls">
                <span style="background:var(--ball-b)">B</span>
                <span style="background:var(--ball-i)">I</span>
                <span style="background:var(--ball-n)">N</span>
                <span style="background:var(--ball-g)">G</span>
                <span style="background:var(--ball-o)">O</span>
              </div>
            </div>

            <span
              v-if="card.statusLabel"
              class="tile-status"
              :style="{ background: card.statusColor }"
            >{{ card.statusLabel }}</span>
            <span v-if="card.players != null && card.players > 0" class="tile-players">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" /></svg>
              {{ card.players }}
            </span>

            <button
              class="tile-fav"
              :class="{ on: isFav(card.key) }"
              :aria-label="isFav(card.key) ? 'Remove favorite' : 'Add favorite'"
              @click.stop="toggleFav(card.key)"
            >
              <svg viewBox="0 0 24 24" :fill="isFav(card.key) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z" /></svg>
            </button>

            <div class="tile-overlay">
              <span v-if="launching === card.key" class="tile-spin">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              </span>
              <span v-else class="tile-play">Play</span>
            </div>
          </div>
          <span class="game-name">{{ card.name }}</span>
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
.wrap { max-width: 1480px; margin: 0 auto; padding-left: 24px; padding-right: 24px; }
.noscroll::-webkit-scrollbar { display: none; }
.noscroll { -ms-overflow-style: none; scrollbar-width: none; }

/* ── Hero (slim) ── */
.hero-sect { padding-top: 16px; padding-bottom: 6px; }
.hero-frame {
  position: relative;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.hero-track { display: flex; transition: transform 0.55s cubic-bezier(0.22, 0.61, 0.36, 1); }
.hero-slide {
  flex: 0 0 100%;
  height: 188px;
  position: relative;
  display: flex;
  align-items: center;
  overflow: hidden;
}
.hero-orb {
  position: absolute;
  right: -50px;
  top: -70px;
  width: 320px;
  height: 320px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--brand-primary) 24%, transparent), transparent 70%);
}
.hero-ghost {
  position: absolute;
  right: 40px;
  bottom: 10px;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 110px;
  color: rgba(255, 255, 255, 0.05);
  line-height: 0.8;
  pointer-events: none;
}
.hero-body { position: relative; padding: 0 44px; max-width: 560px; }
.hero-kicker {
  display: inline-block;
  background: color-mix(in srgb, var(--brand-primary) 18%, transparent);
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  padding: 4px 10px;
  border-radius: 16px;
  margin-bottom: 10px;
}
.hero-title {
  font-family: var(--font-heading);
  font-weight: 700;
  font-size: clamp(24px, 3vw, 36px);
  line-height: 1.02;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 8px;
  text-wrap: balance;
}
.hero-sub { font-size: 14px; color: rgba(255, 255, 255, 0.78); margin-bottom: 14px; max-width: 400px; }
.hero-cta {
  display: inline-block;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 10px 24px;
  border-radius: 8px;
  text-decoration: none;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--brand-primary) 38%, transparent);
  transition: transform 0.12s;
}
.hero-cta:hover { transform: translateY(-1px); }
.hero-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: rgba(10, 22, 40, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.hero-arrow:hover { background: rgba(10, 22, 40, 0.8); }
.hero-prev { left: 12px; }
.hero-next { right: 12px; }
.hero-dots { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; }
.hero-dot { width: 6px; height: 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.4); border: none; cursor: pointer; transition: width 0.3s, background 0.3s; }
.hero-dot.on { width: 20px; background: var(--brand-primary); }

/* ── Filter bar ── */
.filter-sect {
  display: flex;
  gap: 12px;
  align-items: center;
  padding-top: 12px;
  padding-bottom: 8px;
  position: sticky;
  top: 114px;
  z-index: 20;
  background: color-mix(in srgb, var(--surface-base) 94%, transparent);
  backdrop-filter: blur(10px);
}
.filter-row { display: flex; gap: 8px; overflow-x: auto; flex: 1; padding-bottom: 2px; }
.cat-pill {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-raised);
  color: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 14px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.cat-pill:hover { color: var(--text-primary); border-color: rgba(255, 255, 255, 0.2); }
.cat-pill.on {
  background: var(--brand-primary);
  color: var(--text-on-brand);
  border-color: var(--brand-primary);
}
.cat-pill svg { width: 15px; height: 15px; }
.fav-pill {
  color: var(--brand-primary);
  border-color: color-mix(in srgb, var(--brand-primary) 40%, transparent);
}

.grid-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 220px;
  background: var(--surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 0 12px;
  height: 38px;
}
.grid-search:focus-within { border-color: var(--brand-primary); }
.grid-search svg { width: 16px; height: 16px; color: rgba(255, 255, 255, 0.45); flex: none; }
.grid-search input {
  width: 100%;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 13px;
}

/* ── Providers ── */
.provider-sect { padding-top: 2px; padding-bottom: 4px; }
.provider-row { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
.provider-pill {
  flex: none;
  background: var(--surface-raised);
  color: rgba(255, 255, 255, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 16px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.provider-pill:hover { color: var(--text-primary); }
.provider-pill.on {
  background: color-mix(in srgb, var(--brand-primary) 14%, transparent);
  color: var(--brand-primary);
  border-color: var(--brand-primary);
}

/* ── Dense grid ── */
.grid-sect { padding-top: 10px; padding-bottom: 56px; }
.game-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(clamp(108px, 13vw, 158px), 1fr));
  gap: 14px 12px;
}
.game-item { display: flex; flex-direction: column; gap: 6px; min-width: 0; }

.tile {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  transition: transform 0.16s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.16s;
}
.tile:hover {
  transform: translateY(-3px) scale(1.02);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
}
.tile.launching { pointer-events: none; }
.tile-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.25s;
}
.tile-img.loaded { opacity: 1; }

/* compact bingo art */
.tile-bingo {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tile-bingo::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 50% 32%, rgba(255, 255, 255, 0.1), transparent 60%);
}
.bingo-balls { display: flex; gap: 4px; position: relative; }
.bingo-balls span {
  width: clamp(18px, 2.2vw, 26px);
  height: clamp(18px, 2.2vw, 26px);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: clamp(10px, 1.3vw, 14px);
  color: #fff;
  box-shadow: inset 0 -2px 4px rgba(0, 0, 0, 0.3), 0 2px 4px rgba(0, 0, 0, 0.3);
}

.tile-status {
  position: absolute;
  top: 7px;
  left: 7px;
  color: #fff;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 5px;
}
.tile-players {
  position: absolute;
  bottom: 7px;
  left: 7px;
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: #fff;
  background: rgba(10, 22, 40, 0.65);
  padding: 2px 6px;
  border-radius: 5px;
}
.tile-players svg { width: 11px; height: 11px; }

.tile-fav {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 22, 40, 0.55);
  border: none;
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  opacity: 0;
  transform: translateY(-3px);
  transition: opacity 0.15s, transform 0.15s, color 0.12s;
}
.tile:hover .tile-fav { opacity: 1; transform: translateY(0); }
.tile-fav:hover { color: #fff; }
.tile-fav.on { opacity: 1; transform: translateY(0); color: var(--brand-primary); }
.tile-fav svg { width: 15px; height: 15px; }

.tile-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(to top, rgba(10, 22, 40, 0.75), rgba(10, 22, 40, 0.2));
  opacity: 0;
  transition: opacity 0.16s;
}
.tile:hover .tile-overlay, .tile.launching .tile-overlay { opacity: 1; }
.tile-play {
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  padding: 8px 20px;
  border-radius: 7px;
}
.tile-spin svg { width: 26px; height: 26px; color: var(--brand-primary); animation: spin 0.8s linear infinite; }

.game-name {
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.72);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 2px;
}

/* ── Skeleton / empty / load-more ── */
.skeleton {
  aspect-ratio: 3 / 4;
  border-radius: 10px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.08) 50%, rgba(255, 255, 255, 0.04));
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.grid-empty { padding: 70px 0; text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 15px; }
.feed-sentinel { height: 1px; }
.load-more { display: flex; justify-content: center; padding: 24px; color: var(--brand-primary); }
.load-more svg { width: 24px; height: 24px; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Responsive ── */
@media (max-width: 860px) {
  .wrap { padding-left: 12px; padding-right: 12px; }
  .game-grid { grid-template-columns: repeat(auto-fill, minmax(clamp(96px, 28vw, 140px), 1fr)); gap: 12px 10px; }
  .hero-slide { height: 150px; }
  .hero-body { padding: 0 20px; }
  .hero-ghost { font-size: 72px; right: 14px; }
  .filter-sect { position: static; backdrop-filter: none; flex-wrap: wrap; }
  .grid-search { width: 100%; order: -1; }
  .tile-fav { opacity: 1; transform: none; }
}
</style>
