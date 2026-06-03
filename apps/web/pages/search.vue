<script setup lang="ts">
import { normalizeLobbySearchQuery } from '~/utils/lobby-search'

type SearchBingoResult = {
  kind: 'bingo'
  id: string
  gameCode: string
  gameName: string
  categoryCode: string
  imageSquare: string | null
  imageLandscape: string | null
  providerCode: string
  providerName: string
  vendorCode: string | null
}

type SearchProviderResult = {
  kind: 'provider'
  id: string
  providerCode: string
  providerName: string
  vendorCode: string | null
  gameCode: string
  gameName: string
  categoryCode: string
  imageSquare: string | null
  imageLandscape: string | null
}

type SearchResult = SearchProviderResult | SearchBingoResult

type SearchResponse = {
  query: string
  results: SearchResult[]
}

const route = useRoute()

const searchQuery = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const results = ref<SearchResult[]>([])
let requestId = 0

const query = computed(() => normalizeLobbySearchQuery(String(route.query.q ?? '')))
const totalResults = computed(() => results.value.length)

function goToSearch() {
  const q = searchQuery.value.trim()
  if (!q) return
  navigateTo({ path: '/search', query: { q } })
}

function clearSearch() {
  searchQuery.value = ''
  navigateTo('/search')
}

function resultToHref(result: SearchResult) {
  return result.kind === 'bingo'
    ? '/games/bingo'
    : `/play/${result.providerCode}/${result.gameCode}`
}

async function loadSearchResults(nextQuery: string) {
  const normalized = normalizeLobbySearchQuery(nextQuery)
  const currentRequest = ++requestId

  if (!normalized) {
    results.value = []
    error.value = null
    loading.value = false
    return
  }

  loading.value = true
  error.value = null

  try {
    const response = await $fetch<SearchResponse>(`${useRuntimeConfig().public.apiBase}/providers/search`, {
      query: { q: normalized },
    })
    if (currentRequest !== requestId) return
    results.value = response.results
  } catch (e: any) {
    if (currentRequest !== requestId) return
    error.value = e?.message ?? 'Failed to load search results'
    results.value = []
  } finally {
    if (currentRequest === requestId) loading.value = false
  }
}

watch(
  query,
  (q) => {
    searchQuery.value = q
    void loadSearchResults(q)
  },
  { immediate: true },
)

useHead({
  title: computed(() =>
    query.value ? `Search results for "${query.value}" — World Bingo` : 'Search — World Bingo',
  ),
})
</script>

<template>
  <div class="search-page">
    <section class="search-hero">
      <div class="max-container search-hero-inner">
        <NuxtLink to="/" class="back-btn" aria-label="Back to lobby">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </NuxtLink>

        <div class="search-copy">
          <p class="search-eyebrow">Search</p>
          <h1 class="search-title">
            {{ query ? `Results for "${query}"` : 'Search games' }}
          </h1>
          <p class="search-sub">
            Search across every provider in the catalog. Bingo shows up once, as a single game.
          </p>
        </div>

        <form class="search-wrap" role="search" @submit.prevent="goToSearch">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search by title, price, category, provider, or vendor..."
            class="search-input"
            aria-label="Search games"
          />
          <button type="submit" class="search-submit" aria-label="Search games">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            v-if="searchQuery"
            type="button"
            class="search-clear"
            aria-label="Clear search"
            @click="clearSearch"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </form>
      </div>
    </section>

    <div class="max-container search-content">
      <div v-if="!query" class="state-msg">
        Type a game name, provider, category, or vendor to see matches.
      </div>

      <template v-else>
        <div v-if="loading" class="state-msg">
          <span class="spinner" aria-hidden="true"></span> Loading catalog...
        </div>
        <div v-else-if="error" class="state-msg state-msg--error">
          Could not load search results.
        </div>

        <template v-else>
          <div class="search-summary">
            <span>{{ totalResults }} result{{ totalResults === 1 ? '' : 's' }}</span>
          </div>

          <div v-if="!results.length" class="state-msg">
            No games match your search.
          </div>

          <div v-else class="pg-grid">
            <NuxtLink
              v-for="result in results"
              :key="result.kind === 'bingo' ? result.id : `${result.providerCode}:${result.gameCode}`"
              :to="resultToHref(result)"
              class="pg-card"
            >
              <div class="pg-thumb">
                <img
                  v-if="result.imageSquare || result.imageLandscape"
                  :src="result.imageSquare ?? result.imageLandscape ?? ''"
                  :alt="result.gameName"
                  class="pg-img"
                  loading="lazy"
                />
                <div v-else class="pg-placeholder">
                  <svg
                    v-if="result.kind === 'bingo'"
                    width="34"
                    height="34"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="rgba(255,255,255,0.25)"
                    stroke-width="1.3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="2" y="2" width="20" height="20" rx="2" />
                    <line x1="8" y1="2" x2="8" y2="22" />
                    <line x1="16" y1="2" x2="16" y2="22" />
                    <line x1="2" y1="8" x2="22" y2="8" />
                    <line x1="2" y1="16" x2="22" y2="16" />
                  </svg>
                  <svg
                    v-else
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="rgba(255,255,255,0.2)"
                    stroke-width="1.3"
                    aria-hidden="true"
                  >
                    <rect x="2" y="3" width="20" height="18" rx="2" />
                    <rect x="5" y="7" width="4" height="8" rx="1" />
                    <rect x="10" y="7" width="4" height="8" rx="1" />
                    <rect x="15" y="7" width="4" height="8" rx="1" />
                  </svg>
                </div>
                <div class="pg-hover">
                  <span class="pg-play">{{ result.kind === 'bingo' ? 'Open' : 'Play' }}</span>
                </div>
              </div>
              <div class="pg-name">{{ result.gameName }}</div>
              <div class="pg-meta">
                {{ result.kind === 'bingo' ? 'World Bingo' : `${result.providerName} · ${result.categoryCode}` }}
              </div>
            </NuxtLink>
          </div>
        </template>
      </template>
    </div>

  </div>
