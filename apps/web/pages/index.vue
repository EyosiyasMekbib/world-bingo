<script setup lang="ts">
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import { useProviderGamesStore } from '~/store/provider-games'
import type { ProviderGame } from '~/store/provider-games'
import { usePromotionsStore } from '~/store/promotions'
import { heroArtworkFor, type HeroAction, type HeroArtwork } from '~/utils/hero-artwork'
import { launchProviderFor } from '~/utils/provider-launch'
import { expiresTonight } from '~/utils/bonus-expiry'
import {
  HERO_BANNER_FETCH_TIMEOUT_MS,
  HERO_BANNER_MOBILE_MEDIA,
  HERO_BANNER_MODE_STORAGE_KEY,
  heroBannerAspectRatio,
  parseHeroBanners,
  parseStoredHeroBannerMode,
  resolveHeroBannerMode,
  type HeroBannerSlide,
} from '~/utils/hero-banners'
import type { Game } from '@world-bingo/shared-types'

const auth = useAuthStore()
const gameStore = useGameStore()
const providerStore = useProviderGamesStore()
const promotionsStore = usePromotionsStore()
const { socket, connect } = useSocket()
const config = useRuntimeConfig()
const { patternLabel } = usePatternLabel()
const { track } = useAnalytics()
const { flags } = useFeatureFlags()
const brand = useBrand()
const { t } = useI18n()

/** Gates the fight-markets hero slide and the lobby entry point. */
const predictionsEnabled = computed(() => flags.value.feature_prediction_market === true)

const showAuthPrompt = ref(false)
// The lobby's Deposit CTA used to navigate to /wallet; the balance chip and
// the shells open the modal in place, so this does too.
const { showDeposit } = useAppShell()

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

/* ── Hero carousel (admin banners, else coded slides) ───────────────────── */
interface HeroSlide {
  id: string
  cta: string
  action: HeroAction
  /**
   * Artwork slide. When set, the banner renders full-bleed and the coded
   * fields below are ignored — these designs carry their own typography, so
   * overlaying our text on them would double up.
   * The per-brand artwork list lives in utils/hero-artwork.ts.
   */
  image?: HeroArtwork['image']
  /* Coded slide. Required unless `image` is set. */
  badge?: string
  title?: string
  sub?: string
  watermark?: string
  gradient?: string
  accent?: string
}

/**
 * The fight-markets slide. Only ever shown when
 * `feature_prediction_market` is on — advertising a tab that 404s would be
 * worse than not advertising it at all.
 *
 * Deliberately not amber: every other surface on this page is the brand colour,
 * so a distinct crimson is what makes this read as a new thing rather than as
 * another bonus banner.
 */
const PREDICTION_SLIDE: HeroSlide = {
  id: 'predictions',
  badge: 'ETFC Fight Night',
  title: 'Back A Fighter —\n100 ETB A Share',
  sub: 'Buy a share in who you think wins. The price you pay is the odds, and you trade against other players — never the house.',
  cta: 'Open Fight Markets',
  watermark: 'VS',
  gradient: 'linear-gradient(105deg,#2a0a12 0%,#4a0f1e 45%,#6d1528 100%)',
  accent: '#fb7185',
  action: 'predictions',
}

