# Promotion Banners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two small promotional banners (cashback and first-deposit-bonus) between the hero section and the game list on the player home page, with data pulled from the backend.

**Architecture:** A new public `GET /promotions` API route queries the DB for the first active cashback promotion and the `first_deposit_bonus_amount` site setting, then returns both. A `promotions` Pinia store fetches this on home page mount. Two banner components (`CashbackBanner.vue`, `FirstDepositBanner.vue`) read from that store and render only when data is non-null.

**Tech Stack:** Fastify v5, Prisma 5, Vitest (API tests), Nuxt 3, Vue 3, Pinia, Tailwind CSS, `@nuxtjs/i18n`

---

## File Map

**New files:**
- `apps/api/src/services/promotions.service.ts` — DB query logic
- `apps/api/src/routes/promotions/index.ts` — public Fastify route
- `apps/api/src/test/promotions.service.test.ts` — Vitest integration tests
- `apps/web/store/promotions.ts` — Pinia store
- `apps/web/components/CashbackBanner.vue` — banner component
- `apps/web/components/FirstDepositBanner.vue` — banner component

**Modified files:**
- `apps/api/src/index.ts` — register promotions route
- `apps/web/locales/en.json` — add `promo` i18n section
- `apps/web/locales/am.json` — add `promo` i18n section
- `apps/web/pages/index.vue` — fetch promotions + render banners

---

## Task 1: PromotionsService + API route

**Files:**
- Create: `apps/api/src/services/promotions.service.ts`
- Create: `apps/api/src/routes/promotions/index.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/src/test/promotions.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/promotions.service.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { PromotionsService } from '../services/promotions.service'
import { prisma } from './setup'

describe('PromotionsService.getPromotions', () => {
  it('returns null for both when nothing is configured', async () => {
    const result = await PromotionsService.getPromotions()
    expect(result.cashback).toBeNull()
    expect(result.firstDepositBonus).toBeNull()
  })

  it('returns cashback promo when one is active within date range', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Weekly Cashback',
        lossThreshold: 100,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.cashback).toEqual({
      name: 'Weekly Cashback',
      refundType: 'PERCENTAGE',
      refundValue: 10,
      frequency: 'WEEKLY',
    })
  })

  it('returns null for cashback when promotion isActive is false', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Inactive Promo',
        lossThreshold: 100,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: false,
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.cashback).toBeNull()
  })

  it('returns null for cashback when promotion has expired', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Expired Promo',
        lossThreshold: 100,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() - 1000),
      },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.cashback).toBeNull()
  })

  it('returns firstDepositBonus as a number when site setting is configured with a positive value', async () => {
    await prisma.siteSetting.create({
      data: { key: 'first_deposit_bonus_amount', value: '50' },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.firstDepositBonus).toBe(50)
  })

  it('returns null for firstDepositBonus when setting value is 0', async () => {
    await prisma.siteSetting.create({
      data: { key: 'first_deposit_bonus_amount', value: '0' },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.firstDepositBonus).toBeNull()
  })

  it('returns both cashback and firstDepositBonus when both are configured', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Monthly Fixed',
        lossThreshold: 200,
        refundType: 'FIXED',
        refundValue: 30,
        frequency: 'MONTHLY',
        isActive: true,
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    })
    await prisma.siteSetting.create({
      data: { key: 'first_deposit_bonus_amount', value: '100' },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.cashback?.refundType).toBe('FIXED')
    expect(result.cashback?.refundValue).toBe(30)
    expect(result.firstDepositBonus).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd apps/api && pnpm test -- --reporter=verbose promotions.service.test.ts
```

Expected: `FAIL` — `Cannot find module '../services/promotions.service'`

- [ ] **Step 3: Create the PromotionsService**

Create `apps/api/src/services/promotions.service.ts`:

```ts
import prisma from '../lib/prisma'

export interface CashbackPromoResult {
  name: string
  refundType: 'PERCENTAGE' | 'FIXED'
  refundValue: number
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
}

export interface PromotionsResult {
  cashback: CashbackPromoResult | null
  firstDepositBonus: number | null
}

export class PromotionsService {
  /**
   * Returns the first currently-active cashback promotion and the configured
   * first-deposit bonus amount. Returns null for either field when not set up.
   * firstDepositBonus is null when the setting is missing OR set to 0.
   */
  static async getPromotions(): Promise<PromotionsResult> {
    const now = new Date()

    const [cashbackRow, bonusSetting] = await Promise.all([
      prisma.cashbackPromotion.findFirst({
        where: {
          isActive: true,
          startsAt: { lte: now },
          endsAt: { gte: now },
        },
        select: {
          name: true,
          refundType: true,
          refundValue: true,
          frequency: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.siteSetting.findUnique({
        where: { key: 'first_deposit_bonus_amount' },
      }),
    ])

    const firstDepositBonus = bonusSetting ? Number(bonusSetting.value) : 0

    return {
      cashback: cashbackRow
        ? {
            name: cashbackRow.name,
            refundType: cashbackRow.refundType as 'PERCENTAGE' | 'FIXED',
            refundValue: Number(cashbackRow.refundValue),
            frequency: cashbackRow.frequency as 'DAILY' | 'WEEKLY' | 'MONTHLY',
          }
        : null,
      firstDepositBonus: firstDepositBonus > 0 ? firstDepositBonus : null,
    }
  }
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
cd apps/api && pnpm test -- --reporter=verbose promotions.service.test.ts
```

