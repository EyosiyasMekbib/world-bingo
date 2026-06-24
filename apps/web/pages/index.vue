<script setup lang="ts">
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import { useProviderGamesStore } from '~/store/provider-games'
import type { ProviderGame } from '~/store/provider-games'
import { usePromotionsStore } from '~/store/promotions'
import type { Game } from '@world-bingo/shared-types'

const auth = useAuthStore()
const gameStore = useGameStore()
const providerStore = useProviderGamesStore()
const promotionsStore = usePromotionsStore()
const { connect } = useSocket()
const config = useRuntimeConfig()
const { patternLabel } = usePatternLabel()
const { track } = useAnalytics()

const showAuthPrompt = ref(false)

// True until the first bingo + casino load settles together (see onMounted).
const lobbyInitialLoading = ref(true)

/* ── Categories ─────────────────────────────────────────────────────────── */
const CATEGORY_LABELS: Record<string, string> = {
  ALL: 'All Games',
  TRENDING: 'Trending',
  POPULAR: 'Popular',
  BINGO: 'Bingo',
  ARCADE: 'Arcade',
  FISH: 'Fish',
  MINI: 'Mini',
  SLOTS: 'Slots',
  LIVE: 'Live',
  TABLE: 'Table',
  CRASH: 'Crash',
}

const selectedCategory = ref('ALL')
const showFavorites = ref(false)

const CATEGORY_ORDER = ['SLOTS', 'MINI', 'INSTWIN', 'POKER', 'LIVE', 'LIVEGRAND', 'ARCADE', 'BINGO']

const allCategories = computed(() => {
  const fixed = ['ALL', 'TRENDING', 'POPULAR']
  const provider = providerStore.categories.filter((c) => c !== 'ALL')
  const sorted = [
    ...CATEGORY_ORDER.filter((o) => provider.some((c) => c.toUpperCase() === o)),
    ...provider.filter((c) => !CATEGORY_ORDER.includes(c.toUpperCase())),
  ].map((o) => provider.find((c) => c.toUpperCase() === o) ?? o)
  return [...fixed, ...sorted]
})

function selectCategory(cat: string) {
  selectedCategory.value = cat
  showFavorites.value = false
}

/* ── Winners (decorative — no backend leaderboard yet) ──────────────────── */
const winnerTabs = [
  { key: 'DAILY', label: 'Daily Top Winners' },
  { key: 'WEEKLY', label: 'Weekly Winners' },
  { key: 'MONTHLY', label: 'Monthly Winners' },
]
const activeWinnerTab = ref('WEEKLY')

interface Winner {
  letter: string
  color: string
  amount: string
  phone: string
  date: string
}

const WINNERS: Record<string, Winner[]> = {
  DAILY: [
    { letter: 'D', color: '#1d4a8a', amount: '12,408.3', phone: '+251******512', date: '23.06.2026 | 14:22' },
    { letter: 'T', color: '#a8521a', amount: '11,901.3', phone: '+251******077', date: '23.06.2026 | 13:09' },
    { letter: 'K', color: '#1a7a4a', amount: '11,546.3', phone: '+251******341', date: '23.06.2026 | 12:48' },
    { letter: 'H', color: '#7a2a8a', amount: '11,265.3', phone: '+251******908', date: '23.06.2026 | 11:31' },
    { letter: 'Y', color: '#0e7490', amount: '11,056.3', phone: '+251******620', date: '23.06.2026 | 10:05' },
  ],
  WEEKLY: [
    { letter: 'B', color: '#1d4a8a', amount: '80,908.3', phone: '+251******137', date: '22.06.2026 | 21:52' },
    { letter: 'S', color: '#a8521a', amount: '81,001.3', phone: '+251******204', date: '22.06.2026 | 21:31' },
    { letter: 'A', color: '#1a7a4a', amount: '80,946.3', phone: '+251******088', date: '22.06.2026 | 20:18' },
    { letter: 'F', color: '#7a2a8a', amount: '80,965.3', phone: '+251******319', date: '21.06.2026 | 19:44' },
    { letter: 'M', color: '#0e7490', amount: '80,956.3', phone: '+251******161', date: '21.06.2026 | 18:09' },
  ],
  MONTHLY: [
    { letter: 'G', color: '#1d4a8a', amount: '342,118.3', phone: '+251******455', date: '18.06.2026 | 22:40' },
    { letter: 'N', color: '#a8521a', amount: '338,902.3', phone: '+251******781', date: '14.06.2026 | 20:12' },
    { letter: 'R', color: '#1a7a4a', amount: '331,540.3', phone: '+251******029', date: '11.06.2026 | 19:55' },
    { letter: 'E', color: '#7a2a8a', amount: '327,866.3', phone: '+251******610', date: '07.06.2026 | 18:33' },
    { letter: 'W', color: '#0e7490', amount: '321,204.3', phone: '+251******372', date: '03.06.2026 | 17:21' },
  ],
}

