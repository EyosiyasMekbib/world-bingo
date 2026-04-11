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
const featuredTemplateId = ref<string | null>(null)
const config = useRuntimeConfig()
const { patternLabel } = usePatternLabel()
const { tournamentsEnabled } = useFeatureFlags()

const searchQuery = ref('')
const showAuthPrompt = ref(false)
const selectedCategory = ref('ALL')

const CATEGORY_LABELS: Record<string, string> = {
  ALL: 'All Games',
  BINGO: 'Bingo',
  SLOTS: 'Slots',
  LIVE: 'Live',
  TABLE: 'Table',
  CRASH: 'Crash',
}

const allCategories = computed(() => {
  const base = ['ALL', 'BINGO']
  const providerCats = providerStore.categories.filter((c) => c !== 'BINGO' && c !== 'ALL')
  return [...base, ...providerCats]
})

function selectCategory(cat: string) {
  selectedCategory.value = cat
  searchQuery.value = ''
}

const showBingoSection = computed(() =>
  selectedCategory.value === 'ALL' || selectedCategory.value === 'BINGO',
)

function showProviderCategory(cat: string) {
  return selectedCategory.value === 'ALL' || selectedCategory.value === cat
}

const categoryGamesMap = ref<Record<string, ProviderGame[]>>({})
const categoryGamesLoading = ref<Record<string, boolean>>({})

async function fetchCategoryGames(category: string) {
  const code = providerStore.activeProviderCode
  if (!code) return
  categoryGamesLoading.value[category] = true
  try {
    const result = await $fetch<{ games: ProviderGame[] }>(
      `${config.public.apiBase}/providers/${code}/games?page=1&pageSize=20&category=${category}`
    )
    categoryGamesMap.value[category] = result.games
  } catch {
    categoryGamesMap.value[category] = []
  } finally {
    delete categoryGamesLoading.value[category]
  }
}

const providerCategories = computed(() =>
  providerStore.categories.filter((c) => c !== 'BINGO' && c !== 'ALL'),
)

const currentSlide = ref(0)
let slideTimer: ReturnType<typeof setInterval> | null = null

const heroSlides = [
  { id: 'bingo', type: 'bingo' as const },
  { id: 'chicken-road', type: 'ad' as const, title: 'Chicken Road', tag: 'CRASH GAME', tagline: 'Cross the road. Dodge the fryer. Multiply your bet with every step.', color: '#f97316' },
  { id: 'aviator', type: 'ad' as const, title: 'Aviator', tag: 'MULTIPLIER GAME', tagline: "Watch the plane climb. Cash out before it crashes.", color: '#3b82f6' },
]

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
  }, 5000)
}

// Touch swipe support
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

function handleJoinGame(gameId: string) {
  if (!auth.isAuthenticated) {
    showAuthPrompt.value = true
    return
  }
  navigateTo(`/quick/${gameId}`)
}

const filteredGames = computed(() => {
  if (!searchQuery.value.trim()) return gameStore.availableGames
  const q = searchQuery.value.trim().toLowerCase()
  return gameStore.availableGames.filter((g: Game) =>
    String(g.ticketPrice).includes(q) ||
    g.status.toLowerCase().includes(q)
  )
})

const featuredGame = computed(() =>
  featuredTemplateId.value
    ? gameStore.availableGames.find((g) => g.templateId === featuredTemplateId.value) ?? null
    : null,
)

function scrollToRooms() {
  document.getElementById('rooms')?.scrollIntoView({ behavior: 'smooth' })
}

onMounted(async () => {
  try {
    await gameStore.fetchAvailableGames()
  } catch { /* errors stored in gameStore.error */ }

  promotionsStore.fetch()

  $fetch<{ templateId: string | null }>(`${config.public.apiBase}/settings/featured-game`)
    .then((r) => { featuredTemplateId.value = r.templateId })
    .catch(() => {})

  await providerStore.fetchProviders()
  if (providerStore.activeProviderCode) {
    await providerStore.fetchCategories()
    await providerStore.fetchGames({ reset: true })
    const cats = providerStore.categories.filter((c) => c !== 'BINGO' && c !== 'ALL')
    await Promise.all(cats.map((c) => fetchCategoryGames(c)))
  }

  startSlideTimer()

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

  ;(socket as any).on('player_count_update', (payload: { gameId: string; playerCount: number }) => {
    gameStore.onPlayerCountUpdate(payload.gameId, payload.playerCount)
  })

  socket.on('game:countdown', (payload: { gameId: string; countdownSecs: number; startsAt: string }) => {
    gameStore.onGameCountdown(payload)
  })
})

onUnmounted(() => {
  if (slideTimer) clearInterval(slideTimer)
  const socket = connect()
  socket?.emit('lobby:unsubscribe')
})
</script>