Expected: `7 passed`

- [ ] **Step 5: Create the Fastify route**

Create `apps/api/src/routes/promotions/index.ts`:

```ts
import { FastifyPluginAsync } from 'fastify'
import { PromotionsService } from '../../services/promotions.service'

const promotionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (_req, _reply) => {
    return PromotionsService.getPromotions()
  })
}

export default promotionsRoutes
```

- [ ] **Step 6: Register the route in index.ts**

In `apps/api/src/index.ts`, add the import alongside the other route imports:

```ts
import promotionsRoutes from './routes/promotions'
```

And add the registration alongside the other `server.register` calls (after the `settingsRoutes` line):

```ts
await server.register(promotionsRoutes, { prefix: '/promotions' })
```

- [ ] **Step 7: Typecheck**

```bash
cd apps/api && pnpm typecheck
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/promotions.service.ts \
        apps/api/src/routes/promotions/index.ts \
        apps/api/src/test/promotions.service.test.ts \
        apps/api/src/index.ts
git commit -m "feat(api): add public GET /promotions endpoint"
```

---

## Task 2: i18n strings

**Files:**
- Modify: `apps/web/locales/en.json`
- Modify: `apps/web/locales/am.json`

- [ ] **Step 1: Add the `promo` section to en.json**

Add the following block to `apps/web/locales/en.json`, before the closing `}`:

```json
,
  "promo": {
    "cashback_percentage": "Get {value}% cashback on your {frequency} losses",
    "cashback_fixed": "Get {value} ETB cashback on your {frequency} losses",
    "first_deposit": "Get {amount} ETB bonus on your first deposit",
    "frequency_daily": "daily",
    "frequency_weekly": "weekly",
    "frequency_monthly": "monthly"
  }
```

The result should be a valid JSON file ending with:
```json
  "promo": {
    "cashback_percentage": "Get {value}% cashback on your {frequency} losses",
    "cashback_fixed": "Get {value} ETB cashback on your {frequency} losses",
    "first_deposit": "Get {amount} ETB bonus on your first deposit",
    "frequency_daily": "daily",
    "frequency_weekly": "weekly",
    "frequency_monthly": "monthly"
  }
}
```

- [ ] **Step 2: Add the `promo` section to am.json**

Add the following block to `apps/web/locales/am.json`, before the closing `}`:

```json
,
  "promo": {
    "cashback_percentage": "በ{frequency} ኪሳራዎ {value}% ካሽባክ ያሸናሉ",
    "cashback_fixed": "በ{frequency} ኪሳራዎ {value} ብር ካሽባክ ያሸናሉ",
    "first_deposit": "በመጀመሪያ ብር ሲጨምሩ {amount} ብር ጉርሻ ያገኛሉ",
    "frequency_daily": "ዕለታዊ",
    "frequency_weekly": "ሳምንታዊ",
    "frequency_monthly": "ወርሃዊ"
  }
```

- [ ] **Step 3: Validate both files are valid JSON**

```bash
node -e "require('./apps/web/locales/en.json'); console.log('en.json OK')"
node -e "require('./apps/web/locales/am.json'); console.log('am.json OK')"
```

Expected: `en.json OK` and `am.json OK`

- [ ] **Step 4: Commit**

```bash
git add apps/web/locales/en.json apps/web/locales/am.json
git commit -m "feat(web): add promo i18n strings (en + am)"
```

---

## Task 3: Promotions Pinia store

**Files:**
- Create: `apps/web/store/promotions.ts`

- [ ] **Step 1: Create the store**

Create `apps/web/store/promotions.ts`:

```ts
import { defineStore } from 'pinia'

interface CashbackPromo {
  name: string
  refundType: 'PERCENTAGE' | 'FIXED'
  refundValue: number
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
}

interface PromotionsState {
  cashback: CashbackPromo | null
  firstDepositBonus: number | null
}

export const usePromotionsStore = defineStore('promotions', {
  state: (): PromotionsState => ({
    cashback: null,
    firstDepositBonus: null,
  }),
  actions: {
    async fetch() {
      const config = useRuntimeConfig()
      try {
        const data = await $fetch<{ cashback: CashbackPromo | null; firstDepositBonus: number | null }>(
          `${config.public.apiBase}/promotions`,
        )
        this.cashback = data.cashback
        this.firstDepositBonus = data.firstDepositBonus
      } catch {
        // silently ignore — banners remain hidden
      }
    },
  },
})
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/store/promotions.ts
git commit -m "feat(web): add promotions Pinia store"
```