const winners = computed(() => WINNERS[activeWinnerTab.value] ?? [])

/* ── Hero carousel (coded slides) ───────────────────────────────────────── */
interface HeroSlide {
  id: string
  badge: string
  title: string
  sub: string
  cta: string
  watermark: string
  gradient: string
  accent: string
  action: 'games' | 'rooms' | 'deposit'
}

const heroSlides: HeroSlide[] = [
  {
    id: 'aviator',
    badge: 'High Flyer',
    title: 'Aviator — Cash\nOut Before It Flies',
    sub: 'Watch the multiplier climb and grab your winnings before the plane takes off into the clouds.',
    cta: 'Fly Now',
    watermark: 'X10',
    gradient: 'linear-gradient(105deg,#0a2c22 0%,#0e3a2c 45%,#0f5346 100%)',
    accent: '#34d399',
    action: 'games',
  },
  {
    id: 'bingo',
    badge: 'Live Rooms',
    title: 'Bingo — Daub\nYour Way To Big Wins',
    sub: 'Join a live room, grab your cartela and race to complete the pattern before everyone else.',
    cta: 'Play Now',
    watermark: 'B',
    gradient: 'linear-gradient(105deg,#071633 0%,#0d2a5c 50%,#143b86 100%)',
    accent: '#60a5fa',
    action: 'rooms',
  },
  {
    id: 'bonus',
    badge: 'Welcome Offer',
    title: 'First Deposit —\n100% Bonus',
    sub: 'Double your first deposit and start playing with twice the balance. A limited-time welcome gift.',
    cta: 'Deposit Now',
    watermark: '+100%',
    gradient: 'linear-gradient(105deg,#3a2407 0%,#5c3a0d 45%,#7a4f12 100%)',
    accent: '#fbbf24',
    action: 'deposit',
  },
]

const currentSlide = ref(0)
const activeSlide = computed(() => heroSlides[currentSlide.value])
let slideTimer: ReturnType<typeof setInterval> | null = null

function goToSlide(idx: number) {
  currentSlide.value = idx
  if (slideTimer) clearInterval(slideTimer)
  startSlideTimer()
}
function prevSlide() {
  goToSlide((currentSlide.value - 1 + heroSlides.length) % heroSlides.length)
}
function nextSlide() {
  goToSlide((currentSlide.value + 1) % heroSlides.length)
}
function startSlideTimer() {
  slideTimer = setInterval(() => {
    currentSlide.value = (currentSlide.value + 1) % heroSlides.length
  }, 6000)
}

const touchStartX = ref(0)
function onTouchStart(e: TouchEvent) {
  touchStartX.value = e.changedTouches[0].clientX
}
function onTouchEnd(e: TouchEvent) {
  const dx = e.changedTouches[0].clientX - touchStartX.value
  if (Math.abs(dx) < 40) return
  if (dx < 0) nextSlide()
  else prevSlide()
}

function heroAction(action: HeroSlide['action']) {
  if (action === 'rooms') {
    document.getElementById('games-grid')?.scrollIntoView({ behavior: 'smooth' })
    selectCategory('BINGO')
  } else if (action === 'deposit') {
    if (!auth.isAuthenticated) showAuthPrompt.value = true
    else navigateTo('/wallet')
  } else {
    navigateTo('/games')
  }
}

/* ── Vendor / provider chips ────────────────────────────────────────────── */
const STATIC_VENDORS = [
  '1x2 Network', '3 Oaks Gaming', '7Mojos', '7Mojos Live', 'AGT Software',
  'ATLAS V2', 'Absolute', 'Ad Lunam', 'Amigo Gaming', 'Amusnet', 'Amusnet Live',
]
const activeVendor = ref('ALL')

const vendorsAreReal = computed(() =>
  providerStore.games.some((g) => g.vendorCode || g.providerName),
)

const vendorChips = computed<{ code: string; name: string }[]>(() => {
  const map = new Map<string, string>()
  for (const g of providerStore.games) {
    const name = g.providerName ?? g.vendorCode
    const code = g.vendorCode ?? g.providerName
    if (name && code) map.set(code, name)
  }
  const derived = [...map.entries()].map(([code, name]) => ({ code, name }))
  if (derived.length) return derived
  return STATIC_VENDORS.map((n) => ({ code: n, name: n }))
})

function selectVendor(code: string) {
  activeVendor.value = code
}

