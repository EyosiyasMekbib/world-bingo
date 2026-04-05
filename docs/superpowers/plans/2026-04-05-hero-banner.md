# Configurable Hero Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins pick a game template to feature in the home page hero; the hero art area is replaced with a live game card for that template (falls back to the existing static bingo card art when nothing is configured or no game is available).

**Architecture:** A new `featured_template_id` site setting (stored as a string, empty = none) is exposed via the existing admin `GET/PUT /settings/game` endpoint and a new public `GET /settings/featured-game` endpoint. The web app fetches the public endpoint on home page mount, looks up the matching game in the already-loaded `availableGames` list, and shows a feature card in the hero if found. The admin configures the setting via a new dropdown in the System Configuration page alongside the existing game settings. The `Game` interface in shared-types gains a `templateId` field so TypeScript recognises the existing runtime value.

**Tech Stack:** Fastify v5, Prisma 5, Vitest, Nuxt 3, Vue 3, `@nuxt/ui`, TypeScript

---

## File Map

**New files:**
- `apps/api/src/test/settings.service.test.ts` — Vitest tests for the new endpoint

**Modified files:**
- `packages/shared-types/src/entities/index.ts` — add `templateId` to Game interface
- `apps/api/src/routes/settings/index.ts` — add setting to DEFAULTS + endpoints
- `apps/admin/composables/useAdminApi.ts` — update type signatures
- `apps/admin/pages/settings/features.vue` — add featured template selector
- `apps/web/pages/index.vue` — fetch featured game, display in hero

---

## Task 1: Add `featured_template_id` to backend settings + public endpoint

**Files:**
- Modify: `apps/api/src/routes/settings/index.ts`
- Create: `apps/api/src/test/settings.service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/test/settings.service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import settingsRoutes from '../routes/settings'
import { prisma } from './setup'

async function buildApp() {
  const app = Fastify()
  await app.register(settingsRoutes, { prefix: '/settings' })
  return app
}

describe('GET /settings/featured-game (public)', () => {
  it('returns templateId null when setting is not configured', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/settings/featured-game' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ templateId: null })
  })

  it('returns templateId null when setting is empty string', async () => {
    await prisma.siteSetting.create({ data: { key: 'featured_template_id', value: '' } })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/settings/featured-game' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ templateId: null })
  })

  it('returns templateId when setting has a value', async () => {
    await prisma.siteSetting.create({ data: { key: 'featured_template_id', value: 'abc-123' } })
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/settings/featured-game' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toEqual({ templateId: 'abc-123' })
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/eyosiyasmekbib/Documents/GitHub/world-bingo/apps/api && pnpm test -- --reporter=verbose settings.service.test.ts
```

Expected: FAIL — route not found (404) or registration error

- [ ] **Step 3: Update settings route**

In `apps/api/src/routes/settings/index.ts`, make the following changes:

**3a. Add `featured_template_id` to DEFAULTS** (after `first_deposit_bonus_amount`):

Replace:
```ts
const DEFAULTS: Record<string, string> = {
    feature_referrals: 'false',
    feature_tournaments: 'false',
    ball_interval_secs: '3',
    bot_max_spend_etb: '500',
    first_deposit_bonus_amount: '0',
}
```

With:
```ts
const DEFAULTS: Record<string, string> = {
    feature_referrals: 'false',
    feature_tournaments: 'false',
    ball_interval_secs: '3',
    bot_max_spend_etb: '500',
    first_deposit_bonus_amount: '0',
    featured_template_id: '',
}
```

**3b. Add `featured_template_id` to `GET /settings/game` response**

Replace:
```ts
        const rows = await prisma.siteSetting.findMany({
            where: { key: { in: ['ball_interval_secs', 'bot_max_spend_etb', 'first_deposit_bonus_amount'] } },
        })
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
        return {
            ball_interval_secs: Number(map.ball_interval_secs ?? 3),
            bot_max_spend_etb: Number(map.bot_max_spend_etb ?? 500),
            first_deposit_bonus_amount: Number(map.first_deposit_bonus_amount ?? 0),
        }
```