---

## Task 4: CashbackBanner component

**Files:**
- Create: `apps/web/components/CashbackBanner.vue`

- [ ] **Step 1: Create the component**

Create `apps/web/components/CashbackBanner.vue`:

```vue
<script setup lang="ts">
import { usePromotionsStore } from '~/store/promotions'

const { t } = useI18n()
const store = usePromotionsStore()

const cashbackText = computed(() => {
  const c = store.cashback
  if (!c) return ''
  const freq = t(`promo.frequency_${c.frequency.toLowerCase()}`)
  if (c.refundType === 'PERCENTAGE') {
    return t('promo.cashback_percentage', { value: c.refundValue, frequency: freq })
  }
  return t('promo.cashback_fixed', { value: c.refundValue, frequency: freq })
})
</script>

<template>
  <div
    v-if="store.cashback"
    class="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
  >
    <span aria-hidden="true">💰</span>
    <span>{{ cashbackText }}</span>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/CashbackBanner.vue
git commit -m "feat(web): add CashbackBanner component"
```

---

## Task 5: FirstDepositBanner component

**Files:**
- Create: `apps/web/components/FirstDepositBanner.vue`

- [ ] **Step 1: Create the component**

Create `apps/web/components/FirstDepositBanner.vue`:

```vue
<script setup lang="ts">
import { usePromotionsStore } from '~/store/promotions'

const { t } = useI18n()
const store = usePromotionsStore()
</script>

<template>
  <div
    v-if="store.firstDepositBonus"
    class="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
  >
    <span aria-hidden="true">🎁</span>
    <span>{{ t('promo.first_deposit', { amount: store.firstDepositBonus }) }}</span>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/FirstDepositBanner.vue
git commit -m "feat(web): add FirstDepositBanner component"
```

---

## Task 6: Wire up banners in index.vue

**Files:**
- Modify: `apps/web/pages/index.vue`

The hero section ends at line 199 (`</section>`) and the game-type tabs section begins at line 201 (`<div class="tabs-bar">`). The banners go between them.

- [ ] **Step 1: Import and call promotionsStore.fetch() in the script**

In `apps/web/pages/index.vue`, the `<script setup>` block currently starts with these imports:

```ts
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import { useProviderGamesStore } from '~/store/provider-games'
```

Add the promotions store import and instantiation after the existing store imports:

Replace:
```ts
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import { useProviderGamesStore } from '~/store/provider-games'
import type { Game } from '@world-bingo/shared-types'

const auth = useAuthStore()
const gameStore = useGameStore()
const providerStore = useProviderGamesStore()
```

With:
```ts
import { useGameStore } from '~/store/game'
import { useAuthStore } from '~/store/auth'
import { useProviderGamesStore } from '~/store/provider-games'
import { usePromotionsStore } from '~/store/promotions'
import type { Game } from '@world-bingo/shared-types'

const auth = useAuthStore()
const gameStore = useGameStore()
const providerStore = useProviderGamesStore()
const promotionsStore = usePromotionsStore()
```

- [ ] **Step 2: Call fetch() in onMounted**

In `apps/web/pages/index.vue`, the `onMounted` block currently starts with:

```ts
onMounted(async () => {
  try {
    await gameStore.fetchAvailableGames()
  } catch { /* errors are stored in gameStore.error */ }
```

Add the promotions fetch call right after the gameStore fetch:

Replace:
```ts
onMounted(async () => {
  try {
    await gameStore.fetchAvailableGames()
  } catch { /* errors are stored in gameStore.error */ }
```

With:
```ts
onMounted(async () => {
  try {
    await gameStore.fetchAvailableGames()
  } catch { /* errors are stored in gameStore.error */ }

  promotionsStore.fetch()
```

Note: `promotionsStore.fetch()` is intentionally not awaited — it is fire-and-forget. Failure is silently ignored inside the store.

- [ ] **Step 3: Add the banners between hero and tabs in the template**

In `apps/web/pages/index.vue`, find the end of the hero section and the start of the tabs bar. It currently looks like:

```html
    </section>

    <!-- ── GAME TYPE TABS ─────────────────────────────────────── -->
    <div class="tabs-bar">
```

Replace with:

```html
    </section>

    <!-- ── PROMOTION BANNERS ─────────────────────────────────── -->
    <div class="max-container flex flex-col gap-2 px-4 pt-4">
      <CashbackBanner />
      <FirstDepositBanner />
    </div>

    <!-- ── GAME TYPE TABS ─────────────────────────────────────── -->
    <div class="tabs-bar">
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/pages/index.vue
git commit -m "feat(web): render promo banners on home page between hero and game list"
```