<template>
  <div class="lobby-page">

    <!-- ── HERO ─────────────────────────────────────────────────── -->
    <section class="hero" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
      <div class="hero-bg"></div>

      <!-- Arrow navigation (desktop only) -->
      <button class="hero-arrow hero-arrow--prev" aria-label="Previous slide" @click="prevSlide">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <button class="hero-arrow hero-arrow--next" aria-label="Next slide" @click="nextSlide">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>

      <Transition name="hero-fade" mode="out-in">
        <!-- Slide 0: Bingo -->
        <div v-if="currentSlide === 0" key="bingo" class="hero-inner max-container">
          <div class="hero-text">
            <p class="hero-eyebrow">
              <span class="eyebrow-dot"></span>
              Ethiopia's #1 Bingo Platform
            </p>
            <h1 class="hero-title">Play <span class="hero-accent">Bingo</span>,<br>Win Real ETB</h1>
            <p class="hero-sub">Join thousands of players. Pick your cartela, call BINGO, get paid instantly.</p>
            <button class="hero-cta" @click="scrollToRooms">
              Play Now
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          </div>

          <div class="hero-art">
            <template v-if="featuredGame">
              <div class="featured-card">
                <div class="fc-eyebrow">Featured Game</div>
                <div class="fc-title">{{ featuredGame.title }}</div>
                <div class="fc-price">
                  {{ Number(featuredGame.ticketPrice).toLocaleString() }}
                  <span class="fc-currency">ETB</span>
                </div>
                <div class="fc-meta">
                  {{ patternLabel(featuredGame.pattern) }}
                  &nbsp;·&nbsp;
                  {{ gameStore.livePlayers[featuredGame.id] ?? (featuredGame as any).currentPlayers ?? 0 }}/{{ (featuredGame as any).maxPlayers ?? 10 }} players
                </div>
                <NuxtLink v-if="featuredGame.status === 'WAITING'" :to="`/quick/${featuredGame.id}`" class="fc-join">
                  Join Now
                </NuxtLink>
                <div v-else class="fc-live">
                  <span class="live-dot"></span>
                  {{ featuredGame.status === 'STARTING' ? 'Starting Soon' : 'Live Now' }}
                </div>
              </div>
            </template>
            <template v-else>
              <div class="bingo-card bingo-card--front">
                <div class="bc-cell">3</div><div class="bc-cell">17</div><div class="bc-cell">32</div><div class="bc-cell bc-cell--gold">46</div><div class="bc-cell">61</div>
                <div class="bc-cell bc-cell--blue">5</div><div class="bc-cell">20</div><div class="bc-cell">35</div><div class="bc-cell">51</div><div class="bc-cell bc-cell--gold">69</div>
                <div class="bc-cell">9</div><div class="bc-cell">28</div><div class="bc-cell bc-cell--free">FR</div><div class="bc-cell">53</div><div class="bc-cell">74</div>
                <div class="bc-cell">14</div><div class="bc-cell bc-cell--blue">24</div><div class="bc-cell">39</div><div class="bc-cell">48</div><div class="bc-cell">63</div>
                <div class="bc-cell bc-cell--blue">1</div><div class="bc-cell">16</div><div class="bc-cell">44</div><div class="bc-cell">60</div><div class="bc-cell bc-cell--blue">75</div>
              </div>
              <div class="bingo-card bingo-card--back">
                <div class="bc-cell">7</div><div class="bc-cell">19</div><div class="bc-cell bc-cell--blue">33</div><div class="bc-cell">49</div><div class="bc-cell">62</div>
                <div class="bc-cell">2</div><div class="bc-cell bc-cell--blue">21</div><div class="bc-cell">36</div><div class="bc-cell bc-cell--blue">52</div><div class="bc-cell">70</div>
                <div class="bc-cell">11</div><div class="bc-cell">29</div><div class="bc-cell bc-cell--free">FR</div><div class="bc-cell">55</div><div class="bc-cell bc-cell--blue">71</div>
                <div class="bc-cell">4</div><div class="bc-cell bc-cell--blue">18</div><div class="bc-cell">43</div><div class="bc-cell bc-cell--blue">59</div><div class="bc-cell">72</div>
                <div class="bc-cell">13</div><div class="bc-cell">29</div><div class="bc-cell bc-cell--blue">40</div><div class="bc-cell">47</div><div class="bc-cell">64</div>
              </div>
            </template>
          </div>
        </div>

        <!-- Slide 1: Chicken Road -->
        <div v-else-if="currentSlide === 1" key="chicken-road" class="hero-inner max-container">
          <div class="hero-text">
            <p class="hero-eyebrow" style="--dot-color:#f97316">
              <span class="eyebrow-dot" style="background:#f97316"></span>
              Crash Game · Coming Soon
            </p>
            <h1 class="hero-title">Chicken<br><span style="color:#f97316">Road</span></h1>
            <p class="hero-sub">Cross the road. Dodge the fryer. Multiply your bet with every step.</p>
            <button class="hero-cta hero-cta--muted" disabled>Coming Soon</button>
          </div>
          <div class="hero-art hero-art--centered">
            <div class="ad-card" style="--ad-accent:#f97316">
              <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <rect x="8" y="38" width="48" height="18" rx="3" fill="rgba(255,255,255,0.06)" stroke="rgba(249,115,22,0.3)" stroke-width="1"/>
                <rect x="20" y="44" width="8" height="3" rx="1" fill="rgba(249,115,22,0.5)"/>
                <rect x="36" y="44" width="8" height="3" rx="1" fill="rgba(249,115,22,0.5)"/>
                <ellipse cx="32" cy="28" rx="9" ry="10" fill="rgba(249,115,22,0.9)"/>
                <circle cx="32" cy="16" r="6" fill="rgba(249,115,22,0.9)"/>
                <polygon points="35,15 39,17 35,19" fill="#fbbf24"/>
                <circle cx="30" cy="15" r="2" fill="#fff"/>
                <circle cx="30" cy="15" r="1" fill="#000"/>
                <ellipse cx="22" cy="28" rx="5" ry="6" fill="rgba(249,115,22,0.7)" transform="rotate(-15 22 28)"/>
                <ellipse cx="42" cy="28" rx="5" ry="6" fill="rgba(249,115,22,0.7)" transform="rotate(15 42 28)"/>
                <path d="M29 10 Q31 6 33 10 Q31 8 29 10" fill="#ef4444"/>
              </svg>
              <div class="ad-mult">
                <span class="ad-mult-num" style="color:#f97316">9×</span>
                <span class="ad-mult-label">Max Multiplier</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Slide 2: Aviator -->
        <div v-else key="aviator" class="hero-inner max-container">
          <div class="hero-text">
            <p class="hero-eyebrow" style="--dot-color:#3b82f6">
              <span class="eyebrow-dot" style="background:#3b82f6"></span>
              Multiplier Game · Coming Soon
            </p>
            <h1 class="hero-title"><span style="color:#60a5fa">Aviator</span></h1>
            <p class="hero-sub">Watch the plane climb. The multiplier rises. Cash out before it crashes.</p>
            <button class="hero-cta hero-cta--muted" disabled>Coming Soon</button>
          </div>
          <div class="hero-art hero-art--centered">
            <div class="ad-card" style="--ad-accent:#3b82f6">
              <svg width="72" height="64" viewBox="0 0 80 72" fill="none" aria-hidden="true">
                <path d="M10 55 Q30 40 62 18" stroke="rgba(59,130,246,0.35)" stroke-width="2" stroke-dasharray="4 3"/>
                <g transform="translate(58,16) rotate(-30)">
                  <path d="M0 0 L-16 6 L-8 0 L-16 -6 Z" fill="#3b82f6"/>
                  <path d="M-8 0 L-14 -12 L-4 -8 Z" fill="#60a5fa"/>
                  <path d="M-8 0 L-14 12 L-4 8 Z" fill="#60a5fa"/>
                </g>
                <rect x="20" y="10" width="42" height="20" rx="6" fill="rgba(59,130,246,0.15)" stroke="rgba(59,130,246,0.4)" stroke-width="1"/>
                <text x="41" y="24" font-size="11" fill="#60a5fa" font-weight="bold" font-family="monospace" text-anchor="middle">×24.58</text>
                <path d="M8 62 L20 58 L30 52 L40 42 L50 30 L58 18" stroke="rgba(59,130,246,0.6)" stroke-width="2" fill="none"/>
                <path d="M8 62 L20 58 L30 52 L40 42 L50 30 L58 18 L58 62 Z" fill="rgba(59,130,246,0.08)"/>
              </svg>
              <div class="ad-mult">
                <span class="ad-mult-num" style="color:#60a5fa">∞×</span>
                <span class="ad-mult-label">Unlimited Multiplier</span>
              </div>
            </div>
          </div>
        </div>
      </Transition>

      <div class="hero-dots" role="tablist" aria-label="Slide navigation">
        <button
          v-for="(slide, i) in heroSlides"
          :key="slide.id"
          class="dot"
          :class="{ 'dot--active': currentSlide === i }"
          :aria-label="`Go to slide ${i + 1}`"
          role="tab"
          :aria-selected="currentSlide === i"
          @click="goToSlide(i)"
        ></button>
      </div>
    </section>

    <!-- ── PROMO BANNERS ─────────────────────────────────────────── -->
    <div class="max-container promos-row">
      <CashbackBanner />
      <FirstDepositBanner />
    </div>

    <!-- ── FILTER BAR ────────────────────────────────────────────── -->
    <div class="filter-bar">
      <div class="max-container filter-inner">
        <nav class="cat-strip" aria-label="Game categories">
          <button
            v-for="cat in allCategories"
            :key="cat"
            class="cat-pill"
            :class="{ 'cat-pill--active': selectedCategory === cat }"
            @click="selectCategory(cat)"
          >
            <!-- ALL -->
            <svg v-if="cat === 'ALL'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
            <!-- BINGO -->
            <svg v-else-if="cat === 'BINGO'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2" y="2" width="20" height="20" rx="2"/><line x1="8" y1="2" x2="8" y2="22"/><line x1="16" y1="2" x2="16" y2="22"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="2" y1="16" x2="22" y2="16"/>
            </svg>
            <!-- SLOTS -->
            <svg v-else-if="cat === 'SLOTS'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2" y="3" width="20" height="18" rx="2"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="8" rx="1"/><rect x="15" y="7" width="4" height="8" rx="1"/><line x1="2" y1="16" x2="22" y2="16"/>
            </svg>
            <!-- LIVE -->
            <svg v-else-if="cat === 'LIVE'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 000 11.4M17.7 6.3a8 8 0 010 11.4M3.5 3.5a13 13 0 000 17M20.5 3.5a13 13 0 010 17"/>
            </svg>
            <!-- TABLE -->
            <svg v-else-if="cat === 'TABLE'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
            </svg>
            <!-- CRASH -->
            <svg v-else-if="cat === 'CRASH'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <!-- default -->
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
            </svg>
            {{ CATEGORY_LABELS[cat] ?? cat }}
          </button>
          <NuxtLink v-if="tournamentsEnabled" to="/tournaments" class="cat-pill">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M8 3h8v11a4 4 0 01-8 0V3z"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/>
            </svg>
            Tournaments
          </NuxtLink>
        </nav>

        <label class="search-wrap">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search games..."
            class="search-input"
            aria-label="Search games"
          />
        </label>
      </div>
    </div>

    <!-- ── TOP GAMES ROW ─────────────────────────────────────────── -->
    <div class="top-row">
      <div class="max-container">
        <div class="top-row-scroll">

          <!-- Bingo tile -->
          <div class="type-tile type-tile--bingo">
            <div class="tt-thumb">
              <div class="mini-grid" aria-hidden="true">
                <div class="mg-cell">7</div><div class="mg-cell mg-cell--m">23</div><div class="mg-cell">41</div><div class="mg-cell">54</div><div class="mg-cell mg-cell--m">68</div>
                <div class="mg-cell mg-cell--m">12</div><div class="mg-cell">29</div><div class="mg-cell mg-cell--m">43</div><div class="mg-cell">58</div><div class="mg-cell">71</div>
                <div class="mg-cell">3</div><div class="mg-cell mg-cell--m">30</div><div class="mg-cell mg-cell--f">FR</div><div class="mg-cell">60</div><div class="mg-cell mg-cell--m">75</div>
                <div class="mg-cell">14</div><div class="mg-cell">27</div><div class="mg-cell">44</div><div class="mg-cell mg-cell--m">57</div><div class="mg-cell">72</div>
                <div class="mg-cell mg-cell--m">9</div><div class="mg-cell">32</div><div class="mg-cell">46</div><div class="mg-cell">62</div><div class="mg-cell mg-cell--m">74</div>
              </div>
              <div class="tt-live-badge"><span class="live-dot"></span>Live</div>
            </div>
            <div class="tt-label">Bingo</div>
            <div class="tt-meta">
              From {{ gameStore.availableGames.length > 0 ? Math.min(...gameStore.availableGames.map((g: Game) => Number(g.ticketPrice))).toLocaleString() : 10 }} ETB
            </div>
          </div>

          <!-- Third-party games OR Coming Soon tiles -->
          <template v-if="providerStore.games.length">
            <NuxtLink
              v-for="g in providerStore.games.slice(0, 6)"
              :key="g.gameCode"
              :to="`/play/${providerStore.activeProviderCode}/${g.gameCode}`"
              class="type-tile"
            >
              <div class="tt-thumb tt-thumb--provider">
                <img
                  v-if="g.imageSquare || g.imageLandscape"
                  :src="g.imageSquare ?? g.imageLandscape ?? ''"
                  :alt="g.gameName"
                  class="tt-img"
                  loading="lazy"
                />
                <div v-else class="tt-placeholder">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="1.3" aria-hidden="true">
                    <rect x="2" y="3" width="20" height="18" rx="2"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="8" rx="1"/><rect x="15" y="7" width="4" height="8" rx="1"/>
                  </svg>
                </div>
                <div class="tt-cat-badge">{{ g.categoryCode }}</div>
              </div>
              <div class="tt-label">{{ g.gameName }}</div>
              <div class="tt-meta">{{ g.categoryCode }}</div>
            </NuxtLink>
          </template>

          <template v-else-if="!providerStore.games.length">
            <div class="type-tile type-tile--soon">
              <div class="tt-thumb">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
                </svg>
                <div class="tt-soon-badge">Soon</div>
              </div>
              <div class="tt-label">Aviator</div>
              <div class="tt-meta">Coming Soon</div>
            </div>
            <div class="type-tile type-tile--soon">
              <div class="tt-thumb">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="2" y="3" width="20" height="18" rx="2"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="8" rx="1"/><rect x="15" y="7" width="4" height="8" rx="1"/><line x1="2" y1="16" x2="22" y2="16"/>
                </svg>
                <div class="tt-soon-badge">Soon</div>
              </div>
              <div class="tt-label">Slots</div>
              <div class="tt-meta">Coming Soon</div>
            </div>
            <div class="type-tile type-tile--soon">
              <div class="tt-thumb">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/>
                </svg>
                <div class="tt-soon-badge">Soon</div>
              </div>
              <div class="tt-label">Crash</div>
              <div class="tt-meta">Coming Soon</div>
            </div>
            <div class="type-tile type-tile--soon">
              <div class="tt-thumb">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
                </svg>
                <div class="tt-soon-badge">Soon</div>
              </div>
              <div class="tt-label">Table</div>
              <div class="tt-meta">Coming Soon</div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ── PROVIDER GAMES — per-category sections ────────────────── -->
    <template v-if="providerCategories.length">
      <div
        v-for="cat in providerCategories"
        :key="cat"
        v-show="showProviderCategory(cat)"
        class="content-section"
      >
        <div class="max-container">
          <h2 class="section-heading">{{ CATEGORY_LABELS[cat] ?? cat }}</h2>

          <div v-if="categoryGamesLoading[cat]" class="state-msg">
            <span class="spinner" aria-hidden="true"></span> Loading...
          </div>
          <div v-else-if="!categoryGamesMap[cat]?.length" class="state-msg">
            No games available.
          </div>
          <div v-else class="pg-grid">
            <NuxtLink
              v-for="g in categoryGamesMap[cat]"
              :key="g.gameCode"
              :to="`/play/${providerStore.activeProviderCode}/${g.gameCode}`"
              class="pg-card"
            >
              <div class="pg-thumb">
                <img
                  v-if="g.imageSquare || g.imageLandscape"
                  :src="g.imageSquare ?? g.imageLandscape ?? ''"
                  :alt="g.gameName"
                  class="pg-img"
                  loading="lazy"
                />
                <div v-else class="pg-placeholder">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.3" aria-hidden="true">
                    <rect x="2" y="3" width="20" height="18" rx="2"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="8" rx="1"/><rect x="15" y="7" width="4" height="8" rx="1"/>
                  </svg>
                </div>
                <div class="pg-hover">
                  <span class="pg-play">Play</span>
                </div>
              </div>
              <div class="pg-name">{{ g.gameName }}</div>
            </NuxtLink>
          </div>
        </div>
      </div>
    </template>

    <!-- ── BINGO ROOMS ────────────────────────────────────────────── -->
    <div v-if="showBingoSection" id="rooms" class="content-section">
      <div class="max-container">

        <div v-if="gameStore.loadingGames" class="state-msg">
          <span class="spinner" aria-hidden="true"></span> Loading games...
        </div>
        <div v-else-if="gameStore.error" class="state-msg state-msg--error">
          Could not load games.
          <button class="retry-btn" @click="gameStore.fetchAvailableGames()">Retry</button>
        </div>
        <div v-else-if="!filteredGames.length" class="state-msg">
          {{ searchQuery ? 'No games match your search.' : 'No games available right now. Check back soon.' }}
        </div>

        <template v-else>
          <h2 class="section-heading">Bingo Rooms</h2>
          <div class="rooms-grid">
            <div
              v-for="(game, idx) in filteredGames"
              :key="game.id"
              class="room-tile"
              :style="{ '--delay': `${idx * 50}ms` }"
            >
              <!-- Thumbnail area -->
              <div class="rt-thumb">
                <!-- Status badge -->
                <div v-if="game.status !== 'WAITING'" class="rt-badge rt-badge--live">
                  <span class="live-dot-sm"></span> Live
                </div>
                <div v-else-if="gameStore.countdowns[game.id]" class="rt-badge rt-badge--timer">
                  <GameCountdown :starts-at="gameStore.countdowns[game.id]" compact />
                </div>
                <div v-else class="rt-badge rt-badge--timer">1:00</div>

                <!-- Pattern badge -->
                <div class="rt-pattern">{{ patternLabel(game.pattern) }}</div>

                <!-- Price -->
                <div class="rt-price-wrap">
                  <span class="rt-price">{{ Number(game.ticketPrice).toLocaleString() }}</span>
                  <span class="rt-currency">ETB</span>
                </div>
              </div>

              <!-- Footer -->
              <div class="rt-footer">
                <div class="rt-players">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
                  </svg>
                  {{ gameStore.livePlayers[game.id] ?? (game as any).currentPlayers ?? 0 }}<span class="rt-slash">/</span>{{ (game as any).maxPlayers ?? 10 }}
                </div>
                <button
                  v-if="game.status === 'WAITING'"
                  class="rt-join"
                  @click="handleJoinGame(game.id)"
                >
                  Join
                </button>
                <div v-else class="rt-join rt-join--live">
                  {{ game.status === 'STARTING' ? 'Starting' : 'Live' }}
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <AuthPromptModal v-model="showAuthPrompt" />
  </div>