/* ── Favorites ──────────────────────────────────────────────────────────── */
const favorites = ref<Set<string>>(new Set())
function isFav(key: string) {
  return favorites.value.has(key)
}
function toggleFav(key: string, e: Event) {
  e.preventDefault()
  e.stopPropagation()
  const next = new Set(favorites.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  favorites.value = next
}

/* ── Game grid model ────────────────────────────────────────────────────── */
interface LobbyCard {
  key: string
  badge: string
  title: string
  image: string | null
  letter: string
  to?: string
  gameId?: string
  price?: string
  status?: string
  vendor?: string
}

const trendingBingo = computed(() => {
  const weight = (s: string) => (s === 'IN_PROGRESS' ? 0 : s === 'STARTING' ? 1 : s === 'LOCKING' ? 2 : 3)
  return [...gameStore.availableGames].sort((a, b) => {
    const sw = weight(a.status) - weight(b.status)
    if (sw !== 0) return sw
    const ap = gameStore.livePlayers[a.id] ?? (a as any).currentPlayers ?? 0
    const bp = gameStore.livePlayers[b.id] ?? (b as any).currentPlayers ?? 0
    return bp - ap
  })
})

const popularBingo = computed(() =>
  [...gameStore.availableGames].sort((a, b) => {
    const ap = gameStore.livePlayers[a.id] ?? (a as any).currentPlayers ?? 0
    const bp = gameStore.livePlayers[b.id] ?? (b as any).currentPlayers ?? 0
    if (bp !== ap) return bp - ap
    return Number(a.ticketPrice) - Number(b.ticketPrice)
  }),
)

function bingoToCard(g: Game): LobbyCard {
  return {
    key: 'b-' + g.id,
    badge: 'Bingo',
    title: patternLabel(g.pattern) || 'Bingo Room',
    image: null,
    letter: 'B',
    gameId: g.id,
    price: Number(g.ticketPrice).toLocaleString() + ' ETB',
    status: g.status,
  }
}

function hasImage(g: ProviderGame) {
  return !!(g.imageSquare || g.imageLandscape)
}

// Popular crash/instant games pinned to the top of the All Games grid (in this order)
const FEATURED_GAMES = [
  'aviator',
  'chickenroad',
  'aviatrix',
  'jetx',
  'chickenroad2',
  'plinko',
  'crashkick',
  'chicknroad2',
  'chicknroad',
  'flyx',
  'flyxcashturbo',
  'plinkopop',
  'minepop',
  'dicepop',
  'bigbuttonbash',
  'soccerstriker',
  'theincredibleballoonmachine',
  'fruitblast',
]

function featuredRank(g: ProviderGame) {
  const name = (g.gameName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const i = FEATURED_GAMES.indexOf(name)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

function sortFeatured(games: ProviderGame[]) {
  return [...games].sort((a, b) => featuredRank(a) - featuredRank(b))
}

function providerToCard(g: ProviderGame): LobbyCard {
  return {
    key: 'p-' + g.gameCode,
    badge: CATEGORY_LABELS[g.categoryCode] ?? g.categoryCode,
    title: g.gameName,
    image: g.imageSquare ?? g.imageLandscape ?? null,
    letter: (g.gameName?.[0] ?? '?').toUpperCase(),
    to: `/play/${providerStore.activeProviderCode}/${g.gameCode}`,
    vendor: g.vendorCode ?? g.providerName ?? undefined,
  }
}

const categoryGamesMap = ref<Record<string, ProviderGame[]>>({})
const categoryGamesLoading = ref<Record<string, boolean>>({})

// Pool of every loaded provider game (default page + each fetched category), deduped by gameCode.
// Ensures featured games living in non-default categories (e.g. INSTWIN) can surface in the ALL grid.
const allProviderGames = computed<ProviderGame[]>(() => {
  const seen = new Set<string>()
  const pool: ProviderGame[] = []
  for (const g of [...providerStore.games, ...Object.values(categoryGamesMap.value).flat()]) {
    if (seen.has(g.gameCode)) continue
    seen.add(g.gameCode)
    pool.push(g)
  }
  return pool
})

const gridGames = computed<LobbyCard[]>(() => {
  const cat = selectedCategory.value
  let cards: LobbyCard[]
  if (cat === 'BINGO') {
    cards = gameStore.availableGames.map(bingoToCard)
  } else if (cat === 'ALL') {
    // Featured games first, then remaining provider games; bingo rooms at the bottom
    cards = [...sortFeatured(allProviderGames.value.filter(hasImage)).map(providerToCard), ...gameStore.availableGames.map(bingoToCard)]
  } else if (cat === 'TRENDING') {
    cards = [...sortFeatured(allProviderGames.value.filter(hasImage)).map(providerToCard), ...trendingBingo.value.map(bingoToCard)]
  } else if (cat === 'POPULAR') {
    cards = popularBingo.value.map(bingoToCard)
  } else {
    cards = (categoryGamesMap.value[cat] ?? []).filter(hasImage).map(providerToCard)
  }

  if (activeVendor.value !== 'ALL' && vendorsAreReal.value) {
    cards = cards.filter((c) => c.vendor === activeVendor.value)
  }
  if (showFavorites.value) {
    cards = cards.filter((c) => favorites.value.has(c.key))
  }
  return cards
})

const gridCount = computed(() => gridGames.value.length)

const headingLabel = computed(() =>
  showFavorites.value ? 'Favorites' : CATEGORY_LABELS[selectedCategory.value] ?? selectedCategory.value,
)

const gridLoading = computed(() => {
  if (showFavorites.value) return false
  const cat = selectedCategory.value
  // ALL & TRENDING blend casino + bingo — hold the skeleton until the combined
  // first load settles so every game (bingo included) reveals together.
  if (cat === 'ALL' || cat === 'TRENDING') {
    // Reveal as soon as either branch (casino or bingo) has data instead of
    // holding the skeleton for the slower one — the rest streams in.
    if (allProviderGames.value.length || gameStore.availableGames.length) return false
    return lobbyInitialLoading.value
  }
  if (cat === 'BINGO' || cat === 'POPULAR') {
    return gameStore.loadingGames && !gameStore.availableGames.length
  }
  return !!categoryGamesLoading.value[cat] && !(categoryGamesMap.value[cat]?.length)
})

async function fetchCategoryGames(category: string, pageSize = 24) {
  const code = providerStore.activeProviderCode
  if (!code) return
  categoryGamesLoading.value[category] = true
  try {
    const result = await $fetch<{ games: ProviderGame[]; totalPages: number }>(
      `${config.public.apiBase}/providers/${code}/games?page=1&pageSize=${pageSize}&category=${category}`,
    )
    categoryGamesMap.value[category] = result.games
  } catch {
    categoryGamesMap.value[category] = []
  } finally {
    delete categoryGamesLoading.value[category]
  }
}

function handleJoinGame(gameId?: string) {
  if (!gameId) return
  if (!auth.isAuthenticated) {
    showAuthPrompt.value = true
    return
  }
  navigateTo(`/quick/${gameId}`)
}

/* ── Lifecycle ──────────────────────────────────────────────────────────── */
onMounted(async () => {
  track('lobby_view')

  try {
    const saved = localStorage.getItem('ab_favs')
    if (saved) favorites.value = new Set(JSON.parse(saved))
  } catch { /* ignore */ }

  promotionsStore.fetch()

  // Load bingo rooms and casino games in parallel. Once providers resolve,
  // categories and the first games page are independent — fire them concurrently
  // instead of chaining, saving a full network round-trip on first paint.
  const bingoLoad = gameStore.fetchAvailableGames().catch(() => { /* gameStore.error */ })
  const providerLoad = (async () => {
    await providerStore.fetchProviders()
    if (providerStore.activeProviderCode) {
      await Promise.all([
        providerStore.fetchCategories(),
        providerStore.fetchGames({ reset: true, pageSize: 60 }),
      ])
    }
  })().catch(() => { /* keep lobby usable on provider failure */ })

  await Promise.allSettled([bingoLoad, providerLoad])
  lobbyInitialLoading.value = false

  // Secondary: per-category pools that feed the featured pins. Non-blocking and
  // deferred to idle so the initial fan-out doesn't contend with the user's
  // first scroll — the grid is already shown; these progressively enrich it.
  if (providerStore.activeProviderCode) {
    const cats = providerStore.categories.filter((c) => c !== 'BINGO' && c !== 'ALL')
    const loadCats = () => Promise.all(cats.map((c) => fetchCategoryGames(c)))
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => loadCats())
    else setTimeout(loadCats, 200)
  }

  startSlideTimer()

  const socket = connect()
  if (!socket) return

  socket.emit('lobby:subscribe')
  socket.on('lobby:game-added', (game: Game) => gameStore.onLobbyGameAdded(game))
  socket.on('lobby:game-removed', (gameId: string) => gameStore.onLobbyGameRemoved(gameId))
  socket.on('game:updated', (game: Game) => gameStore.onGameUpdated(game))
  ;(socket as any).on('player_count_update', (p: { gameId: string; playerCount: number }) =>
    gameStore.onPlayerCountUpdate(p.gameId, p.playerCount),
  )
  socket.on('game:countdown', (p: { gameId: string; countdownSecs: number; startsAt: string }) =>
    gameStore.onGameCountdown(p),
  )
})

watch(
  favorites,
  (v) => {
    try {
      localStorage.setItem('ab_favs', JSON.stringify([...v]))
    } catch { /* ignore */ }
  },
  { deep: true },
)

onUnmounted(() => {
  if (slideTimer) clearInterval(slideTimer)
  const socket = connect()
  socket?.emit('lobby:unsubscribe')
})
</script>

<template>
  <div class="lobby-page">
    <!-- ═══════════════ HERO ═══════════════ -->
    <section class="max-wrap">
      <div
        class="hero"
        :style="{ background: activeSlide.gradient }"
        @touchstart.passive="onTouchStart"
        @touchend.passive="onTouchEnd"
      >
        <div :key="activeSlide.id" class="hero-content">
          <span class="hero-badge">{{ activeSlide.badge }}</span>
          <h1 class="hero-title">{{ activeSlide.title }}</h1>
          <p class="hero-sub">{{ activeSlide.sub }}</p>
          <button class="hero-cta" @click="heroAction(activeSlide.action)">{{ activeSlide.cta }}</button>
        </div>

        <div class="hero-watermark" :style="{ color: activeSlide.accent }" aria-hidden="true">
          {{ activeSlide.watermark }}
        </div>

        <button class="hero-arrow hero-arrow--prev" aria-label="Previous slide" @click="prevSlide">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <button class="hero-arrow hero-arrow--next" aria-label="Next slide" @click="nextSlide">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <div class="hero-dots" role="tablist" aria-label="Slides">
          <button
            v-for="(s, i) in heroSlides"
            :key="s.id"
            class="hdot"
            :class="{ 'hdot--active': currentSlide === i }"
            role="tab"
            :aria-selected="currentSlide === i"
            :aria-label="`Slide ${i + 1}`"
            @click="goToSlide(i)"
          />
        </div>
      </div>
    </section>

    <!-- ═══════════════ WINNERS ═══════════════ -->
    <section class="max-wrap winners">
      <div class="win-tabs" role="tablist">
        <button
          v-for="t in winnerTabs"
          :key="t.key"
          class="win-tab"
          :class="{ 'win-tab--active': activeWinnerTab === t.key }"
          role="tab"
          :aria-selected="activeWinnerTab === t.key"
          @click="activeWinnerTab = t.key"
        >
          {{ t.label }}
        </button>
      </div>

      <div class="win-grid">
        <div v-for="(w, i) in winners" :key="i" class="win-card">
          <div class="win-av" :style="{ background: w.color }">{{ w.letter }}</div>
          <div class="win-info">
            <div class="win-amt">{{ w.amount }} <span>ETB</span></div>
            <div class="win-phone">{{ w.phone }}</div>
            <div class="win-date">{{ w.date }}</div>
          </div>
        </div>
      </div>
    </section>

    <!-- ═══════════════ FILTERS ═══════════════ -->
    <section class="max-wrap filters">
      <div class="cat-row">
        <div class="cat-pills noscroll">
          <button
            v-for="cat in allCategories"
            :key="cat"
            class="cat-pill"
            :class="{ 'cat-pill--active': selectedCategory === cat && !showFavorites }"
            @click="selectCategory(cat)"
          >
            {{ (CATEGORY_LABELS[cat] ?? cat) }}
          </button>
        </div>
        <button class="fav-btn" :class="{ 'fav-btn--active': showFavorites }" @click="showFavorites = !showFavorites">
          <svg viewBox="0 0 24 24" :fill="showFavorites ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
          <span class="fav-label">Favorites</span>
        </button>
      </div>

      <div class="vendor-row">
        <div class="vendor-chips noscroll">
          <button
            class="vchip"
            :class="{ 'vchip--active': activeVendor === 'ALL' }"
            @click="selectVendor('ALL')"
          >
            All
          </button>
          <button
            v-for="v in vendorChips"
            :key="v.code"
            class="vchip"
            :class="{ 'vchip--active': activeVendor === v.code }"
            @click="selectVendor(v.code)"
          >
            {{ v.name }}
          </button>
        </div>
        <button class="providers-btn">
          Providers
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
      </div>
    </section>

    <!-- ═══════════════ GAMES ═══════════════ -->
    <section id="games-grid" class="max-wrap games-sec">
      <div class="games-head">
        <h2 class="games-title">{{ headingLabel }}</h2>
        <span class="games-count">{{ gridCount }} games</span>
      </div>

      <div v-if="gridLoading" class="game-grid" aria-busy="true" aria-label="Loading games">
        <div v-for="n in 12" :key="n" class="gc-skel" :style="{ '--sk-delay': `${((n - 1) % 6) * 90}ms` }">
          <div class="gc-skel-thumb">
            <span class="gc-skel-badge" />
            <span class="gc-skel-letter" />
            <span class="gc-skel-price" />
          </div>
          <div class="gc-skel-foot">
            <span class="gc-skel-name" />
            <span class="gc-skel-fav" />
          </div>
        </div>
      </div>

      <div v-else-if="!gridGames.length" class="empty">
        <template v-if="showFavorites">No favorites yet — tap the star on a game to save it.</template>
        <template v-else>No games available right now. Check back soon.</template>
      </div>

      <div v-else class="game-grid">
        <template v-for="card in gridGames" :key="card.key">
          <!-- Provider game → link -->
          <NuxtLink v-if="card.to" :to="card.to" class="game-card">
            <div class="gc-thumb">
              <div class="gc-letter">{{ card.letter }}</div>
              <img
                v-if="card.image"
                :src="card.image"
                :alt="card.title"
                class="gc-img"
                loading="lazy"
                @error="(e) => ((e.target as HTMLImageElement).style.display = 'none')"
              />
              <span class="gc-badge">{{ card.badge }}</span>
            </div>
            <div class="gc-foot">
              <span class="gc-name">{{ card.title }}</span>
              <span class="gc-fav" :class="{ 'gc-fav--on': isFav(card.key) }" role="button" :aria-label="isFav(card.key) ? 'Remove favorite' : 'Add favorite'" @click="toggleFav(card.key, $event)">
                <svg viewBox="0 0 24 24" :fill="isFav(card.key) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
              </span>
            </div>
          </NuxtLink>

          <!-- Bingo room → join -->
          <button v-else type="button" class="game-card game-card--btn" @click="handleJoinGame(card.gameId)">
            <div class="gc-thumb gc-thumb--bingo">
              <div class="gc-letter">{{ card.letter }}</div>
              <span class="gc-badge">{{ card.badge }}</span>
              <span v-if="card.status && card.status !== 'WAITING'" class="gc-live"><span class="gc-live-dot" />Live</span>
              <span v-if="card.price" class="gc-price">{{ card.price }}</span>
            </div>
            <div class="gc-foot">
              <span class="gc-name">{{ card.title }}</span>
              <span class="gc-fav" :class="{ 'gc-fav--on': isFav(card.key) }" role="button" :aria-label="isFav(card.key) ? 'Remove favorite' : 'Add favorite'" @click="toggleFav(card.key, $event)">
                <svg viewBox="0 0 24 24" :fill="isFav(card.key) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
              </span>
            </div>
          </button>
        </template>
      </div>
    </section>

    <AuthPromptModal v-model="showAuthPrompt" />
  </div>
</template>

<style scoped>
.lobby-page {
  min-height: 100vh;
  background: var(--surface-base);
  font-family: var(--font-body);
  padding-bottom: 56px;
}

.max-wrap {
  max-width: 1480px;
  margin: 0 auto;
  padding: 0 28px;
}
@media (max-width: 720px) {
  .max-wrap { padding: 0 16px; }
}

.noscroll { scrollbar-width: none; -ms-overflow-style: none; }
.noscroll::-webkit-scrollbar { display: none; }

/* ── HERO ──────────────────────────────────────────────────────────────── */
.hero {
  position: relative;
  margin-top: 22px;
  border-radius: 18px;
  overflow: hidden;
  min-height: 200px;
  padding: 28px 60px;
  display: flex;
  align-items: center;
  color: #fff;
  isolation: isolate;
}
.hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 120% at 80% 50%, rgba(255, 255, 255, 0.06), transparent 60%);
  pointer-events: none;
}