</template>

<style scoped>
.search-page {
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

.search-hero {
  background: linear-gradient(150deg, #020b20 0%, #061535 55%, #0c2248 100%);
  padding: 20px 0 22px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.search-hero-inner {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 18px 20px;
  align-items: center;
}

.back-btn {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.72);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  text-decoration: none;
}

.search-copy {
  min-width: 0;
}

.search-eyebrow {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
}

.search-title {
  margin: 0;
  font-family: 'Rajdhani', sans-serif;
  font-size: clamp(28px, 4vw, 42px);
  line-height: 1.04;
  color: #f0f4ff;
}

.search-sub {
  margin: 8px 0 0;
  color: rgba(180, 205, 240, 0.65);
  max-width: 640px;
}

.search-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.3);
  max-width: 720px;
  width: 100%;
  grid-column: 1 / -1;
}

.search-submit,
.search-clear {
  background: none;
  border: none;
  padding: 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.3);
  transition: color 0.15s ease;
}

.search-submit:hover,
.search-clear:hover {
  color: rgba(255, 255, 255, 0.7);
}

.search-input {
  background: none;
  border: none;
  outline: none;
  color: rgba(255, 255, 255, 0.82);
  font-size: 14px;
  font-family: var(--font-body);
  width: 100%;
  min-width: 0;
}

.search-input::placeholder {
  color: rgba(255, 255, 255, 0.34);
}

.search-content {
  padding-top: 22px;
}

.search-summary {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 14px;
  color: rgba(255, 255, 255, 0.42);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.pg-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

@media (min-width: 640px) {
  .pg-grid {
    grid-template-columns: repeat(5, 1fr);
  }
}

@media (min-width: 900px) {
  .pg-grid {
    grid-template-columns: repeat(7, 1fr);
  }
}

@media (min-width: 1200px) {
  .pg-grid {
    grid-template-columns: repeat(9, 1fr);
  }
}

.pg-card {
  border-radius: 8px;
  overflow: hidden;
  background: rgba(10, 22, 55, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.06);
  text-decoration: none;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease;
  cursor: pointer;
}

.pg-card:hover {
  transform: translateY(-2px);
  border-color: rgba(245, 158, 11, 0.2);
}

.pg-thumb {
  aspect-ratio: 3 / 4;
  background: #0d2050;
  position: relative;
  overflow: hidden;
}

.pg-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.pg-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pg-hover {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.pg-card:hover .pg-hover {
  opacity: 1;
}

.pg-play {
  background: var(--brand-primary);
  color: #0a0f1a;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 6px 10px;
  border-radius: 999px;
}

.pg-name {
  padding: 8px 9px 0;
  font-size: 11px;
  color: #f0f4ff;
  font-weight: 700;
  line-height: 1.2;
}

.pg-meta {
  padding: 0 9px 9px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.38);
}

.state-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.45);
  padding: 3rem 0;
  font-size: 14px;
  text-align: center;
}

.state-msg--error {
  color: #f87171;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.08);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 760px) {
  .search-hero-inner {
    grid-template-columns: 1fr;
  }

  .search-wrap {
    max-width: none;
  }

  .pg-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