</template>

<style scoped>
/* ── Page ─────────────────────────────────────────────────────────────── */
.lobby-page {
  min-height: 100vh;
  background: var(--surface-base);
  font-family: var(--font-body);
  padding-bottom: 48px;
}

.max-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 20px;
}

/* ── HERO ──────────────────────────────────────────────────────────────── */
.hero {
  position: relative;
  overflow: hidden;
  background: linear-gradient(150deg, #020b20 0%, #061535 55%, #0c2248 100%);
  /* Fixed height so all slides are identical — no layout shift on transition */
  height: 320px;
  display: flex;
  flex-direction: column;
}

@media (max-width: 620px) {
  .hero { height: 240px; }
}

.hero-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 50% 80% at 72% 50%, rgba(245, 158, 11, 0.07) 0%, transparent 65%),
    radial-gradient(ellipse 35% 55% at 15% 40%, rgba(6, 182, 212, 0.05) 0%, transparent 60%);
  pointer-events: none;
}

.hero-inner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex: 1;
  padding-top: 28px;
  padding-bottom: 12px;
  gap: 32px;
}

.hero-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hero-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(255, 255, 255, 0.55);
  margin: 0;
}

.eyebrow-dot {
  width: 6px;
  height: 6px;
  background: var(--brand-primary);
  border-radius: 50%;
  flex-shrink: 0;
  animation: pulse-dot 2s infinite;
}