.hero-content {
  position: relative;
  z-index: 2;
  max-width: 600px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  animation: hero-in 0.4s ease both;
}
@keyframes hero-in {
  from { opacity: 0; transform: translateX(14px); }
  to { opacity: 1; transform: translateX(0); }
}

.hero-badge {
  display: inline-block;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: rgba(255, 255, 255, 0.85);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  padding: 6px 14px;
  border-radius: 6px;
  margin-bottom: 20px;
}

.hero-title {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: clamp(30px, 4.6vw, 54px);
  line-height: 1.04;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  white-space: pre-line;
  margin: 0;
  color: #fff;
}

.hero-sub {
  font-size: 15px;
  line-height: 1.55;
  color: rgba(255, 255, 255, 0.82);
  max-width: 460px;
  margin: 18px 0 26px;
}

.hero-cta {
  background: var(--brand-primary);
  color: var(--text-on-brand);
  border: none;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  padding: 13px 32px;
  border-radius: 9px;
  cursor: pointer;
  transition: transform 0.12s, box-shadow 0.12s, background 0.12s;
}
.hero-cta:hover {
  transform: translateY(-1px);
  background: color-mix(in srgb, var(--brand-primary) 90%, white);
  box-shadow: 0 10px 26px color-mix(in srgb, var(--brand-primary) 38%, transparent);
}
.hero-cta:active { transform: translateY(0); }