With:
```ts
        const rows = await prisma.siteSetting.findMany({
            where: { key: { in: ['ball_interval_secs', 'bot_max_spend_etb', 'first_deposit_bonus_amount', 'featured_template_id'] } },
        })
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
        return {
            ball_interval_secs: Number(map.ball_interval_secs ?? 3),
            bot_max_spend_etb: Number(map.bot_max_spend_etb ?? 500),
            first_deposit_bonus_amount: Number(map.first_deposit_bonus_amount ?? 0),
            featured_template_id: map.featured_template_id ?? '',
        }
```

**3c. Add `featured_template_id` to `PUT /settings/game` handler**

In the PUT /settings/game handler, replace:
```ts
        const body = req.body as { ball_interval_secs?: number; bot_max_spend_etb?: number; first_deposit_bonus_amount?: number }
        const updates: Record<string, string> = {}
        if (body.ball_interval_secs != null) {
            updates.ball_interval_secs = String(Math.max(1, Math.min(30, Number(body.ball_interval_secs))))
        }
        if (body.bot_max_spend_etb != null) {
            updates.bot_max_spend_etb = String(Math.max(0, Number(body.bot_max_spend_etb)))
        }
        if (body.first_deposit_bonus_amount != null) {
            updates.first_deposit_bonus_amount = String(Math.max(0, Number(body.first_deposit_bonus_amount)))
        }
```

With:
```ts
        const body = req.body as { ball_interval_secs?: number; bot_max_spend_etb?: number; first_deposit_bonus_amount?: number; featured_template_id?: string }
        const updates: Record<string, string> = {}
        if (body.ball_interval_secs != null) {
            updates.ball_interval_secs = String(Math.max(1, Math.min(30, Number(body.ball_interval_secs))))
        }
        if (body.bot_max_spend_etb != null) {
            updates.bot_max_spend_etb = String(Math.max(0, Number(body.bot_max_spend_etb)))
        }
        if (body.first_deposit_bonus_amount != null) {
            updates.first_deposit_bonus_amount = String(Math.max(0, Number(body.first_deposit_bonus_amount)))
        }
        if (body.featured_template_id !== undefined) {
            updates.featured_template_id = body.featured_template_id
        }
```

Also update the return statement in `PUT /settings/game` to include `featured_template_id`. Replace the return block at the end of the PUT handler:

```ts
        return {
            ball_interval_secs: Number(updates.ball_interval_secs ?? (await prisma.siteSetting.findUnique({ where: { key: 'ball_interval_secs' } }))?.value ?? 3),
            bot_max_spend_etb: Number(updates.bot_max_spend_etb ?? (await prisma.siteSetting.findUnique({ where: { key: 'bot_max_spend_etb' } }))?.value ?? 500),
            first_deposit_bonus_amount: Number(updates.first_deposit_bonus_amount ?? (await prisma.siteSetting.findUnique({ where: { key: 'first_deposit_bonus_amount' } }))?.value ?? 0),
        }
```

With:
```ts
        const saved = await prisma.siteSetting.findMany({
            where: { key: { in: ['ball_interval_secs', 'bot_max_spend_etb', 'first_deposit_bonus_amount', 'featured_template_id'] } },
        })
        const savedMap = Object.fromEntries(saved.map((r) => [r.key, r.value]))
        return {
            ball_interval_secs: Number(savedMap.ball_interval_secs ?? 3),
            bot_max_spend_etb: Number(savedMap.bot_max_spend_etb ?? 500),
            first_deposit_bonus_amount: Number(savedMap.first_deposit_bonus_amount ?? 0),
            featured_template_id: savedMap.featured_template_id ?? '',
        }
```

**3d. Add the new public `GET /settings/featured-game` route**

Add this new route at the end of the `settingsRoutes` function, before the closing `}`:

```ts
    // ── Public: GET /settings/featured-game ─────────────────────────────────
    // Returns the featured template ID for the home page hero (no auth needed).
    fastify.get('/featured-game', async (_req, _reply) => {
        const row = await prisma.siteSetting.findUnique({ where: { key: 'featured_template_id' } })
        const value = row?.value ?? ''
        return { templateId: value.trim() !== '' ? value : null }
    })
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/eyosiyasmekbib/Documents/GitHub/world-bingo/apps/api && pnpm test -- --reporter=verbose settings.service.test.ts
```