.hero-title {
  font-family: 'Rajdhani', sans-serif;
  font-size: clamp(34px, 6.5vw, 50px);
  font-weight: 700;
  color: #f0f4ff;
  line-height: 1.05;
  margin: 0;
}

.hero-accent { color: var(--brand-primary); }

.hero-sub {
  font-size: 14px;
  color: rgba(180, 205, 240, 0.65);
  margin: 0;
  line-height: 1.6;
  max-width: 360px;
}

.hero-cta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--brand-primary);
  color: #0a0f1a;
  font-weight: 800;
  font-size: 14px;
  padding: 11px 22px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  width: fit-content;
  font-family: var(--font-body);
  transition: background 0.15s ease, transform 0.15s ease;
}
.hero-cta:hover { background: #fbbf24; transform: translateY(-1px); }
.hero-cta:active { transform: translateY(0); }
.hero-cta:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 3px; }
.hero-cta--muted {
  background: rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.45);
  cursor: default;
}
.hero-cta--muted:hover { background: rgba(255,255,255,0.08); transform: none; }

/* ── HERO ART ────────────────────────────────────────────────────────── */
.hero-art {
  flex-shrink: 0;
  position: relative;
  height: 200px;
  width: 250px;
}

.hero-art--centered {
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 620px) { .hero-art { display: none; } }