.hero-watermark {
  position: absolute;
  z-index: 1;
  right: 5%;
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: clamp(110px, 17vw, 250px);
  line-height: 1;
  opacity: 0.14;
  pointer-events: none;
  white-space: nowrap;
}

.hero-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 3;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.12s, transform 0.12s;
}
.hero-arrow svg { width: 18px; height: 18px; }
.hero-arrow:hover { background: rgba(0, 0, 0, 0.5); }
.hero-arrow:active { transform: translateY(-50%) scale(0.94); }
.hero-arrow--prev { left: 16px; }
.hero-arrow--next { right: 16px; }

.hero-dots {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  gap: 6px;
}
.hdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: none;
  padding: 0;
  background: rgba(255, 255, 255, 0.3);
  cursor: pointer;
  transition: width 0.2s, background 0.2s;
}
.hdot--active { width: 26px; border-radius: 4px; background: var(--brand-primary); }

@media (max-width: 720px) {
  .hero { padding: 16px 20px; min-height: 120px; }
  .hero-arrow { display: none; }
  .hero-sub { display: none; }
  .hero-badge { margin-bottom: 8px; padding: 4px 10px; font-size: 10px; }
  .hero-title { font-size: clamp(18px, 5.5vw, 26px); }
  .hero-cta { padding: 10px 22px; font-size: 13px; margin-top: 12px; }
}

