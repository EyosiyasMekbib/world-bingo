# Lobby by Template Category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single flat "Available Bingo Rooms" section with one collapsible section per game template title, so players can browse rooms organised by game type.

**Architecture:** The `GET /games` API already returns a `title` field on every game (inherited from its template). A `gamesByCategory` computed in `index.vue` groups `filteredGames` by that title. The template replaces the single rooms section with a `v-for` over the grouped results. No backend changes are required.

**Tech Stack:** Nuxt 3, Vue 3 Composition API, TypeScript

---

## File Map

**Modified files:**
- `apps/web/pages/index.vue` — remove `roomsCollapsed`, add `categoryCollapsed` + `gamesByCategory` computed, replace single rooms section with per-category sections

---

## Task 1: Add per-category state and computed to script

**Files:**
- Modify: `apps/web/pages/index.vue` (script section, lines ~17–19 and ~55–62)

- [ ] **Step 1: Replace `roomsCollapsed` ref with per-category collapse state**

Find and replace this block (lines 17–19):

```ts
const topGamesCollapsed = ref(false)
const roomsCollapsed = ref(false)
const searchQuery = ref('')
```

Replace with:

```ts
const topGamesCollapsed = ref(false)
const searchQuery = ref('')
const categoryCollapsed = reactive<Record<string, boolean>>({})

function toggleCategory(title: string) {
  categoryCollapsed[title] = !categoryCollapsed[title]
}
```

- [ ] **Step 2: Add `gamesByCategory` computed after `filteredGames`**

The existing `filteredGames` computed is around line 55–62:

```ts
const filteredGames = computed(() => {
  if (!searchQuery.value.trim()) return gameStore.availableGames
  const q = searchQuery.value.trim().toLowerCase()
  return gameStore.availableGames.filter((g: Game) =>
    String(g.ticketPrice).includes(q) ||
    g.status.toLowerCase().includes(q)
  )
})
```

Add the following immediately after that closing `})`:

```ts
const gamesByCategory = computed<{ title: string; games: Game[] }[]>(() => {
  const map = new Map<string, Game[]>()
  for (const game of filteredGames.value) {
    const key = game.title || 'Other'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(game)
  }
  return Array.from(map.entries()).map(([title, games]) => ({ title, games }))
})
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: no new errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/pages/index.vue
git commit -m "feat(web): add gamesByCategory computed and per-category collapse state"
```

---

## Task 2: Replace single rooms section with per-category sections

**Files:**
- Modify: `apps/web/pages/index.vue` (template section, lines ~491–567)

- [ ] **Step 1: Replace the entire bingo rooms section**

Find and replace the entire block from `<!-- ── AVAILABLE BINGO ROOMS` to the closing `</div>` at line ~567. The block to remove is:

```html
    <!-- ── AVAILABLE BINGO ROOMS ──────────────────────────────── -->
    <div v-if="showBingoSection" id="rooms" class="section">
      <div class="max-container">
        <div class="section-hdr">
          <span class="section-title">Available Bingo Rooms</span>
          <button class="collapse-btn" @click="roomsCollapsed = !roomsCollapsed">
            {{ roomsCollapsed ? 'Expand' : 'Collapse' }}
          </button>
        </div>

        <div v-show="!roomsCollapsed">
          <div v-if="gameStore.loadingGames" class="state-msg">
            <span class="spinner"></span> Loading games…
          </div>
          <div v-else-if="gameStore.error" class="state-msg state-msg--error">
            Could not load games
            <button class="retry-btn" @click="gameStore.fetchAvailableGames()">Retry</button>
          </div>
          <div v-else-if="!filteredGames.length" class="state-msg">
            {{ searchQuery ? 'No games match your search.' : 'No games available right now. Check back soon!' }}
          </div>

          <div v-else class="rooms-grid">
            <div
              v-for="(game, idx) in filteredGames"
              :key="game.id"
              class="room-card"
              :style="{ '--delay': `${idx * 60}ms` }"
            >
              <!-- Row 1: Label + Pattern badge -->
              <div class="rc-row-1">
                <span class="rc-ticket-label">TICKET PRICE</span>
                <span class="rc-pattern">{{ patternLabel(game.pattern) }}</span>
              </div>

              <!-- Row 2: Price + Timer/Live -->
              <div class="rc-row-2">
                <div class="rc-price-block">
                  <span class="rc-price">{{ Number(game.ticketPrice).toLocaleString() }}</span>
                  <span class="rc-etb">ETB</span>
                </div>
                <div class="rc-timer" :class="{ 'rc-timer--live': game.status !== 'WAITING' }">
                  <template v-if="game.status !== 'WAITING'">
                    <span class="live-dot-sm"></span>
                    LIVE
                  </template>
                  <template v-else>
                    <GameCountdown
                      v-if="gameStore.countdowns[game.id]"
                      :starts-at="gameStore.countdowns[game.id]"
                      compact
                    />
                    <template v-else>1:00</template>
                  </template>
                </div>
              </div>

              <!-- Row 3: Players + CTA -->
              <div class="rc-row-3">
                <div class="rc-players">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="rc-player-icon">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  {{ gameStore.livePlayers[game.id] ?? (game as any).currentPlayers ?? 0 }} / {{ (game as any).maxPlayers ?? 10 }} players
                </div>
                <NuxtLink v-if="game.status === 'WAITING'" :to="`/quick/${game.id}`" class="rc-join">
                  Join Game →
                </NuxtLink>
                <div v-else class="rc-join rc-join--live">
                  {{ game.status === 'STARTING' ? 'Starting...' : 'Game Live' }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
```