.bingo-card {
  position: absolute;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 3px;
  padding: 8px;
  border-radius: 10px;
}
.bingo-card--front {
  width: 145px;
  right: 85px;
  top: 10px;
  transform: rotate(-5deg);
  z-index: 2;
  border: 1px solid rgba(245, 158, 11, 0.4);
  background: rgba(0, 0, 0, 0.4);
  box-shadow: 0 0 20px rgba(245, 158, 11, 0.1);
}
.bingo-card--back {
  width: 115px;
  right: 6px;
  top: 45px;
  transform: rotate(4deg);
  opacity: 0.35;
  z-index: 1;
  border: 1px solid rgba(6, 182, 212, 0.35);
  background: rgba(0, 0, 0, 0.3);
}
.bc-cell {
  aspect-ratio: 1;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  font-size: 8px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Rajdhani', sans-serif;
}
.bc-cell--blue { background: var(--accent-dim); color: rgba(255,255,255,0.9); }
.bc-cell--gold { background: rgba(245,158,11,0.25); color: var(--brand-primary); }
.bc-cell--free { background: var(--brand-primary); color: #0a0f1a; font-size: 5px; font-weight: 900; }

/* ── FEATURED CARD ───────────────────────────────────────────────────── */
.featured-card {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 16px;
  padding: 24px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 210px;
}
.fc-eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--brand-primary);
}
.fc-title { font-size: 20px; font-weight: 800; color: #f0f4ff; line-height: 1.2; }
.fc-price {
  font-family: 'Rajdhani', sans-serif;
  font-size: 30px;
  font-weight: 900;
  color: var(--brand-primary);
  line-height: 1;
}
.fc-currency { font-size: 15px; font-weight: 700; color: rgba(245,158,11,0.65); }
.fc-meta { font-size: 12px; color: rgba(255,255,255,0.45); font-weight: 600; }
.fc-join {
  display: inline-flex;
  align-items: center;
  background: var(--brand-primary);
  color: #0a0f1a;
  font-weight: 800;
  font-size: 13px;
  padding: 9px 18px;
  min-height: 44px;
  border-radius: 8px;
  text-decoration: none;
  align-self: flex-start;
  transition: background 0.15s ease, transform 0.15s ease;
}
.fc-join:hover { background: #fbbf24; transform: translateY(-1px); }
.fc-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #34d399;
  font-weight: 700;
  font-size: 13px;
}

/* ── AD CARD ─────────────────────────────────────────────────────────── */
.ad-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 16px;
  padding: 24px 28px;
  min-width: 185px;
}
.ad-mult {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.ad-mult-num {
  font-family: 'Rajdhani', sans-serif;
  font-size: 34px;
  font-weight: 900;
  line-height: 1;
}
.ad-mult-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.4);
}