/* ── WINNERS ───────────────────────────────────────────────────────────── */
.winners { margin-top: 34px; }

.win-tabs {
  display: flex;
  justify-content: center;
  gap: 34px;
  margin-bottom: 20px;
}
.win-tab {
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
  padding: 6px 2px;
  position: relative;
  transition: color 0.15s;
}
.win-tab:hover { color: rgba(255, 255, 255, 0.8); }
.win-tab--active { color: #fff; }
.win-tab--active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -7px;
  height: 3px;
  border-radius: 3px;
  background: var(--brand-primary);
}

.win-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 14px;
}

.win-card {
  display: flex;
  align-items: center;
  gap: 13px;
  background: var(--surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  padding: 14px 16px;
}
.win-av {
  flex: none;
  width: 46px;
  height: 46px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 22px;
  color: #fff;
}
.win-info { min-width: 0; line-height: 1.35; }
.win-amt {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 18px;
  color: #fff;
  white-space: nowrap;
}
.win-amt span { font-size: 11px; color: var(--brand-primary); margin-left: 2px; }
.win-phone { font-size: 12px; color: rgba(255, 255, 255, 0.6); }
.win-date { font-size: 11px; color: rgba(255, 255, 255, 0.38); }

@media (max-width: 1080px) { .win-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 720px) {
  .win-grid {
    display: flex;
    grid-template-columns: none;
    overflow-x: auto;
    gap: 12px;
    scroll-snap-type: x mandatory;
    margin: 0 -16px;
    padding: 0 16px 4px;
    scrollbar-width: none;
  }
  .win-grid::-webkit-scrollbar { display: none; }
  .win-card { flex: 0 0 80%; scroll-snap-align: start; }
  .win-tabs { gap: 16px; }
  .win-tab { font-size: 12px; letter-spacing: 0.4px; }
}

/* ── FILTERS ───────────────────────────────────────────────────────────── */
.filters { margin-top: 36px; }

.cat-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.cat-pills {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
  padding-bottom: 2px;
}
.cat-pill {
  flex: none;
  background: var(--surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.6);
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  padding: 10px 18px;
  border-radius: 9px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.cat-pill:hover { color: #fff; border-color: rgba(255, 255, 255, 0.18); }
.cat-pill--active {
  background: var(--brand-primary);
  border-color: var(--brand-primary);
  color: var(--text-on-brand);
}

.fav-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--brand-primary) 50%, transparent);
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  padding: 10px 18px;
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.12s;
}
.fav-btn svg { width: 16px; height: 16px; }
.fav-btn:hover { background: color-mix(in srgb, var(--brand-primary) 10%, transparent); }
.fav-btn--active { background: var(--brand-primary); border-color: var(--brand-primary); color: var(--text-on-brand); }