Replace it with:

```html
    <!-- ── BINGO ROOMS (by category) ────────────────────────────── -->
    <div v-if="showBingoSection" id="rooms">

      <!-- Loading / error / empty — shown once above all categories -->
      <div class="section">
        <div class="max-container">
          <div v-if="gameStore.loadingGames" class="state-msg">
            <span class="spinner"></span> Loading games…
          </div>
          <div v-else-if="gameStore.error" class="state-msg state-msg--error">
            Could not load games
            <button class="retry-btn" @click="gameStore.fetchAvailableGames()">Retry</button>
          </div>
          <div v-else-if="!filteredGames.length" class="state-msg">
            {{ searchQuery ? 'No games match your search.' : 'No games available right now. Check back soon!' }}
          </div>
        </div>
      </div>

      <!-- One section per template category -->
      <template v-if="!gameStore.loadingGames && !gameStore.error && filteredGames.length">
        <div
          v-for="cat in gamesByCategory"
          :key="cat.title"
          class="section"
        >
          <div class="max-container">
            <div class="section-hdr">
              <span class="section-title">{{ cat.title }}</span>
              <button class="collapse-btn" @click="toggleCategory(cat.title)">
                {{ categoryCollapsed[cat.title] ? 'Expand' : 'Collapse' }}
              </button>
            </div>

            <div v-show="!categoryCollapsed[cat.title]" class="rooms-grid">
              <div
                v-for="(game, idx) in cat.games"
                :key="game.id"
                class="room-card"
                :style="{ '--delay': `${idx * 60}ms` }"
              >
                <!-- Row 1: Label + Pattern badge -->
                <div class="rc-row-1">
                  <span class="rc-ticket-label">TICKET PRICE</span>
                  <span class="rc-pattern">{{ patternLabel(game.pattern) }}</span>
                </div>

                <!-- Row 2: Price + Timer/Live -->
                <div class="rc-row-2">
                  <div class="rc-price-block">
                    <span class="rc-price">{{ Number(game.ticketPrice).toLocaleString() }}</span>
                    <span class="rc-etb">ETB</span>
                  </div>
                  <div class="rc-timer" :class="{ 'rc-timer--live': game.status !== 'WAITING' }">
                    <template v-if="game.status !== 'WAITING'">
                      <span class="live-dot-sm"></span>
                      LIVE
                    </template>
                    <template v-else>
                      <GameCountdown
                        v-if="gameStore.countdowns[game.id]"
                        :starts-at="gameStore.countdowns[game.id]"
                        compact
                      />
                      <template v-else>1:00</template>
                    </template>
                  </div>
                </div>

                <!-- Row 3: Players + CTA -->
                <div class="rc-row-3">
                  <div class="rc-players">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="rc-player-icon">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                    {{ gameStore.livePlayers[game.id] ?? (game as any).currentPlayers ?? 0 }} / {{ (game as any).maxPlayers ?? 10 }} players
                  </div>
                  <NuxtLink v-if="game.status === 'WAITING'" :to="`/quick/${game.id}`" class="rc-join">
                    Join Game →
                  </NuxtLink>
                  <div v-else class="rc-join rc-join--live">
                    {{ game.status === 'STARTING' ? 'Starting...' : 'Game Live' }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

    </div>
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/pages/index.vue
git commit -m "feat(web): show bingo rooms grouped by template category"
```