Expected: 3 passed

- [ ] **Step 5: Typecheck API**

```bash
cd /Users/eyosiyasmekbib/Documents/GitHub/world-bingo/apps/api && pnpm typecheck
```

Expected: no new errors

- [ ] **Step 6: Commit**

```bash
cd /Users/eyosiyasmekbib/Documents/GitHub/world-bingo && git add apps/api/src/routes/settings/index.ts apps/api/src/test/settings.service.test.ts
git commit -m "feat(api): add featured_template_id site setting and public endpoint"
```

---

## Task 2: Add `templateId` to shared Game type

**Files:**
- Modify: `packages/shared-types/src/entities/index.ts`

- [ ] **Step 1: Add `templateId` to the Game interface**

In `packages/shared-types/src/entities/index.ts`, find the Game interface (starts at line 43):

```ts
export interface Game {
    id: string
    title: string
    status: GameStatus
    ticketPrice: number
    maxPlayers: number
    minPlayers: number
    currentPlayers: number
    prizePool: number
    houseEdgePct: number
    pattern: PatternType
    calledBalls: number[]
    createdAt: Date
    startedAt?: Date
    endedAt?: Date
    winnerId?: string
}
```

Replace with:

```ts
export interface Game {
    id: string
    title: string
    status: GameStatus
    ticketPrice: number
    maxPlayers: number
    minPlayers: number
    currentPlayers: number
    prizePool: number
    houseEdgePct: number
    pattern: PatternType
    calledBalls: number[]
    createdAt: Date
    startedAt?: Date
    endedAt?: Date
    winnerId?: string
    templateId?: string | null
}
```

- [ ] **Step 2: Rebuild shared-types**

```bash
cd /Users/eyosiyasmekbib/Documents/GitHub/world-bingo && pnpm --filter @world-bingo/shared-types build
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared-types/src/entities/index.ts packages/shared-types/dist
git commit -m "feat(shared-types): add templateId to Game interface"
```

---

## Task 3: Update admin API composable type signatures

**Files:**
- Modify: `apps/admin/composables/useAdminApi.ts`

- [ ] **Step 1: Read the current type signatures**

Read `apps/admin/composables/useAdminApi.ts` lines around 130–132 to see:

```ts
getGameSettings: () => apiFetch<{ ball_interval_secs: number; bot_max_spend_etb: number; first_deposit_bonus_amount: number }>('/settings/game'),
updateGameSettings: (data: { ball_interval_secs?: number; bot_max_spend_etb?: number; first_deposit_bonus_amount?: number }) =>
  apiFetch('/settings/game', { method: 'PUT', body: data }),
```

- [ ] **Step 2: Update both type signatures**

Replace the two lines above with:

```ts
getGameSettings: () => apiFetch<{ ball_interval_secs: number; bot_max_spend_etb: number; first_deposit_bonus_amount: number; featured_template_id: string }>('/settings/game'),
updateGameSettings: (data: { ball_interval_secs?: number; bot_max_spend_etb?: number; first_deposit_bonus_amount?: number; featured_template_id?: string }) =>
  apiFetch('/settings/game', { method: 'PUT', body: data }),
```

- [ ] **Step 3: Typecheck admin app**

```bash
pnpm --filter @world-bingo/admin typecheck
```

Expected: no new errors

- [ ] **Step 4: Commit**

```bash
git add apps/admin/composables/useAdminApi.ts
git commit -m "feat(admin): add featured_template_id to game settings API types"
```

---

## Task 4: Admin UI — featured template selector

**Files:**
- Modify: `apps/admin/pages/settings/features.vue`

- [ ] **Step 1: Add `featured_template_id` field and templates list to the script**

In `apps/admin/pages/settings/features.vue`:

**4a.** In the destructure of `useAdminApi()` (line 2), add `getGameTemplates`:

Replace:
```ts
const { getFeatureFlags, updateFeatureFlags, getGameSettings, updateGameSettings } = useAdminApi()
```