.vendor-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
}
.vendor-chips {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
  padding-bottom: 2px;
}
.vchip {
  flex: none;
  background: var(--surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.62);
  font-family: var(--font-body);
  font-weight: 500;
  font-size: 13px;
  padding: 8px 17px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.vchip:hover { color: #fff; }
.vchip--active {
  border-color: var(--brand-primary);
  color: var(--brand-primary);
  background: color-mix(in srgb, var(--brand-primary) 8%, transparent);
}

.providers-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 999px;
  cursor: pointer;
}
.providers-btn svg { width: 14px; height: 14px; }
.providers-btn:hover { border-color: var(--brand-primary); color: #fff; }

/* Mobile filters — match the app reference: pills + star row, centered Providers */
@media (max-width: 720px) {
  .fav-btn {
    gap: 0;
    padding: 10px;
    width: 42px;
    justify-content: center;
  }
  .fav-btn .fav-label { display: none; }
  .vendor-row { margin-top: 12px; }
  .vendor-chips { display: none; }
  .providers-btn { margin: 0 auto; }
}

/* ── GAMES ─────────────────────────────────────────────────────────────── */
.games-sec { margin-top: 30px; }

.games-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 18px;
}
.games-title {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 24px;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: #fff;
  margin: 0;
}
.games-count { font-size: 14px; color: rgba(255, 255, 255, 0.45); }

.game-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 18px;
}
@media (max-width: 640px) {
  .game-grid { grid-template-columns: repeat(2, 1fr); gap: 12px; }
}