const BASE_SLIDES: HeroSlide[] = [
  {
    id: 'aviator',
    badge: 'High Flyer',
    title: 'Aviator — Cash\nOut Before It Flies',
    sub: 'Watch the multiplier climb and grab your winnings before the plane takes off into the clouds.',
    cta: 'Fly Now',
    watermark: 'X10',
    gradient: 'linear-gradient(105deg,#0a2c22 0%,#0e3a2c 45%,#0f5346 100%)',
    accent: '#34d399',
    action: 'aviator',
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

/**
 * The fight slide leads when the feature is live — it is the newest thing on the
 * platform and the only one with a deadline, so it earns the first impression
 * over an evergreen bonus offer.
 */
/**
 * Artwork and banner slides whose file failed to load. A missing or misnamed
 * upload must not leave a broken image sitting in the first slot of the hero,
 * so the slide drops out of rotation instead — the coded slides always remain.
 */
const brokenSlides = ref(new Set<string>())
// The id comes from the failing element, not activeSlide: an image that errors
// after the carousel has moved on must drop its own slide, not the one on screen.
function onSlideImageError(event: Event) {
  const id = (event.target as HTMLElement | null)?.dataset.slideId
  if (id) brokenSlides.value = new Set(brokenSlides.value).add(id)
}

/**
 * Admin-managed banners (GET /hero-banners). null until the request settles, so
 * the hero holds a placeholder rather than flashing the coded slides first —
 * unless this browser's last visit found no banners, in which case the coded
 * slides show at once. Any usable banner replaces the coded hero; none, or a
 * failed request, keeps it.
 */
const heroBanners = ref<HeroBannerSlide[] | null>(null)
const lastHeroBannerMode = readStoredHeroBannerMode()
const heroBannerMode = computed(() =>
  resolveHeroBannerMode(heroBanners.value, brokenSlides.value, lastHeroBannerMode),
)

function readStoredHeroBannerMode() {
  if (!import.meta.client) return null
  try {
    return parseStoredHeroBannerMode(localStorage.getItem(HERO_BANNER_MODE_STORAGE_KEY))
  } catch {
    return null
  }
}

async function loadHeroBanners() {
  try {
    const body = await $fetch<unknown>(`${config.public.apiBase}/hero-banners`, {
      timeout: HERO_BANNER_FETCH_TIMEOUT_MS,
      retry: 0,
    })
    heroBanners.value = parseHeroBanners(body)
    try {
      localStorage.setItem(HERO_BANNER_MODE_STORAGE_KEY, heroBanners.value.length > 0 ? 'banners' : 'fallback')
    } catch { /* storage blocked */ }
  } catch {
    heroBanners.value = []
  }
}

// Sized from the same media query the banner's <source> uses, so the box ratio
// always matches the image the browser picked.
const heroBannerViewport = import.meta.client ? window.matchMedia(HERO_BANNER_MOBILE_MEDIA) : null
const heroBannerIsMobile = ref(heroBannerViewport?.matches ?? false)
function syncHeroBannerViewport() {
  heroBannerIsMobile.value = heroBannerViewport?.matches ?? false
}
const heroBannerBoxStyle = computed(() => ({
  '--hero-banner-ratio': heroBannerAspectRatio(heroBannerIsMobile.value ? 'mobile' : 'desktop'),
}))

type LobbyHeroSlide = (HeroSlide & { banner?: undefined }) | { id: string; banner: HeroBannerSlide }

const heroSlides = computed<LobbyHeroSlide[]>(() => {
  const mode = heroBannerMode.value
  if (mode.kind === 'loading') return []
  if (mode.kind === 'banners') return mode.slides.map((banner) => ({ id: banner.id, banner }))
  // Artwork carries its brand in the pixels, so only the deployment it was drawn
  // for gets it. Brands with none run on the coded slides alone.
  const art = heroArtworkFor(brand.value.themeId).filter((s) => !brokenSlides.value.has(s.id))
  return predictionsEnabled.value
    ? [...art, PREDICTION_SLIDE, ...BASE_SLIDES]
    : [...art, ...BASE_SLIDES]
})

const currentSlide = ref(0)

/**
 * The slide list changes length when the flag resolves, when banners arrive, and
 * when a banner image fails, all after first paint. Without this the index can
 * point past the end of the array and `activeSlide` reads undefined, which
 * blanks the whole hero.
 */
watch(
  () => heroSlides.value.length,
  (len) => {
    if (!(currentSlide.value < len)) currentSlide.value = 0
  },
)

// Undefined only while banners load, when the template shows the placeholder.
const activeSlide = computed(() => heroSlides.value[currentSlide.value] ?? heroSlides.value[0])
let slideTimer: ReturnType<typeof setInterval> | null = null

function goToSlide(idx: number) {
  currentSlide.value = idx
  if (slideTimer) clearInterval(slideTimer)
  startSlideTimer()
}
function prevSlide() {
  const len = heroSlides.value.length
  if (len > 1) goToSlide((currentSlide.value - 1 + len) % len)
}
function nextSlide() {
  const len = heroSlides.value.length
  if (len > 1) goToSlide((currentSlide.value + 1) % len)
}
function startSlideTimer() {
  slideTimer = setInterval(() => {
    const len = heroSlides.value.length
    if (len > 1) currentSlide.value = (currentSlide.value + 1) % len
  }, 6000)
}

function trackHeroBannerClick(id: string) {
  track('hero_banner_click', { banner_id: id })
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

function heroAction(slide: HeroSlide) {
  const action = slide.action
  if (action === 'predictions') {
    track('hero_predictions_click')
    navigateTo('/predictions')
  } else if (action === 'aviator') {
    // Into the game itself, via the same resolver as the Aviator nav tab.
    navigateTo('/aviator')
  } else if (action === 'rooms') {
    document.getElementById('games-grid')?.scrollIntoView({ behavior: 'smooth' })
    selectCategory('BINGO')
  } else if (action === 'promotions') {
    navigateTo('/promotions')
  } else if (action === 'deposit') {
    if (!auth.isAuthenticated) showAuthPrompt.value = true
    else showDeposit.value = true
  } else {
    navigateTo('/games')
  }
}

/* ── Bonus expiry bar ───────────────────────────────────────────────────── */
/** Mirrors GET /wallet/bonus-grants (see BonusGrantQueryService). */
interface ActiveBonusGrant {
  id: string
  amount: number
  remaining: number
  expiresAt: string | null
  ruleName: string | null
  createdAt: string
}

/** A lot inside its last day is the only one worth interrupting the lobby for. */
const BONUS_EXPIRY_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Wording for a deadline inside the day but outside tonight. The wallet nudge
 * makes the same call off the same shared `expiresTonight`, so the two surfaces
 * cannot describe one lot two ways.
 */
const EXPIRY_WITHIN_DAY_KEY = 'promo.expiry_headline_within_day'

const bonusGrants = ref<ActiveBonusGrant[]>([])
// Drives the countdown, and with it the 24h window itself — a lot that crosses
// into its final day while the lobby sits open surfaces without a reload.
const nowMs = ref(Date.now())
let bonusTicker: ReturnType<typeof setInterval> | null = null
let bonusWindowTimer: ReturnType<typeof setTimeout> | null = null

async function loadBonusGrants() {
  if (!auth.isAuthenticated) return
  try {
    bonusGrants.value = await auth.apiFetch<ActiveBonusGrant[]>('/wallet/bonus-grants')
  } catch {
    // The bar is a nudge, not the wallet — a failed request just leaves it hidden.
  }
}

/**
 * Every lot that still holds value and dies inside the window, not only the
 * first one: the wallet nudge sums the same set, and a player told 300 here and
 * 800 there learns nothing except that one of the two is lying. What is at risk
 * is the total.
 */
const expiringLots = computed(() => {
  const lots: { at: number; remaining: number }[] = []
  for (const g of bonusGrants.value) {
    const remaining = Number(g.remaining)
    if (!g.expiresAt || remaining <= 0) continue
    const at = new Date(g.expiresAt).getTime()
    const left = at - nowMs.value
    if (left <= 0 || left > BONUS_EXPIRY_WINDOW_MS) continue
    lots.push({ at, remaining })
  }
  return lots
})

/** The soonest of them: one clock cannot run two deadlines. */
const expiringDeadline = computed(() => {
  let soonest: number | null = null
  for (const lot of expiringLots.value) {
    if (soonest === null || lot.at < soonest) soonest = lot.at
  }
  return soonest
})

/** The soonest lot still beyond the window — what the wake below waits on. */
const nextBonusWindowEntry = computed(() => {
  let soonest: number | null = null
  for (const g of bonusGrants.value) {
    if (!g.expiresAt || Number(g.remaining) <= 0) continue
    const at = new Date(g.expiresAt).getTime()
    if (at - nowMs.value <= BONUS_EXPIRY_WINDOW_MS) continue
    if (soonest === null || at < soonest) soonest = at
  }
  return soonest
})

const spendAccount = computed(() => auth.wallet?.spendAccount ?? 'REAL')

// Spending bonus already is the outcome the bar asks for, so once the wallet is
// set that way the warning has lost its premise and would only nag.
const showBonusExpiry = computed(
  () => expiringLots.value.length > 0 && spendAccount.value === 'REAL',
)

// The headline carries no currency of its own, so the amount arrives with one.
const expiringAmount = computed(() => {
  const total = expiringLots.value.reduce((sum, lot) => sum + lot.remaining, 0)
  return `${total.toLocaleString('en-ET', { maximumFractionDigits: 2 })} ${t('common.etb')}`
})

const expiringHeadlineKey = computed(() => {
  const at = expiringDeadline.value
  if (at === null || expiresTonight(at, nowMs.value)) return 'promo.expiry_headline'
  return EXPIRY_WITHIN_DAY_KEY
})

const expiringCountdown = computed(() => {
  const at = expiringDeadline.value
  if (at === null) return '00:00:00'
  const secs = Math.max(0, Math.floor((at - nowMs.value) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`
})

const switchingSpendAccount = ref(false)

async function spendBonusFirst() {
  if (switchingSpendAccount.value) return
  switchingSpendAccount.value = true
  try {
    await auth.apiFetch('/wallet/spend-account', { method: 'PATCH', body: { account: 'BONUS' } })
    await auth.fetchWallet()
  } catch {
    // Leaving the bar up is the honest failure: the bonus is still at risk.
  } finally {
    switchingSpendAccount.value = false
  }
}

// The ticker only exists while a bar is on screen counting down — a signed-out
// visitor, or a player holding a 30-day lot, should not have a phone waking once
// a second for a clock nobody is looking at.
watch(
  () => expiringLots.value.length > 0,
  (counting) => {
    if (counting && !bonusTicker) {
      bonusTicker = setInterval(() => {
        nowMs.value = Date.now()
      }, 1000)
    } else if (!counting && bonusTicker) {
      clearInterval(bonusTicker)
      bonusTicker = null
    }
  },
)

// Which leaves nothing watching the clock before the bar is due, so a lot still
// outside the window books one wake of its own for the moment it crosses in —
// otherwise a lobby left open would hold the bar back until a reload.
watch(
  () => nextBonusWindowEntry.value,
  (at) => {
    if (bonusWindowTimer) clearTimeout(bonusWindowTimer)
    bonusWindowTimer = null
    if (at === null) return
    const delay = Math.max(0, at - BONUS_EXPIRY_WINDOW_MS - Date.now())
    // A crossing further out than a day is left to the next page load: no lobby
    // stays open that long, and setTimeout cannot hold an arbitrary wait anyway.
    if (delay > BONUS_EXPIRY_WINDOW_MS) return
    bonusWindowTimer = setTimeout(() => {
      nowMs.value = Date.now()
    }, delay)
  },
)

/* ── Offer carousel ─────────────────────────────────────────────────────── */
/**
 * The promo tile is a fixed 225x75 (300x100 on a phone), not a fraction of the
 * row, so a page is however many whole tiles fit rather than the row's own
 * width — stepping by the latter would strand the scroll mid-tile and fight the
 * snap points. Everything here is measured from the rendered row so the phone
 * and desktop sizes need no second source of truth.
 */
const offerRow = ref<HTMLElement | null>(null)
const offerPage = ref(0)
const offerStep = ref(0)
const offersPerPage = ref(5)
/**
 * The row's real travel, read off the element. A page is a page wide only up to
 * the last one, whose travel is whatever remainder is left — a sixth tile in a
 * five-tile row scrolls 6px, not 1205 — so the dots and the arrows come from
 * this and never from a count of tiles over a page width the row never reaches.
 */
const offerScrollLeft = ref(0)
const offerScrollMax = ref(0)
/** Fractional tile widths leave a pixel of overflow, which is not a page. */
const OFFER_SCROLL_EPS = 1

const offerPhoneViewport = import.meta.client ? window.matchMedia('(max-width: 720px)') : null
const offerTileSize = ref<'carousel' | 'phone'>(offerPhoneViewport?.matches ? 'phone' : 'carousel')

const offerPageWidth = computed(() => offerStep.value * offersPerPage.value)

const offerPageCount = computed(() => {
  if (offerPageWidth.value <= 0 || offerScrollMax.value <= OFFER_SCROLL_EPS) return 1
  return 1 + Math.ceil(offerScrollMax.value / offerPageWidth.value)
})

// Disabled on the position rather than on the page, so each arrow is dead exactly
// when the row has nothing left that way.
const offerAtStart = computed(() => offerScrollLeft.value <= OFFER_SCROLL_EPS)
const offerAtEnd = computed(() => offerScrollLeft.value >= offerScrollMax.value - OFFER_SCROLL_EPS)

function measureOfferRow() {
  const row = offerRow.value
  const tile = row?.firstElementChild as HTMLElement | null
  if (!row || !tile) return
  const cs = getComputedStyle(row)
  const gap = parseFloat(cs.columnGap) || 0
  const inner =
    row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  offerStep.value = tile.offsetWidth + gap
  // n tiles occupy n*step - gap, so the gap comes back before the division.
  if (offerStep.value > 0) {
    offersPerPage.value = Math.max(1, Math.floor((inner + gap) / offerStep.value))
  }
  syncOfferPage()
}

function scrollOffers(dir: 1 | -1) {
  const row = offerRow.value
  if (!row || offerPageWidth.value <= 0) return
  row.scrollBy({ left: dir * offerPageWidth.value, behavior: 'smooth' })
}

// Keeps the dots honest when the row is swiped or trackpad-scrolled rather than
// stepped with the buttons. The stops sit a page apart except for the last, which
// lands wherever the travel ran out, so the position is matched against that stop
// instead of divided by a page width the row can never scroll to.
function syncOfferPage() {
  const row = offerRow.value
  if (!row) return
  offerScrollLeft.value = row.scrollLeft
  offerScrollMax.value = Math.max(0, row.scrollWidth - row.clientWidth)
  const last = offerPageCount.value - 1
  if (last <= 0) {
    offerPage.value = 0
    return
  }
  const beforeLast = (last - 1) * offerPageWidth.value
  const lastStopMid = beforeLast + (offerScrollMax.value - beforeLast) / 2
  offerPage.value =
    offerScrollLeft.value >= lastStopMid
      ? last
      : Math.max(0, Math.min(last - 1, Math.round(offerScrollLeft.value / offerPageWidth.value)))
}

function onOfferResize() {
  offerTileSize.value = offerPhoneViewport?.matches ? 'phone' : 'carousel'
  // The size prop re-renders the tiles at a new width; measure once that lands.
  nextTick(measureOfferRow)
}

watch(
  () => promotionsStore.promotions.length,
  () => nextTick(measureOfferRow),
)

// Both surfaces are per-player, and the lobby is where signing in happens (the
// balance chip's modal), so neither exists until it does.
watch(
  () => auth.isAuthenticated,
  (signedIn) => {
    if (!signedIn) {
      bonusGrants.value = []
      return
    }
    loadBonusGrants()
    promotionsStore.fetchProgress()
  },
)

/* ── Vendor / provider chips ────────────────────────────────────────────── */
const STATIC_VENDORS = [
  '1x2 Network', '3 Oaks Gaming', '7Mojos', '7Mojos Live', 'AGT Software',
  'ATLAS V2', 'Absolute', 'Ad Lunam', 'Amigo Gaming', 'Amusnet', 'Amusnet Live',
]
const activeVendor = ref('ALL')

const vendorsAreReal = computed(() =>
  providerStore.games.some((g) => g.vendorCode || g.providerName),
)

// One chip per vendor (studio), labelled with the vendor's own name. Falling
// back to the provider name for the label made every Palace vendor read
// "Palace Casino", so the row showed the same chip nine times.
const vendorChips = computed<{ code: string; name: string }[]>(() => {
  const map = new Map<string, string>()
  for (const g of providerStore.games) {
    const name = g.vendorName ?? g.providerName ?? g.vendorCode
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

// Which games lead the grid is curated in the admin panel (Featured Games) and
// applied by the API, so the order here is whatever the API returned.

const onPlayTap = useTapToPlay()
function providerToCard(g: ProviderGame): LobbyCard {
  return {
    key: (g.providerCode ?? providerStore.activeProviderCode) + '-' + g.gameCode,
    badge: CATEGORY_LABELS[g.categoryCode] ?? g.categoryCode,
    title: g.gameName,
    image: g.imageSquare ?? g.imageLandscape ?? null,
    letter: (g.gameName?.[0] ?? '?').toUpperCase(),
    to: `/play/${launchProviderFor(g, providerStore.activeProviderCode)}/${g.gameCode}`,
    vendor: g.vendorCode ?? g.providerName ?? undefined,
  }
}

const categoryGamesMap = ref<Record<string, ProviderGame[]>>({})
const categoryGamesLoading = ref<Record<string, boolean>>({})

// Extra pages loaded via infinite scroll for the cross-provider ALL feed —
// separate from providerStore.games/loadMore, which page a single provider
// and are still used as-is by /games (its own provider switcher). See
// loadMoreHomeGames().
const homeExtraGames = ref<ProviderGame[]>([])
const homePage = ref(1)
const homeHasMore = ref(true)
const homeLoadingMore = ref(false)

// Pool of every loaded provider game (bootstrap page + infinite-scroll pages +
// each fetched category), deduped by provider+gameCode — two different
// providers can legitimately share a gameCode (e.g. both calling a game
// "keno"). Ensures featured games living in non-default categories (e.g.
// INSTWIN) can surface in the ALL grid.
const allProviderGames = computed<ProviderGame[]>(() => {
  const seen = new Set<string>()
  const pool: ProviderGame[] = []
  for (const g of [
    ...providerStore.games,
    ...homeExtraGames.value,
    ...Object.values(categoryGamesMap.value).flat(),
  ]) {
    const key = `${g.providerCode ?? ''}:${g.gameCode}`
    if (seen.has(key)) continue
    seen.add(key)
    pool.push(g)
  }
  return pool
})

async function loadMoreHomeGames() {
  if (!homeHasMore.value || homeLoadingMore.value) return
  homeLoadingMore.value = true
  try {
    const nextPage = homePage.value + 1
    const result = await $fetch<{ games: ProviderGame[]; totalPages: number }>(
      `${config.public.apiBase}/providers/games?page=${nextPage}&pageSize=60`,
    )
    homeExtraGames.value = [...homeExtraGames.value, ...result.games]
    homePage.value = nextPage
    homeHasMore.value = nextPage < result.totalPages
  } catch {
    homeHasMore.value = false
  } finally {
    homeLoadingMore.value = false
  }
}

const gridGames = computed<LobbyCard[]>(() => {
  const cat = selectedCategory.value
  let cards: LobbyCard[]
  if (cat === 'BINGO') {
    cards = gameStore.availableGames.map(bingoToCard)
  } else if (cat === 'ALL') {
    // Featured games first, then remaining provider games; bingo rooms at the bottom
    cards = [...allProviderGames.value.map(providerToCard), ...gameStore.availableGames.map(bingoToCard)]
  } else if (cat === 'TRENDING') {
    cards = [...allProviderGames.value.map(providerToCard), ...trendingBingo.value.map(bingoToCard)]
  } else if (cat === 'POPULAR') {
    cards = [...allProviderGames.value.map(providerToCard), ...popularBingo.value.map(bingoToCard)]
  } else {
    cards = (categoryGamesMap.value[cat] ?? []).map(providerToCard)
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
  if (cat === 'ALL' || cat === 'TRENDING' || cat === 'POPULAR') {
    // Reveal as soon as either branch (casino or bingo) has data instead of
    // holding the skeleton for the slower one — the rest streams in.
    if (allProviderGames.value.length || gameStore.availableGames.length) return false
    return lobbyInitialLoading.value
  }
  if (cat === 'BINGO') {
    return gameStore.loadingGames && !gameStore.availableGames.length
  }
  return !!categoryGamesLoading.value[cat] && !(categoryGamesMap.value[cat]?.length)
})

async function fetchCategoryGames(category: string, pageSize = 24) {
  categoryGamesLoading.value[category] = true
  try {
    const result = await $fetch<{ games: ProviderGame[]; totalPages: number }>(
      `${config.public.apiBase}/providers/games?page=1&pageSize=${pageSize}&category=${category}`,
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

/* ── Infinite scroll ───────────────────────────────────────────────────────
   The ALL tab starts with the ~60-game lobby bootstrap page, which is a sliver
   of the full catalog (1000+ games across providers). Paging in the rest via
   loadMoreHomeGames() as the user scrolls is what makes "All Games" actually
   show all games, without shipping the whole catalog on first paint.
   loadMoreHomeGames (not providerStore.loadMore) because this feed is merged
   across every active provider — providerStore's own paging is single-provider
   and still belongs to /games' provider-switcher browsing. */
const feedSentinel = ref<HTMLElement | null>(null)
let feedObserver: IntersectionObserver | null = null

function setupFeedObserver() {
  if (!feedSentinel.value) return
  feedObserver = new IntersectionObserver(
    (entries) => {
      if (
        entries[0].isIntersecting &&
        selectedCategory.value === 'ALL' &&
        homeHasMore.value &&
        !homeLoadingMore.value
      ) {
        loadMoreHomeGames()
      }
    },
    { rootMargin: '800px' },
  )
  feedObserver.observe(feedSentinel.value)
}

/* ── Lifecycle ──────────────────────────────────────────────────────────── */
onMounted(async () => {
  track('lobby_view')

  loadHeroBanners()
  syncHeroBannerViewport()
  heroBannerViewport?.addEventListener('change', syncHeroBannerViewport)

  try {
    const saved = localStorage.getItem('ab_favs')
    if (saved) favorites.value = new Set(JSON.parse(saved))
  } catch { /* ignore */ }

  promotionsStore.fetch()
  promotionsStore.fetchProgress()
  loadBonusGrants()
  window.addEventListener('resize', onOfferResize)
  // The store survives a round trip to a game and back, so the offers can be on
  // screen from the first frame — the length watch never fires for them.
  nextTick(measureOfferRow)

  // Single bootstrap call: providers + categories + first games page + bingo
  // rooms in one round-trip (was three serial + one parallel request). Falls
  // back to the individual fetches if the lobby endpoint is unavailable.
  try {
    const lobby = await $fetch<{
      providers: any[]
      activeProviderCode: string | null
      categories: string[]
      games: ProviderGame[]
      gamesTotal: number
      pageSize: number
      bingoGames: Game[]
    }>(`${config.public.apiBase}/providers/lobby?pageSize=60`)

    providerStore.hydrateLobby(lobby)
    gameStore.setAvailableGames(lobby.bingoGames ?? [])
    homeHasMore.value = lobby.pageSize < lobby.gamesTotal
  } catch {
    // Fallback — bootstrap unavailable; fetch the pieces individually.
    const bingoLoad = gameStore.fetchAvailableGames().catch(() => {})
    const providerLoad = (async () => {
      await providerStore.fetchProviders()
      if (providerStore.activeProviderCode) {
        const [cats, page] = await Promise.all([
          $fetch<string[]>(`${config.public.apiBase}/providers/categories`),
          $fetch<{ games: ProviderGame[]; totalItems: number }>(
            `${config.public.apiBase}/providers/games?page=1&pageSize=60`,
          ),
        ])
        providerStore.categories = cats
        providerStore.games = page.games
        homeHasMore.value = page.games.length < page.totalItems
      }
    })().catch(() => {})
    await Promise.allSettled([bingoLoad, providerLoad])
  }
  lobbyInitialLoading.value = false

  await nextTick()
  setupFeedObserver()

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
  feedObserver?.disconnect()
  if (slideTimer) clearInterval(slideTimer)
  if (bonusTicker) clearInterval(bonusTicker)
  if (bonusWindowTimer) clearTimeout(bonusWindowTimer)
  window.removeEventListener('resize', onOfferResize)
  heroBannerViewport?.removeEventListener('change', syncHeroBannerViewport)
  // Read the existing socket, never connect() here: connect() creates a new
  // connection when the reuse check doesn't match (e.g. auth identity has
  // already changed by unmount time), so an unsubscribe-on-teardown call
  // was opening a brand new socket — full handshake, polling, failed
  // websocket upgrade — just to emit into a room it was never part of.
  socket.value?.emit('lobby:unsubscribe')
})
</script>

<template>
  <div class="lobby-page">
    <!-- ═══════════════ HERO ═══════════════ -->
    <section class="max-wrap">
      <div
        v-if="heroBannerMode.kind === 'loading'"
        class="hero hero--banner"
        :style="heroBannerBoxStyle"
        aria-hidden="true"
      />
      <div
        v-else
        class="hero"
        :class="activeSlide.banner ? 'hero--banner' : { 'hero--image': !!activeSlide.image }"
        :style="
          activeSlide.banner
            ? heroBannerBoxStyle
            : activeSlide.gradient ? { background: activeSlide.gradient } : undefined
        "
        @touchstart.passive="onTouchStart"
        @touchend.passive="onTouchEnd"
      >
        <!-- Admin banner: the image is the whole slide, boxed at the upload
             spec's ratio. Clickable only when it carries a vetted link. -->
        <template v-if="activeSlide.banner">
          <picture :key="activeSlide.id" class="hero-banner-img">
            <source :media="HERO_BANNER_MOBILE_MEDIA" :srcset="activeSlide.banner.mobileImageUrl" />
            <img
              :src="activeSlide.banner.desktopImageUrl"
              :alt="activeSlide.banner.altText"
              :data-slide-id="activeSlide.id"
              @error="onSlideImageError"
            />
          </picture>
          <NuxtLink
            v-if="activeSlide.banner.link.kind === 'internal'"
            :to="activeSlide.banner.link.to"
            class="hero-img-hit"
            :aria-label="activeSlide.banner.linkLabel"
            @click="trackHeroBannerClick(activeSlide.id)"
          />
          <a
            v-else-if="activeSlide.banner.link.kind === 'external'"
            :href="activeSlide.banner.link.href"
            target="_blank"
            rel="noopener noreferrer"
            class="hero-img-hit"
            :aria-label="activeSlide.banner.linkLabel"
            @click="trackHeroBannerClick(activeSlide.id)"
          />
        </template>

        <!-- Artwork slide. No `type` sources: the banner is whatever format was
             dropped in, and a 404 on a typed <source> does not fall back. -->
        <template v-else-if="activeSlide.image">
          <picture :key="activeSlide.id" class="hero-img">
            <source
              v-if="activeSlide.image.mobile"
              media="(max-width: 767px)"
              :srcset="activeSlide.image.mobile"
            />
            <img
              :src="activeSlide.image.desktop"
              :alt="activeSlide.image.alt"
              :data-slide-id="activeSlide.id"
              @error="onSlideImageError"
            />
          </picture>
          <button
            class="hero-img-hit"
            :aria-label="activeSlide.cta"
            @click="heroAction(activeSlide)"
          />
        </template>

        <template v-else>
          <div :key="activeSlide.id" class="hero-content">
            <span class="hero-badge">{{ activeSlide.badge }}</span>
            <h1 class="hero-title">{{ activeSlide.title }}</h1>
            <p class="hero-sub">{{ activeSlide.sub }}</p>
            <button class="hero-cta" @click="heroAction(activeSlide)">{{ activeSlide.cta }}</button>
          </div>

          <div class="hero-watermark" :style="{ color: activeSlide.accent }" aria-hidden="true">
            {{ activeSlide.watermark }}
          </div>
        </template>

        <template v-if="heroSlides.length > 1">
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
        </template>
      </div>
    </section>

    <!-- ═══════════════ BONUS EXPIRY ═══════════════
         Player state rather than an offer, so it is a full-width bar above the
         carousel and never carries artwork. -->
    <section v-if="showBonusExpiry" class="max-wrap">
      <div class="bexp">
        <div class="bexp-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 2" /></svg>
        </div>
        <div class="bexp-copy">
          <span class="bexp-title">{{ t(expiringHeadlineKey, { amount: expiringAmount }) }}</span>
          <span class="bexp-sub">{{ t('promo.expiry_sub') }}</span>
        </div>
        <!-- Hidden from assistive tech: it changes every second, and the line
             above already carries the deadline in words. -->
        <span class="bexp-clock" aria-hidden="true">{{ expiringCountdown }}</span>
        <button class="bexp-cta" :disabled="switchingSpendAccount" @click="spendBonusFirst">
          {{ t('promo.expiry_cta') }}
        </button>
      </div>
    </section>

    <!-- ═══════════════ LIVE OFFERS ═══════════════
         Absent, not empty: with no promotions the whole section leaves the page
         rather than holding a heading over a blank row. -->
    <section v-if="promotionsStore.promotions.length" class="max-wrap offers">
      <div class="offers-head">
        <h2 class="offers-title">{{ t('promo.live_offers') }}</h2>
        <div class="offers-tools">
          <NuxtLink to="/promotions" class="offers-all">
            {{ t('promo.all_promotions') }}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
          </NuxtLink>
          <div v-if="offerPageCount > 1" class="offers-nav">
            <button
              class="offer-nav"
              :disabled="offerAtStart"
              :aria-label="t('promo.prev_offers')"
              @click="scrollOffers(-1)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <button
              class="offer-nav"
              :disabled="offerAtEnd"
              :aria-label="t('promo.next_offers')"
              @click="scrollOffers(1)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </div>
        </div>
      </div>

      <div ref="offerRow" class="offer-row noscroll" @scroll.passive="syncOfferPage">
        <PromoTile
          v-for="p in promotionsStore.promotions"
          :key="p.kind + ':' + p.refId"
          :promo="p"
          :progress="promotionsStore.progressFor(p.refId)"
          :size="offerTileSize"
        />
      </div>

      <!-- Indicator, not a control: at the drawn size a dot cannot carry a 44px
           tap target, and the arrows plus the row's own scrolling already move it. -->
      <div v-if="offerPageCount > 1" class="offer-dots" aria-hidden="true">
        <span
          v-for="i in offerPageCount"
          :key="i"
          class="offer-dot"
          :class="{ 'offer-dot--active': offerPage === i - 1 }"
        />
      </div>
    </section>

    <!-- ═══════════════ FIGHT MARKETS ═══════════════
         A second, persistent entry point. The hero slide rotates away after a
         few seconds; this one does not, so a player who scrolls past the
         carousel can still find the feature. Hidden entirely when the flag is
         off — no dead link to a 404. -->
    <section v-if="predictionsEnabled" class="max-wrap">
      <NuxtLink to="/predictions" class="pred-strip" @click="track('lobby_predictions_click')">
        <div class="pred-strip-main">
          <span class="pred-strip-kicker">ETFC Fight Night · 27 August</span>
          <h2 class="pred-strip-title">Fight Markets</h2>
          <p class="pred-strip-sub">
            Back a fighter at the price you think is right. A share pays 100 ETB if they win.
          </p>
        </div>
        <span class="pred-strip-cta">
          Open
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </NuxtLink>
    </section>

    <!-- ═══════════════ WINNERS ═══════════════ -->
    <section class="max-wrap winners">
      <div class="win-tabs" role="tablist">
        <button
          v-for="tab in winnerTabs"
          :key="tab.key"
          class="win-tab"
          :class="{ 'win-tab--active': activeWinnerTab === tab.key }"
          role="tab"
          :aria-selected="activeWinnerTab === tab.key"
          @click="activeWinnerTab = tab.key"
        >
          {{ tab.label }}
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
          <!-- The favourite star stops propagation, so a star tap is never recorded. -->
          <NuxtLink v-if="card.to" :to="card.to" class="game-card" @click="onPlayTap(card.to)">
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

      <div ref="feedSentinel" class="feed-sentinel" />
      <div v-if="homeLoadingMore && selectedCategory === 'ALL' && gridGames.length" class="load-more">
        <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
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
.hero--image {
  padding: 0;
  min-height: 0;
  background: var(--surface-raised);
}
/* The artwork owns the box; no overlay wash over someone's finished design. */
.hero--image::after { content: none; }

.hero-img {
  display: block;
  width: 100%;
  animation: hero-in 0.4s ease both;
}
.hero-img img {
  display: block;
  width: 100%;
  height: auto;
}
/* Whole banner is the click target. Sits under the arrows and dots. */
.hero-img-hit {
  position: absolute;
  inset: 0;
  z-index: 1;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}
.hero-img-hit:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: -3px;
}
.hero-arrow, .hero-dots { z-index: 3; }

/* Admin banner. The box takes the upload spec's ratio (--hero-banner-ratio,
   bound per viewport from the script), so it never reflows when the image
   lands. Doubled class so the 720px .hero padding rule cannot reach it. */
.hero.hero--banner {
  padding: 0;
  min-height: 0;
  aspect-ratio: var(--hero-banner-ratio);
  background: var(--surface-raised);
}
.hero.hero--banner::after { content: none; }
.hero-banner-img {
  position: absolute;
  inset: 0;
  animation: hero-banner-in 0.4s ease both;
}
.hero-banner-img img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
@keyframes hero-banner-in {
  from { opacity: 0; }
  to { opacity: 1; }
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

/* ── BONUS EXPIRY BAR ──────────────────────────────────────────────────── */
.bexp {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 22px;
  padding: 14px 18px;
  border-radius: 14px;
  background: linear-gradient(100deg, rgba(127, 29, 29, 0.34), rgba(14, 23, 41, 0.5) 62%);
  border: 1px solid rgba(248, 113, 113, 0.34);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);
}
.bexp-icon {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(248, 113, 113, 0.16);
  color: #fca5a5;
}
.bexp-icon svg { width: 19px; height: 19px; }

.bexp-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bexp-title {
  font-family: var(--font-ui);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.4px;
  color: #fff;
}
.bexp-sub { font-size: 12.5px; line-height: 1.35; color: rgba(255, 255, 255, 0.62); }

.bexp-clock {
  margin-left: auto;
  font-family: var(--font-heading);
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #fca5a5;
  /* Tabular figures, or the whole bar twitches sideways once a second. */
  font-variant-numeric: tabular-nums;
}

.bexp-cta {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.22);
  color: #fff;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.15s;
}
.bexp-cta:hover { background: rgba(255, 255, 255, 0.16); }
.bexp-cta:disabled { opacity: 0.6; cursor: default; }
.bexp-cta:focus-visible,
.offers-all:focus-visible,
.offer-nav:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
  border-radius: 10px;
}

@media (max-width: 720px) {
  .bexp { flex-wrap: wrap; gap: 10px 12px; padding: 13px 14px; }
  .bexp-copy { flex: 1 1 0; }
  .bexp-clock { font-size: 22px; }
  .bexp-cta { flex: 1 0 100%; }
}

/* ── LIVE OFFERS ───────────────────────────────────────────────────────── */
.offers {
  margin-top: 22px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.offers-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.offers-title {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: #a9b7c9;
}
.offers-tools { display: flex; align-items: center; gap: 12px; }

.offers-all {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 44px;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.4px;
  color: var(--brand-primary);
}
.offers-all svg { width: 13px; height: 13px; }

.offers-nav { display: flex; gap: 7px; }
/* The disc is the 34px the design draws; the button around it is 44px so the
   tap target clears the floor without growing the artwork. */
.offer-nav {
  position: relative;
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: none;
  color: #fff;
  cursor: pointer;
}
.offer-nav::before {
  content: '';
  position: absolute;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.16);
  transition: background 0.15s;
}
.offer-nav:hover::before { background: rgba(255, 255, 255, 0.14); }
.offer-nav:disabled { opacity: 0.45; cursor: default; }
.offer-nav:disabled:hover::before { background: rgba(255, 255, 255, 0.07); }
.offer-nav svg { position: relative; width: 14px; height: 14px; }

/* Snap scrolling rather than an animated transform: a trackpad or a thumb then
   drives the row on its own and the buttons are only a shortcut. A scroll box
   clips in both axes, so the padding is what keeps the tiles' drop shadow from
   being sliced off; the negative margin pays most of it back so the row still
   starts flush with the rest of the page. */
.offer-row {
  display: flex;
  gap: 16px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scroll-padding-left: 12px;
  padding: 4px 12px 20px;
  margin: -4px -12px -14px;
}
.offer-row > * { scroll-snap-align: start; }

.offer-dots {
  display: flex;
  justify-content: center;
  gap: 7px;
  padding-top: 3px;
}
.offer-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  /* .55 is the floor for faint greys on this surface; the mock's .32 is under it. */
  background: rgba(255, 255, 255, 0.55);
  transition: width 0.2s, background 0.2s;
}
.offer-dot--active { width: 20px; background: var(--brand-primary); }

@media (max-width: 720px) {
  /* The row scrolls freely at the phone tile size, so the arrows are dead
     weight next to a thumb. */
  .offers-nav { display: none; }
  .offer-row {
    gap: 12px;
    scroll-padding-left: 16px;
    padding: 4px 16px 20px;
    margin: -4px -16px -14px;
  }
}

/* ── WINNERS ───────────────────────────────────────────────────────────── */
/* ── Fight markets strip ──
   Crimson rather than the page's amber, so it reads as a different product and
   not a third bonus banner. Border-led rather than a filled card — the hero
   directly above is already a heavy block, and two solid slabs stacked read as
   noise. */
.pred-strip {
  margin-top: 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-radius: 16px;
  text-decoration: none;
  color: inherit;
  border: 1px solid rgba(251, 113, 133, 0.28);
  background:
    linear-gradient(105deg, rgba(42, 10, 18, 0.9) 0%, rgba(74, 15, 30, 0.75) 55%, rgba(109, 21, 40, 0.6) 100%);
  transition:
    border-color 240ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
}
.pred-strip:hover { border-color: rgba(251, 113, 133, 0.55); }
.pred-strip:active { transform: scale(0.994); transition-duration: 90ms; }
.pred-strip:focus-visible { outline: 2px solid #fb7185; outline-offset: 3px; }
.pred-strip-main { min-width: 0; }
.pred-strip-kicker {
  display: block;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #fb7185;
}
.pred-strip-title {
  margin: 4px 0 2px;
  font-size: 1.15rem;
  font-weight: 800;
  color: #fff;
}
.pred-strip-sub {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.62);
  max-width: 56ch;
}
.pred-strip-cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-size: 0.82rem;
  font-weight: 700;
  color: #fff;
}
.pred-strip-cta svg { width: 16px; height: 16px; }
@media (max-width: 560px) {
  .pred-strip { flex-direction: column; align-items: flex-start; gap: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  .pred-strip:active { transform: none; }
}

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

.feed-sentinel { height: 1px; }
.load-more { display: flex; justify-content: center; padding: 24px; color: var(--brand-primary); }
.load-more svg { width: 24px; height: 24px; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

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