/* ── HERO ARROWS ─────────────────────────────────────────────────────── */
.hero-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
}
.hero-arrow:hover {
  background: rgba(255,255,255,0.14);
  color: #fff;
  transform: translateY(-50%) scale(1.08);
}
.hero-arrow:active { transform: translateY(-50%) scale(0.96); }
.hero-arrow:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }
.hero-arrow--prev { left: 16px; }
.hero-arrow--next { right: 16px; }

@media (max-width: 640px) { .hero-arrow { display: none; } }

/* ── HERO DOTS ───────────────────────────────────────────────────────── */
.hero-dots {
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: center;
  gap: 5px;
  padding: 10px 0 14px;
  flex-shrink: 0;
}
.hero-dots button {
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  transition: background 0.2s ease, width 0.2s ease;
}
.dot:hover { background: rgba(255,255,255,0.4); }
.dot--active { background: var(--brand-primary); width: 18px; border-radius: 3px; }

/* ── HERO TRANSITION ─────────────────────────────────────────────────── */
/* The Transition wrapper becomes a block child — make it fill flex space */
.hero > .hero-fade-enter-active,
.hero > .hero-fade-leave-active,
.hero-inner { flex: 1; }

.hero-fade-enter-active,
.hero-fade-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; display: flex; flex: 1; }
.hero-fade-enter-from { opacity: 0; transform: translateX(20px); }
.hero-fade-leave-to   { opacity: 0; transform: translateX(-20px); }