With:
```ts
const { getFeatureFlags, updateFeatureFlags, getGameSettings, updateGameSettings, getGameTemplates } = useAdminApi()
```

**4b.** Add `featured_template_id` to the `gameSettings` reactive object (after `first_deposit_bonus_amount`):

Replace:
```ts
const gameSettings = reactive({
  ball_interval_secs: 3,
  bot_max_spend_etb: 500,
  first_deposit_bonus_amount: 0,
})
```

With:
```ts
const gameSettings = reactive({
  ball_interval_secs: 3,
  bot_max_spend_etb: 500,
  first_deposit_bonus_amount: 0,
  featured_template_id: '',
})

const templates = ref<{ id: string; title: string; active: boolean }[]>([])
```

**4c.** In `fetchAll`, add template fetch and `featured_template_id` population:

Replace:
```ts
const fetchAll = async () => {
  loading.value = true
  try {
    const [flags, gs] = await Promise.all([getFeatureFlags(), getGameSettings()])
    features.feature_referrals = flags.feature_referrals ?? false
    features.feature_tournaments = flags.feature_tournaments ?? false
    features.feature_third_party_games = flags.feature_third_party_games ?? false
    gameSettings.ball_interval_secs = gs.ball_interval_secs ?? 3
    gameSettings.bot_max_spend_etb = gs.bot_max_spend_etb ?? 500
    gameSettings.first_deposit_bonus_amount = gs.first_deposit_bonus_amount ?? 0
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load settings', color: 'error' })
  } finally {
    loading.value = false
  }
}
```

With:
```ts
const fetchAll = async () => {
  loading.value = true
  try {
    const [flags, gs, tmpl] = await Promise.all([getFeatureFlags(), getGameSettings(), getGameTemplates()])
    features.feature_referrals = flags.feature_referrals ?? false
    features.feature_tournaments = flags.feature_tournaments ?? false
    features.feature_third_party_games = flags.feature_third_party_games ?? false
    gameSettings.ball_interval_secs = gs.ball_interval_secs ?? 3
    gameSettings.bot_max_spend_etb = gs.bot_max_spend_etb ?? 500
    gameSettings.first_deposit_bonus_amount = gs.first_deposit_bonus_amount ?? 0
    gameSettings.featured_template_id = gs.featured_template_id ?? ''
    templates.value = Array.isArray(tmpl) ? tmpl.filter((t: any) => t.active) : []
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load settings', color: 'error' })
  } finally {
    loading.value = false
  }
}
```

**4d.** In `saveGameSettings`, include `featured_template_id`:

Replace:
```ts
    const result = await updateGameSettings({
      ball_interval_secs: gameSettings.ball_interval_secs,
      bot_max_spend_etb: gameSettings.bot_max_spend_etb,
      first_deposit_bonus_amount: gameSettings.first_deposit_bonus_amount,
    }) as any
    gameSettings.ball_interval_secs = result.ball_interval_secs
    gameSettings.bot_max_spend_etb = result.bot_max_spend_etb
    gameSettings.first_deposit_bonus_amount = result.first_deposit_bonus_amount
```

With:
```ts
    const result = await updateGameSettings({
      ball_interval_secs: gameSettings.ball_interval_secs,
      bot_max_spend_etb: gameSettings.bot_max_spend_etb,
      first_deposit_bonus_amount: gameSettings.first_deposit_bonus_amount,
      featured_template_id: gameSettings.featured_template_id,
    }) as any
    gameSettings.ball_interval_secs = result.ball_interval_secs
    gameSettings.bot_max_spend_etb = result.bot_max_spend_etb
    gameSettings.first_deposit_bonus_amount = result.first_deposit_bonus_amount
    gameSettings.featured_template_id = result.featured_template_id ?? ''
```

- [ ] **Step 2: Add featured template selector to the template**

In the template, find the end of the Game Engine settings card (the card containing Ball Interval, Bot Max Spend, First Deposit Bonus fields). After the last field's closing `</div>` block and before the Save button, add a new field block for featured game.

The Save button area looks like:
```html
          <div class="flex justify-end mt-4">
            <UButton ... @click="saveGameSettings">Save Game Settings</UButton>
          </div>
```