.game-card {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface-raised);
  text-decoration: none;
  cursor: pointer;
  padding: 0;
  transition: transform 0.14s, border-color 0.14s;
}
.game-card--btn { font-family: inherit; }
.game-card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent); }
.game-card:active { transform: translateY(0); }

.gc-thumb {
  position: relative;
  aspect-ratio: 4 / 3;
  background: linear-gradient(150deg, #0d2050 0%, #16306a 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.gc-thumb--bingo { background: linear-gradient(150deg, #091840 0%, #142e62 100%); }

.gc-letter {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: clamp(48px, 7vw, 72px);
  color: rgba(255, 255, 255, 0.16);
  user-select: none;
}
.gc-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gc-badge {
  position: absolute;
  top: 9px;
  left: 9px;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(245, 166, 35, 0.4);
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 5px;
}

.gc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
}
.gc-fav {
  flex: none;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: color 0.14s, background 0.14s;
}
.gc-fav svg { width: 16px; height: 16px; }
.gc-fav:hover { background: rgba(255, 255, 255, 0.06); color: var(--brand-primary); }
.gc-fav--on { color: var(--brand-primary); }

.gc-live {
  position: absolute;
  bottom: 8px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  background: #dc2626;
  color: #fff;
  font-weight: 800;
  font-size: 10px;
  letter-spacing: 0.4px;
  padding: 3px 7px;
  border-radius: 5px;
}
.gc-live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #fff;
  animation: gc-blink 1.2s infinite;
}
.gc-price {
  position: absolute;
  bottom: 8px;
  right: 8px;
  background: color-mix(in srgb, var(--brand-primary) 18%, rgba(0, 0, 0, 0.5));
  border: 1px solid color-mix(in srgb, var(--brand-primary) 45%, transparent);
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 5px;
}

.gc-name {
  min-width: 0;
  flex: 1;
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.82);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── States ────────────────────────────────────────────────────────────── */
.empty {
  text-align: center;
  color: rgba(255, 255, 255, 0.45);
  padding: 64px 0;
  font-size: 14px;
}

/* Skeleton mirrors the real game card so the grid settles in place once
   data lands. A single brand-tinted sheen sweeps across each card, with a
   staggered delay (--sk-delay) for a gentle left-to-right cascade. */
.gc-skel {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: var(--surface-raised);
  isolation: isolate;
  animation: gc-skel-in 0.4s ease both;
}
.gc-skel::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background: linear-gradient(
    100deg,
    transparent 25%,
    rgba(255, 255, 255, 0.07) 45%,
    color-mix(in srgb, var(--brand-primary) 14%, rgba(255, 255, 255, 0.07)) 50%,
    rgba(255, 255, 255, 0.07) 55%,
    transparent 75%
  );
  background-size: 220% 100%;
  background-position: 180% 0;
  animation: gc-sheen 1.5s ease-in-out infinite;
  animation-delay: var(--sk-delay, 0ms);
}

.gc-skel-thumb {
  position: relative;
  aspect-ratio: 4 / 3;
  background: linear-gradient(150deg, #0d2050 0%, #16306a 100%);
}

/* dim placeholder blocks — the sheen above gives them life */
.gc-skel-badge,
.gc-skel-letter,
.gc-skel-price,
.gc-skel-name,
.gc-skel-fav {
  display: block;
  background: rgba(255, 255, 255, 0.07);
  border-radius: 5px;
}
.gc-skel-badge { position: absolute; top: 9px; left: 9px; width: 44px; height: 16px; }
.gc-skel-price { position: absolute; bottom: 8px; right: 8px; width: 50px; height: 18px; }
.gc-skel-letter {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.05);
}

.gc-skel-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px;
}
.gc-skel-name { height: 11px; width: 62%; border-radius: 3px; }
.gc-skel-fav { width: 22px; height: 22px; border-radius: 6px; flex: none; }

@keyframes gc-sheen {
  0% { background-position: 180% 0; }
  60%, 100% { background-position: -120% 0; }
}
@keyframes gc-skel-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes gc-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
</style>