/* ── PROMOS ──────────────────────────────────────────────────────────── */
.promos-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  padding-bottom: 4px;
}

/* ── FILTER BAR ──────────────────────────────────────────────────────── */
.filter-bar {
  position: sticky;
  top: 0;
  z-index: 40;
  background: rgba(6, 14, 36, 0.95);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.filter-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
}

.cat-strip {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
  min-width: 0;
  padding: 10px 0;
}
.cat-strip::-webkit-scrollbar { display: none; }

.cat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.5);
  background: none;
  border: none;
  cursor: pointer;
  white-space: nowrap;
  font-family: var(--font-body);
  transition: color 0.15s ease, background 0.15s ease;
  text-decoration: none;
  flex-shrink: 0;
}
.cat-pill svg { opacity: 0.6; flex-shrink: 0; }
.cat-pill:hover { color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.05); }
.cat-pill:hover svg { opacity: 0.85; }
.cat-pill--active { color: var(--brand-primary); background: rgba(245,158,11,0.1); }
.cat-pill--active svg { opacity: 1; color: var(--brand-primary); }
.cat-pill:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: -2px; border-radius: 6px; }

.search-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 7px;
  padding: 7px 12px;
  color: rgba(255,255,255,0.3);
  cursor: text;
  flex-shrink: 0;
  transition: border-color 0.15s ease;
}
.search-wrap:focus-within { border-color: rgba(245,158,11,0.35); }
.search-input {
  background: none;
  border: none;
  outline: none;
  color: rgba(255,255,255,0.75);
  font-size: 13px;
  font-family: var(--font-body);
  width: 160px;
}
.search-input::placeholder { color: rgba(255,255,255,0.3); }

@media (max-width: 560px) { .search-wrap { display: none; } }

/* ── TOP GAMES ROW ───────────────────────────────────────────────────── */
.top-row {
  padding: 16px 0 0;
}

.top-row-scroll {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  margin: 0 -20px;
  padding: 0 20px 12px;
}
.top-row-scroll::-webkit-scrollbar { display: none; }

.type-tile {
  width: 160px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.07);
  background: rgba(10, 22, 55, 0.75);
  cursor: pointer;
  text-decoration: none;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.type-tile:hover { transform: translateY(-2px); border-color: rgba(245,158,11,0.25); }
.type-tile:active { transform: translateY(0); }
.type-tile--soon { cursor: default; }
.type-tile--soon:hover { transform: none; border-color: rgba(255,255,255,0.07); }