Add the featured template selector immediately before that `<div class="flex justify-end mt-4">`:

```html
          <!-- Featured Hero Game -->
          <div class="flex items-start gap-4 mb-4 mt-4 pt-4 border-t border-white/10">
            <div class="p-3 rounded-xl border border-amber-500/20 shrink-0" style="background:var(--surface-overlay);">
              <UIcon name="i-heroicons:star" class="w-6 h-6 text-amber-400" />
            </div>
            <div class="flex-1">
              <p class="text-sm font-bold text-white">Featured Hero Game</p>
              <p class="text-xs text-white/40 mt-1 font-medium leading-relaxed">Select a game template to feature in the home page hero banner. Leave empty to show the default bingo card art.</p>
              <div class="mt-3">
                <USelect
                  v-model="gameSettings.featured_template_id"
                  :options="[{ label: '— None (default art) —', value: '' }, ...templates.map(t => ({ label: t.title, value: t.id }))]"
                  class="w-72"
                  placeholder="Select a template…"
                />
              </div>
            </div>
          </div>
```

- [ ] **Step 3: Typecheck admin app**

```bash
pnpm --filter @world-bingo/admin typecheck
```

Expected: no new errors

- [ ] **Step 4: Commit**

```bash
git add apps/admin/pages/settings/features.vue
git commit -m "feat(admin): add featured template selector to system configuration"
```

---

## Task 5: Frontend — fetch and display featured game in hero

**Files:**
- Modify: `apps/web/pages/index.vue`

- [ ] **Step 1: Add `featuredTemplateId` state and `featuredGame` computed to the script**

In `apps/web/pages/index.vue`, after the line `const promotionsStore = usePromotionsStore()` (line ~11), add:

```ts
const featuredTemplateId = ref<string | null>(null)
```

After the `gamesByCategory` computed (or after `filteredGames` if Plan 1 was not yet merged), add:

```ts
const featuredGame = computed(() =>
  featuredTemplateId.value
    ? gameStore.availableGames.find((g) => g.templateId === featuredTemplateId.value) ?? null
    : null,
)
```

- [ ] **Step 2: Fetch `featured_template_id` in `onMounted`**

In `onMounted`, after `promotionsStore.fetch()`, add:

```ts
  $fetch<{ templateId: string | null }>(`${config.public.apiBase}/settings/featured-game`)
    .then((r) => { featuredTemplateId.value = r.templateId })
    .catch(() => {})
```

- [ ] **Step 3: Replace the hero art section with a conditional display**

In the template, the hero art currently is (lines ~135–191):

```html
        <div class="hero-art">
          <!-- Front bingo card -->
          <div class="bingo-card bingo-card--front">
            ...25 cells...
          </div>
          <!-- Back bingo card -->
          <div class="bingo-card bingo-card--back">
            ...25 cells...
          </div>
        </div>
```

Replace the entire `<div class="hero-art">` block with:

```html
        <div class="hero-art">
          <!-- Featured game card — shown when admin configured a template -->
          <template v-if="featuredGame">
            <div class="featured-game-card">
              <div class="fg-label">FEATURED GAME</div>
              <div class="fg-title">{{ featuredGame.title }}</div>
              <div class="fg-price">{{ Number(featuredGame.ticketPrice).toLocaleString() }} <span class="fg-etb">ETB</span></div>
              <div class="fg-meta">
                {{ patternLabel(featuredGame.pattern) }}
                &nbsp;·&nbsp;
                {{ gameStore.livePlayers[featuredGame.id] ?? (featuredGame as any).currentPlayers ?? 0 }}
                /
                {{ (featuredGame as any).maxPlayers ?? 10 }} players
              </div>
              <NuxtLink v-if="featuredGame.status === 'WAITING'" :to="`/quick/${featuredGame.id}`" class="fg-join">
                Join Now →
              </NuxtLink>
              <div v-else class="fg-live">
                <span class="live-dot"></span>
                {{ featuredGame.status === 'STARTING' ? 'Starting Soon' : 'LIVE' }}
              </div>
            </div>
          </template>

          <!-- Default art — shown when no featured game is configured -->
          <template v-else>
            <!-- Front bingo card -->
            <div class="bingo-card bingo-card--front">
              <div class="bc-cell">3</div>
              <div class="bc-cell">17</div>
              <div class="bc-cell">32</div>
              <div class="bc-cell bc-cell--gold">46</div>
              <div class="bc-cell">61</div>
              <div class="bc-cell bc-cell--blue">5</div>
              <div class="bc-cell">20</div>
              <div class="bc-cell">35</div>
              <div class="bc-cell">51</div>
              <div class="bc-cell bc-cell--gold">69</div>
              <div class="bc-cell">9</div>
              <div class="bc-cell">28</div>
              <div class="bc-cell bc-cell--free">FREE</div>
              <div class="bc-cell">53</div>
              <div class="bc-cell">74</div>
              <div class="bc-cell">14</div>
              <div class="bc-cell bc-cell--blue">24</div>
              <div class="bc-cell">39</div>
              <div class="bc-cell">48</div>
              <div class="bc-cell">63</div>
              <div class="bc-cell bc-cell--blue">1</div>
              <div class="bc-cell">16</div>
              <div class="bc-cell">44</div>
              <div class="bc-cell">60</div>
              <div class="bc-cell bc-cell--blue">75</div>
            </div>
            <!-- Back bingo card -->
            <div class="bingo-card bingo-card--back">
              <div class="bc-cell">7</div>
              <div class="bc-cell">19</div>
              <div class="bc-cell bc-cell--blue">33</div>
              <div class="bc-cell">49</div>
              <div class="bc-cell">62</div>
              <div class="bc-cell">2</div>
              <div class="bc-cell bc-cell--blue">21</div>
              <div class="bc-cell">36</div>
              <div class="bc-cell bc-cell--blue">52</div>
              <div class="bc-cell">70</div>
              <div class="bc-cell">11</div>
              <div class="bc-cell">29</div>
              <div class="bc-cell bc-cell--free">FREE</div>
              <div class="bc-cell">55</div>
              <div class="bc-cell bc-cell--blue">71</div>
              <div class="bc-cell">4</div>
              <div class="bc-cell bc-cell--blue">18</div>
              <div class="bc-cell">43</div>
              <div class="bc-cell bc-cell--blue">59</div>
              <div class="bc-cell">72</div>
              <div class="bc-cell">13</div>
              <div class="bc-cell">29</div>
              <div class="bc-cell bc-cell--blue">40</div>
              <div class="bc-cell">47</div>
              <div class="bc-cell">64</div>
            </div>
          </template>
        </div>
```

- [ ] **Step 4: Add CSS for the featured game card**

In the `<style scoped>` section of `apps/web/pages/index.vue`, add the following after the existing `.hero` styles:

```css
/* ── FEATURED GAME CARD (hero art replacement) ───────────────────────── */
.featured-game-card {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(245,158,11,0.3);
  border-radius: 20px;
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 220px;
  backdrop-filter: blur(8px);
}
.fg-label {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: #f59e0b;
  text-transform: uppercase;
}
.fg-title {
  font-size: 22px;
  font-weight: 800;
  color: #fff;
  line-height: 1.2;
}
.fg-price {
  font-size: 32px;
  font-weight: 900;
  color: #f59e0b;
  line-height: 1;
}
.fg-etb {
  font-size: 16px;
  font-weight: 700;
  color: rgba(245,158,11,0.7);
}
.fg-meta {
  font-size: 13px;
  color: rgba(255,255,255,0.55);
  font-weight: 600;
}
.fg-join {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #f59e0b;
  color: #000;
  font-weight: 800;
  font-size: 14px;
  padding: 10px 20px;
  border-radius: 10px;
  text-decoration: none;
  transition: background 0.15s;
  align-self: flex-start;
}
.fg-join:hover { background: #fbbf24; }
.fg-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #4ade80;
  font-weight: 800;
  font-size: 14px;
}
```

- [ ] **Step 5: Typecheck web app**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/pages/index.vue
git commit -m "feat(web): show featured game in hero when admin configures a template"
```