.tt-thumb {
  height: 110px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(145deg, #0d2050, #1a3870);
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.tt-thumb--provider {
  background: #0d2050;
  overflow: hidden;
}
.tt-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tt-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.type-tile--bingo .tt-thumb { background: linear-gradient(145deg, #091840, #142e62); }

.mini-grid {
  width: 82px;
  padding: 5px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 7px;
  border: 1px solid rgba(245, 158, 11, 0.2);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 2px;
}
.mg-cell {
  aspect-ratio: 1;
  border-radius: 2px;
  background: rgba(255,255,255,0.05);
  font-size: 6.5px;
  font-weight: 700;
  color: rgba(255,255,255,0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Rajdhani', sans-serif;
}
.mg-cell--m { background: var(--accent-dim); color: rgba(255,255,255,0.9); }
.mg-cell--f { background: var(--brand-primary); color: #0a0f1a; font-size: 5px; font-weight: 900; }

.tt-live-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: #dc2626;
  color: #fff;
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 9px;
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: 4px;
  letter-spacing: 0.03em;
}

.tt-cat-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0,0,0,0.55);
  border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.75);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.tt-soon-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(124, 58, 237, 0.18);
  border: 1px solid rgba(139,92,246,0.3);
  color: #c4b5fd;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.tt-label {
  padding: 8px 10px 2px;
  font-family: 'Rajdhani', sans-serif;
  font-size: 14px;
  font-weight: 700;
  color: #e8eef8;
}
.tt-meta {
  padding: 0 10px 9px;
  font-size: 11px;
  color: rgba(255,255,255,0.38);
}

/* ── CONTENT SECTIONS ────────────────────────────────────────────────── */
.content-section {
  padding: 20px 0 0;
}

.section-heading {
  font-family: 'Rajdhani', sans-serif;
  font-size: 17px;
  font-weight: 700;
  color: #e0e8f8;
  letter-spacing: 0.01em;
  margin: 0 0 14px;
}

/* ── PROVIDER GAME GRID ──────────────────────────────────────────────── */
.pg-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  padding-bottom: 4px;
}
@media (min-width: 480px) { .pg-grid { grid-template-columns: repeat(4, 1fr); } }
@media (min-width: 640px) { .pg-grid { grid-template-columns: repeat(5, 1fr); } }
@media (min-width: 900px) { .pg-grid { grid-template-columns: repeat(7, 1fr); } }
@media (min-width: 1200px) { .pg-grid { grid-template-columns: repeat(9, 1fr); } }

.pg-card {
  border-radius: 8px;
  overflow: hidden;
  background: rgba(10, 22, 55, 0.7);
  border: 1px solid rgba(255,255,255,0.06);
  text-decoration: none;
  transition: transform 0.15s ease, border-color 0.15s ease;
  cursor: pointer;
}
.pg-card:hover { transform: translateY(-2px); border-color: rgba(245,158,11,0.2); }
.pg-card:active { transform: translateY(0); }

.pg-thumb {
  aspect-ratio: 3/4;
  position: relative;
  overflow: hidden;
  background: linear-gradient(145deg, #0d2050, #1a3870);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pg-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pg-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }

.pg-hover {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.pg-card:hover .pg-hover { opacity: 1; }

.pg-play {
  background: var(--brand-primary);
  color: #0a0f1a;
  font-weight: 800;
  font-size: 12px;
  padding: 7px 18px;
  border-radius: 6px;
}

.pg-name {
  padding: 7px 9px 8px;
  font-family: 'Rajdhani', sans-serif;
  font-size: 12px;
  font-weight: 700;
  color: #c8d4e8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── BINGO ROOMS GRID ────────────────────────────────────────────────── */
.rooms-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  padding-bottom: 8px;
}
@media (min-width: 560px) { .rooms-grid { grid-template-columns: repeat(3, 1fr); } }
@media (min-width: 800px) { .rooms-grid { grid-template-columns: repeat(4, 1fr); } }
@media (min-width: 1100px) { .rooms-grid { grid-template-columns: repeat(5, 1fr); } }
@media (min-width: 1400px) { .rooms-grid { grid-template-columns: repeat(6, 1fr); } }

/* ── ROOM TILE ───────────────────────────────────────────────────────── */
.room-tile {
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.07);
  background: rgba(10, 22, 55, 0.75);
  animation: fadeUp 0.3s ease both;
  animation-delay: var(--delay, 0ms);
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.room-tile:hover {
  transform: translateY(-2px);
  border-color: rgba(245,158,11,0.22);
}
.room-tile:active { transform: translateY(0); }

/* Thumbnail */
.rt-thumb {
  position: relative;
  padding: 28px 16px 24px;
  background: linear-gradient(155deg, #091840 0%, #142e62 100%);
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  min-height: 120px;
}

.rt-badge {
  position: absolute;
  top: 9px;
  left: 9px;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.03em;
  display: flex;
  align-items: center;
  gap: 4px;
}
.rt-badge--live {
  background: #dc2626;
  color: #fff;
}
.rt-badge--timer {
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: var(--brand-primary);
  font-family: 'Rajdhani', sans-serif;
  font-size: 13px;
}

.rt-pattern {
  position: absolute;
  top: 9px;
  right: 9px;
  background: rgba(6, 182, 212, 0.1);
  border: 1px solid rgba(6, 182, 212, 0.22);
  color: #22d3ee;
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.rt-price-wrap {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.rt-price {
  font-family: 'Rajdhani', sans-serif;
  font-size: clamp(26px, 4vw, 32px);
  font-weight: 700;
  color: #f0f4ff;
  line-height: 1;
}
.rt-currency {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255,255,255,0.4);
}

/* Footer */
.rt-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
}

.rt-players {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: rgba(255,255,255,0.45);
  font-weight: 600;
}
.rt-slash { color: rgba(255,255,255,0.2); margin: 0 1px; }

.rt-join {
  background: var(--brand-primary);
  color: #0a0f1a;
  border: none;
  border-radius: 6px;
  padding: 7px 14px;
  min-height: 34px;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  text-decoration: none;
  font-family: var(--font-body);
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.15s ease;
  display: inline-flex;
  align-items: center;
}
.rt-join:hover:not(.rt-join--live) { background: #fbbf24; }
.rt-join:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 3px; }
.rt-join--live {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: #34d399;
  cursor: default;
  font-size: 11px;
}

/* ── STATE MESSAGES ──────────────────────────────────────────────────── */
.state-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255,255,255,0.4);
  padding: 3rem 0;
  font-size: 14px;
  text-align: center;
}
.state-msg--error { flex-direction: column; color: #f87171; }

.retry-btn {
  padding: 6px 16px;
  border-radius: 7px;
  background: transparent;
  border: 1px solid rgba(245,158,11,0.35);
  color: var(--brand-primary);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  font-family: var(--font-body);
  transition: background 0.15s ease;
}
.retry-btn:hover { background: rgba(245,158,11,0.08); }
.retry-btn:focus-visible { outline: 2px solid var(--brand-primary); outline-offset: 2px; }

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255,255,255,0.08);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

/* ── LIVE DOTS ───────────────────────────────────────────────────────── */
.live-dot {
  width: 5px;
  height: 5px;
  background: #fff;
  border-radius: 50%;
  animation: blink 1.2s infinite;
  flex-shrink: 0;
}
.live-dot-sm {
  width: 6px;
  height: 6px;
  background: #fff;
  border-radius: 50%;
  animation: blink 1.2s infinite;
  flex-shrink: 0;
}

/* ── KEYFRAMES ───────────────────────────────────────────────────────── */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.25; }
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}
</style>
