# Admin-Configurable Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each deployment set its own brand (name, logo, favicon, full color theme) at runtime from the admin panel, with the player web app repainting accordingly and zero flash on load.

**Architecture:** A single Zod `BrandConfigSchema` + `DEFAULT_BRAND` in `shared-types` is the source of truth. A singleton `BrandSetting` Prisma row stores overrides (absent → defaults). The API exposes a public `GET /brand` (defaults merged with the row) plus admin `PUT /brand` and image-upload endpoints (reusing `storage.ts`). A Nuxt server plugin fetches the brand during SSR and injects `:root` CSS-variable overrides + name + favicon into `<head>` so the first byte is correctly branded. An admin Branding page edits everything with a live preview.

**Tech Stack:** TypeScript, Zod, Fastify v5, Prisma 5 (PostgreSQL), `@fastify/multipart`, Nuxt 3, Pinia/`useState`, `@nuxt/ui`, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-24-admin-configurable-branding-design.md`

---

## Canonical token set (used throughout)

These keys ARE the brand-controllable color tokens (mirror `packages/ui/src/styles/tokens.css`). Default values are the current World Bingo amber theme:

| Token key | CSS var(s) | Default |
|---|---|---|
| `surfaceBase` | `--surface-base` | `#0a0f1e` |
| `surfaceRaised` | `--surface-raised` | `#111827` |
| `surfaceOverlay` | `--surface-overlay` | `#1c2537` |
| `surfaceBorder` | `--surface-border` | `#1e2d4a` |
| `brandPrimary` | `--brand-primary` | `#f59e0b` |
| `brandPrimaryDim` | `--brand-primary-dim` | `#d97706` |
| `brandPrimaryGlow` | `--brand-primary-glow` | `rgba(245, 158, 11, 0.3)` |
| `accentPrimary` | `--accent-primary` | `#06b6d4` |
| `accentDim` | `--accent-dim` | `#0891b2` |
| `accentGlow` | `--accent-glow` | `rgba(6, 182, 212, 0.25)` |
| `statusSuccess` | `--status-success` | `#10b981` |
| `statusError` | `--status-error` | `#ef4444` |
| `statusWarning` | `--status-warning` | `#f59e0b` |
| `statusInfo` | `--status-info` | `#3b82f6` |
| `textPrimary` | `--text-primary`, `--wb-text-primary` | `#f1f5f9` |
| `textSecondary` | `--text-secondary`, `--wb-text-secondary` | `#94a3b8` |
| `textDisabled` | `--text-disabled`, `--wb-text-disabled` | `#475569` |
| `textOnBrand` | `--text-on-brand`, `--wb-text-on-brand` | `#000000` |
| `cartelaUnmarkedBg` | `--cartela-unmarked-bg` | `#1e2d4a` |
| `cartelaMarkedBg` | `--cartela-marked-bg` | `#0891b2` |
| `cartelaMarkedText` | `--cartela-marked-text` | `#ffffff` |
| `cartelaFreeBg` | `--cartela-free-bg` | `#f59e0b` |
| `cartelaFreeText` | `--cartela-free-text` | `#000000` |
| `numberCalledGlow` | `--number-called-glow` | `rgba(6, 182, 212, 0.6)` |
| `winnerGlow` | `--winner-glow` | `rgba(245, 158, 11, 0.8)` |
| `ballB` | `--ball-b` | `#f59e0b` |
| `ballI` | `--ball-i` | `#06b6d4` |
| `ballN` | `--ball-n` | `#8b5cf6` |
| `ballG` | `--ball-g` | `#10b981` |
| `ballO` | `--ball-o` | `#ef4444` |

---

## File Structure

- `packages/shared-types/src/brand.ts` — **new.** `BrandConfigSchema`, `BrandTokensSchema`, `BrandConfig`/`BrandTokens` types, `DEFAULT_BRAND`, `BRAND_TOKEN_CSS_VARS`, `brandTokensToCss()`.
- `packages/shared-types/src/brand.test.ts` — **new.** Schema + helper tests.
- `packages/shared-types/src/index.ts` — **modify.** Add `export * from './brand'`.
- `apps/api/prisma/schema.prisma` — **modify.** Add `BrandSetting` model.
- `apps/api/src/services/brand.service.ts` — **new.** `getBrand()` (merge), `updateBrand()` (validate + upsert).
- `apps/api/src/services/brand.service.test.ts` — **new.**
- `apps/api/src/routes/brand/index.ts` — **new.** Public `GET /` + admin `PUT /`, `POST /logo`, `POST /favicon`.
- `apps/api/src/routes/brand/brand.test.ts` — **new.**
- `apps/api/src/index.ts` — **modify.** Register `brandRoutes` at prefix `/brand`.
- `apps/web/composables/useBrand.ts` — **new.** Typed accessor over the brand `useState`.
- `apps/web/plugins/00.brand.ts` — **new.** SSR fetch + head injection.
- `apps/web/components/BrandLogo.vue` — **modify.** Read `logoUrl`/`displayName` from brand state; text fallback.
- `apps/admin/composables/useAdminApi.ts` — **modify.** Add `getBrand`, `updateBrand`, `uploadBrandLogo`, `uploadBrandFavicon`.
- `apps/admin/pages/settings/branding.vue` — **new.** Branding editor + live preview.

---

## Task 1: Brand schema, defaults, and CSS helper in shared-types

**Files:**
- Create: `packages/shared-types/src/brand.ts`
- Test: `packages/shared-types/src/brand.test.ts`
- Modify: `packages/shared-types/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared-types/src/brand.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  BrandConfigSchema,
  DEFAULT_BRAND,
  brandTokensToCss,
} from './brand'

describe('BrandConfigSchema', () => {
  it('accepts DEFAULT_BRAND', () => {
    expect(() => BrandConfigSchema.parse(DEFAULT_BRAND)).not.toThrow()
  })

  it('rejects an unknown token key', () => {
    const bad = { ...DEFAULT_BRAND, tokens: { ...DEFAULT_BRAND.tokens, notAToken: '#fff' } }
    expect(() => BrandConfigSchema.parse(bad)).toThrow()
  })

  it('rejects an invalid color value', () => {
    const bad = { ...DEFAULT_BRAND, tokens: { ...DEFAULT_BRAND.tokens, brandPrimary: 'teal' } }
    expect(() => BrandConfigSchema.parse(bad)).toThrow()
  })

  it('rejects an empty displayName', () => {
    expect(() => BrandConfigSchema.parse({ ...DEFAULT_BRAND, displayName: '' })).toThrow()
  })
})

describe('brandTokensToCss', () => {
  it('maps a token to its CSS variable', () => {
    const css = brandTokensToCss(DEFAULT_BRAND.tokens)
    expect(css).toContain('--brand-primary: #f59e0b;')
  })

  it('emits both aliases for text tokens', () => {
    const css = brandTokensToCss(DEFAULT_BRAND.tokens)
    expect(css).toContain('--text-primary: #f1f5f9;')
    expect(css).toContain('--wb-text-primary: #f1f5f9;')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/shared-types test -- brand`
Expected: FAIL — cannot resolve `./brand`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared-types/src/brand.ts`:

```typescript
import { z } from 'zod'

// Accept hex (#rgb / #rrggbb / #rrggbbaa) or rgb()/rgba() strings.
const colorValue = z
  .string()
  .regex(
    /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([^)]*\))$/,
    'Must be a hex (#rgb/#rrggbb) or rgb()/rgba() color',
  )

// Token key -> CSS custom property name(s). The map IS the closed set of keys.
export const BRAND_TOKEN_CSS_VARS = {
  surfaceBase: ['--surface-base'],
  surfaceRaised: ['--surface-raised'],
  surfaceOverlay: ['--surface-overlay'],
  surfaceBorder: ['--surface-border'],
  brandPrimary: ['--brand-primary'],
  brandPrimaryDim: ['--brand-primary-dim'],
  brandPrimaryGlow: ['--brand-primary-glow'],
  accentPrimary: ['--accent-primary'],
  accentDim: ['--accent-dim'],
  accentGlow: ['--accent-glow'],
  statusSuccess: ['--status-success'],
  statusError: ['--status-error'],
  statusWarning: ['--status-warning'],
  statusInfo: ['--status-info'],
  textPrimary: ['--text-primary', '--wb-text-primary'],
  textSecondary: ['--text-secondary', '--wb-text-secondary'],
  textDisabled: ['--text-disabled', '--wb-text-disabled'],
  textOnBrand: ['--text-on-brand', '--wb-text-on-brand'],
  cartelaUnmarkedBg: ['--cartela-unmarked-bg'],
  cartelaMarkedBg: ['--cartela-marked-bg'],
  cartelaMarkedText: ['--cartela-marked-text'],
  cartelaFreeBg: ['--cartela-free-bg'],
  cartelaFreeText: ['--cartela-free-text'],
  numberCalledGlow: ['--number-called-glow'],
  winnerGlow: ['--winner-glow'],
  ballB: ['--ball-b'],
  ballI: ['--ball-i'],
  ballN: ['--ball-n'],
  ballG: ['--ball-g'],
  ballO: ['--ball-o'],
} as const

export type BrandTokenKey = keyof typeof BRAND_TOKEN_CSS_VARS

// Build a strict object schema from the token-var map keys.
const tokensShape = Object.fromEntries(
  (Object.keys(BRAND_TOKEN_CSS_VARS) as BrandTokenKey[]).map((k) => [k, colorValue]),
) as Record<BrandTokenKey, typeof colorValue>

export const BrandTokensSchema = z.object(tokensShape).strict()
export type BrandTokens = z.infer<typeof BrandTokensSchema>

export const BrandConfigSchema = z
  .object({
    displayName: z.string().min(1).max(60),
    shortName: z.string().min(1).max(30),
    logoUrl: z.string().url().nullable(),
    faviconUrl: z.string().url().nullable(),
    tokens: BrandTokensSchema,
  })
  .strict()
export type BrandConfig = z.infer<typeof BrandConfigSchema>

// Partial update payload — any subset of fields, tokens can be partial.
export const BrandConfigUpdateSchema = z
  .object({
    displayName: z.string().min(1).max(60),
    shortName: z.string().min(1).max(30),
    logoUrl: z.string().url().nullable(),
    faviconUrl: z.string().url().nullable(),
    tokens: BrandTokensSchema.partial(),
  })
  .partial()
  .strict()
export type BrandConfigUpdate = z.infer<typeof BrandConfigUpdateSchema>

export const DEFAULT_BRAND: BrandConfig = {
  displayName: 'World Bingo',
  shortName: 'World',
  logoUrl: null,
  faviconUrl: null,
  tokens: {
    surfaceBase: '#0a0f1e',
    surfaceRaised: '#111827',
    surfaceOverlay: '#1c2537',
    surfaceBorder: '#1e2d4a',
    brandPrimary: '#f59e0b',
    brandPrimaryDim: '#d97706',
    brandPrimaryGlow: 'rgba(245, 158, 11, 0.3)',
    accentPrimary: '#06b6d4',
    accentDim: '#0891b2',
    accentGlow: 'rgba(6, 182, 212, 0.25)',
    statusSuccess: '#10b981',
    statusError: '#ef4444',
    statusWarning: '#f59e0b',
    statusInfo: '#3b82f6',
    textPrimary: '#f1f5f9',
    textSecondary: '#94a3b8',
    textDisabled: '#475569',
    textOnBrand: '#000000',
    cartelaUnmarkedBg: '#1e2d4a',
    cartelaMarkedBg: '#0891b2',
    cartelaMarkedText: '#ffffff',
    cartelaFreeBg: '#f59e0b',
    cartelaFreeText: '#000000',
    numberCalledGlow: 'rgba(6, 182, 212, 0.6)',
    winnerGlow: 'rgba(245, 158, 11, 0.8)',
    ballB: '#f59e0b',
    ballI: '#06b6d4',
    ballN: '#8b5cf6',
    ballG: '#10b981',
    ballO: '#ef4444',
  },
}

/** Render a brand's tokens as the body of a `:root { ... }` CSS block. */
export function brandTokensToCss(tokens: BrandTokens): string {
  const lines: string[] = []
  for (const key of Object.keys(BRAND_TOKEN_CSS_VARS) as BrandTokenKey[]) {
    const value = tokens[key]
    for (const cssVar of BRAND_TOKEN_CSS_VARS[key]) {
      lines.push(`${cssVar}: ${value};`)
    }
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Export from the package index**

Modify `packages/shared-types/src/index.ts` — add after the existing exports:

```typescript
export * from './brand'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/shared-types test -- brand`
Expected: PASS (6 tests).

- [ ] **Step 6: Build the package (apps import the built output)**

Run: `pnpm --filter @world-bingo/shared-types build`
Expected: Builds with no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared-types/src/brand.ts packages/shared-types/src/brand.test.ts packages/shared-types/src/index.ts
git commit -m "feat(shared-types): BrandConfig schema, DEFAULT_BRAND, token->CSS helper"
```

---

## Task 2: `BrandSetting` Prisma model + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (add model near `SiteSetting`, ~line 398)

- [ ] **Step 1: Add the model**

In `apps/api/prisma/schema.prisma`, immediately after the `SiteSetting` model, add:

```prisma
// Singleton white-label brand config. Absent row => app uses DEFAULT_BRAND.
model BrandSetting {
  id          String   @id @default("default")
  displayName String
  shortName   String
  logoUrl     String?
  faviconUrl  String?
  tokens      Json
  updatedAt   DateTime @updatedAt

  @@map("brand_settings")
}
```

- [ ] **Step 2: Create and apply the migration**

Run (from `apps/api/`): `pnpm db:migrate -- --name add_brand_setting`
(Equivalent: `pnpm prisma migrate dev --name add_brand_setting`.)
Expected: New migration created under `apps/api/prisma/migrations/`, applied; Prisma Client regenerated.

- [ ] **Step 3: Verify the client typechecks**

Run: `pnpm --filter @world-bingo/api exec prisma generate`
Expected: `prisma.brandSetting` is available (no error).

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add BrandSetting model + migration"
```

---

## Task 3: Brand service (merge defaults, validate + upsert)

**Files:**
- Create: `apps/api/src/services/brand.service.ts`
- Test: `apps/api/src/services/brand.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/brand.service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_BRAND } from '@world-bingo/shared-types'

vi.mock('../lib/prisma', () => ({
  default: {
    brandSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))

import prisma from '../lib/prisma'
import { BrandService } from './brand.service'

describe('BrandService.getBrand', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns DEFAULT_BRAND when no row exists', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue(null)
    const brand = await BrandService.getBrand()
    expect(brand).toEqual(DEFAULT_BRAND)
  })

  it('merges row over defaults, including partial tokens', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'Arada Bingo',
      shortName: 'Arada',
      logoUrl: 'https://x/logo.png',
      faviconUrl: null,
      tokens: { brandPrimary: '#14b8a6' },
      updatedAt: new Date(),
    })
    const brand = await BrandService.getBrand()
    expect(brand.displayName).toBe('Arada Bingo')
    expect(brand.tokens.brandPrimary).toBe('#14b8a6')
    // untouched token falls back to default
    expect(brand.tokens.accentPrimary).toBe(DEFAULT_BRAND.tokens.accentPrimary)
  })
})

describe('BrandService.updateBrand', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects an invalid token color', async () => {
    await expect(
      BrandService.updateBrand({ tokens: { brandPrimary: 'notacolor' } as any }),
    ).rejects.toThrow()
    expect(prisma.brandSetting.upsert).not.toHaveBeenCalled()
  })

  it('upserts a valid partial update and returns the merged brand', async () => {
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'Arada Bingo',
      shortName: 'Arada',
      logoUrl: null,
      faviconUrl: null,
      tokens: { brandPrimary: '#14b8a6' },
      updatedAt: new Date(),
    })
    const brand = await BrandService.updateBrand({ displayName: 'Arada Bingo' })
    expect(prisma.brandSetting.upsert).toHaveBeenCalledOnce()
    expect(brand.displayName).toBe('Arada Bingo')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- brand.service`
Expected: FAIL — cannot resolve `./brand.service`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/brand.service.ts`:

```typescript
import prisma from '../lib/prisma'
import {
  BrandConfig,
  BrandConfigUpdate,
  BrandConfigUpdateSchema,
  DEFAULT_BRAND,
} from '@world-bingo/shared-types'

const SINGLETON_ID = 'default'

/** Deep-merge a stored row over DEFAULT_BRAND. Missing token keys fall back. */
function mergeBrand(row: {
  displayName: string
  shortName: string
  logoUrl: string | null
  faviconUrl: string | null
  tokens: unknown
} | null): BrandConfig {
  if (!row) return DEFAULT_BRAND
  const rowTokens = (row.tokens ?? {}) as Partial<BrandConfig['tokens']>
  return {
    displayName: row.displayName ?? DEFAULT_BRAND.displayName,
    shortName: row.shortName ?? DEFAULT_BRAND.shortName,
    logoUrl: row.logoUrl ?? DEFAULT_BRAND.logoUrl,
    faviconUrl: row.faviconUrl ?? DEFAULT_BRAND.faviconUrl,
    tokens: { ...DEFAULT_BRAND.tokens, ...rowTokens },
  }
}

export class BrandService {
  /** Public read. Never throws — falls back to defaults on any DB error. */
  static async getBrand(): Promise<BrandConfig> {
    try {
      const row = await prisma.brandSetting.findUnique({ where: { id: SINGLETON_ID } })
      return mergeBrand(row as any)
    } catch {
      return DEFAULT_BRAND
    }
  }

  /** Admin write. Validates, then upserts the singleton, merging token partials. */
  static async updateBrand(input: BrandConfigUpdate): Promise<BrandConfig> {
    const patch = BrandConfigUpdateSchema.parse(input)

    const existing = await prisma.brandSetting.findUnique({ where: { id: SINGLETON_ID } })
    const existingTokens = ((existing?.tokens ?? {}) as Record<string, string>) || {}
    const mergedTokens = patch.tokens
      ? { ...existingTokens, ...patch.tokens }
      : existingTokens

    const data = {
      displayName: patch.displayName ?? existing?.displayName ?? DEFAULT_BRAND.displayName,
      shortName: patch.shortName ?? existing?.shortName ?? DEFAULT_BRAND.shortName,
      logoUrl: patch.logoUrl !== undefined ? patch.logoUrl : existing?.logoUrl ?? null,
      faviconUrl: patch.faviconUrl !== undefined ? patch.faviconUrl : existing?.faviconUrl ?? null,
      tokens: mergedTokens,
    }

    await prisma.brandSetting.upsert({
      where: { id: SINGLETON_ID },
      update: data,
      create: { id: SINGLETON_ID, ...data },
    })

    return BrandService.getBrand()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- brand.service`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/brand.service.ts apps/api/src/services/brand.service.test.ts
git commit -m "feat(api): BrandService — merge defaults + validated upsert"
```

---

## Task 4: Brand routes (public GET, admin PUT, image uploads)

**Files:**
- Create: `apps/api/src/routes/brand/index.ts`
- Test: `apps/api/src/routes/brand/brand.test.ts`
- Modify: `apps/api/src/index.ts` (register at prefix `/brand`)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/brand/brand.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { DEFAULT_BRAND } from '@world-bingo/shared-types'

vi.mock('../../services/brand.service', () => ({
  BrandService: { getBrand: vi.fn(), updateBrand: vi.fn() },
}))

import { BrandService } from '../../services/brand.service'
import brandRoutes from './index'

function build() {
  const app = Fastify()
  // Stub the admin guard the route references.
  app.decorate('requireAdmin', async () => {})
  app.register(brandRoutes, { prefix: '/brand' })
  return app
}

describe('brand routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET /brand returns the brand config (public)', async () => {
    ;(BrandService.getBrand as any).mockResolvedValue(DEFAULT_BRAND)
    const app = build()
    const res = await app.inject({ method: 'GET', url: '/brand' })
    expect(res.statusCode).toBe(200)
    expect(res.json().tokens.brandPrimary).toBe('#f59e0b')
    await app.close()
  })

  it('PUT /brand returns 400 on invalid body', async () => {
    ;(BrandService.updateBrand as any).mockRejectedValue(new Error('bad'))
    const app = build()
    const res = await app.inject({
      method: 'PUT',
      url: '/brand',
      payload: { tokens: { brandPrimary: 'nope' } },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('PUT /brand returns the updated brand on success', async () => {
    ;(BrandService.updateBrand as any).mockResolvedValue({ ...DEFAULT_BRAND, displayName: 'Arada Bingo' })
    const app = build()
    const res = await app.inject({ method: 'PUT', url: '/brand', payload: { displayName: 'Arada Bingo' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().displayName).toBe('Arada Bingo')
    await app.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- routes/brand`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/routes/brand/index.ts`:

```typescript
import { FastifyPluginAsync } from 'fastify'
import { BrandService } from '../../services/brand.service'
import { uploadFile } from '../../lib/storage'

const brandRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Public: GET /brand ──────────────────────────────────────────────
  // No auth — the web app reads this on every page load (SSR).
  fastify.get('/', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=30')
    return BrandService.getBrand()
  })

  // ── Admin: PUT /brand ───────────────────────────────────────────────
  fastify.put('/', { preValidation: [fastify.requireAdmin] }, async (req, reply) => {
    try {
      return await BrandService.updateBrand((req.body ?? {}) as any)
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? 'Invalid brand config' })
    }
  })

  // ── Admin: POST /brand/logo and /brand/favicon ──────────────────────
  for (const kind of ['logo', 'favicon'] as const) {
    fastify.post(`/${kind}`, { preValidation: [fastify.requireAdmin] }, async (req, reply) => {
      const part = await (req as any).file()
      if (!part) return reply.status(400).send({ error: 'No file uploaded' })
      try {
        const buffer = await part.toBuffer()
        const result = await uploadFile(buffer, part.filename, part.mimetype)
        return { url: result.url }
      } catch (err: any) {
        return reply.status(400).send({ error: err?.message ?? 'Upload failed' })
      }
    })
  }
}

export default brandRoutes
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- routes/brand`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the route plugin**

In `apps/api/src/index.ts`, alongside the other `server.register(...Routes, { prefix })` lines (~line 224-237), add an import near the other route imports and a registration line:

```typescript
import brandRoutes from './routes/brand/index.js'
```
```typescript
await server.register(brandRoutes, { prefix: '/brand' })
```

- [ ] **Step 6: Verify the server typechecks**

Run: `pnpm --filter @world-bingo/api typecheck`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/brand apps/api/src/index.ts
git commit -m "feat(api): brand routes — public GET, admin PUT + image uploads"
```

---

## Task 5: Web — fetch brand on SSR and inject theme (no flash)

**Files:**
- Create: `apps/web/composables/useBrand.ts`
- Create: `apps/web/plugins/00.brand.ts`
- Test: `apps/web/composables/useBrand.test.ts`

- [ ] **Step 1: Write the failing test (pure helper, no Nuxt runtime)**

Create `apps/web/composables/useBrand.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { brandTokensToCss, DEFAULT_BRAND } from '@world-bingo/shared-types'
import { buildBrandStyle } from './useBrand'

describe('buildBrandStyle', () => {
  it('wraps the token CSS in a :root block', () => {
    const style = buildBrandStyle(DEFAULT_BRAND.tokens)
    expect(style.startsWith(':root {')).toBe(true)
    expect(style).toContain(brandTokensToCss(DEFAULT_BRAND.tokens))
    expect(style.trim().endsWith('}')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/web test -- useBrand`
Expected: FAIL — cannot resolve `./useBrand`.

- [ ] **Step 3: Write the composable**

Create `apps/web/composables/useBrand.ts`:

```typescript
import { useState } from '#imports'
import {
  BrandConfig,
  BrandTokens,
  DEFAULT_BRAND,
  brandTokensToCss,
} from '@world-bingo/shared-types'

/** Build the `<style>` body that overrides the brand tokens at :root. */
export function buildBrandStyle(tokens: BrandTokens): string {
  return `:root {\n${brandTokensToCss(tokens)}\n}`
}

/** Shared SSR-hydrated brand state. Defaults to DEFAULT_BRAND. */
export function useBrand() {
  return useState<BrandConfig>('brand', () => DEFAULT_BRAND)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/web test -- useBrand`
Expected: PASS.

- [ ] **Step 5: Write the plugin**

Create `apps/web/plugins/00.brand.ts`:

```typescript
import { BrandConfig, DEFAULT_BRAND } from '@world-bingo/shared-types'
import { buildBrandStyle, useBrand } from '~/composables/useBrand'

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig()
  const brand = useBrand()

  // Fetch once on the server; the value is serialized into the payload and
  // reused on the client (useState), so no client refetch / no flash.
  if (import.meta.server) {
    try {
      const fetched = await $fetch<BrandConfig>(`${config.public.apiBase}/brand`)
      brand.value = fetched
    } catch {
      brand.value = DEFAULT_BRAND
    }
  }

  const b = brand.value
  useHead({
    title: b.displayName,
    titleTemplate: (t) => (t && t !== b.displayName ? `${t} · ${b.displayName}` : b.displayName),
    style: [{ id: 'brand-tokens', innerHTML: buildBrandStyle(b.tokens) }],
    link: b.faviconUrl ? [{ rel: 'icon', href: b.faviconUrl }] : [],
    meta: [{ name: 'application-name', content: b.displayName }],
  })
})
```

- [ ] **Step 6: Manual verification (dev server)**

Run the API and web (`pnpm --filter @world-bingo/api dev` and `pnpm --filter @world-bingo/web dev`).
In the browser, View Source on the player home page.
Expected: the served HTML `<head>` contains `<style id="brand-tokens">:root { --brand-primary: #f59e0b; … }</style>` and `<title>World Bingo</title>` — present in the raw HTML (proves SSR injection, no flash).

- [ ] **Step 7: Commit**

```bash
git add apps/web/composables/useBrand.ts apps/web/composables/useBrand.test.ts apps/web/plugins/00.brand.ts
git commit -m "feat(web): SSR brand fetch + :root token injection (no flash)"
```

---

## Task 6: Web — BrandLogo reads from brand state

**Files:**
- Modify: `apps/web/components/BrandLogo.vue`

- [ ] **Step 1: Replace the component**

Overwrite `apps/web/components/BrandLogo.vue` with:

```vue
<script setup lang="ts">
import { useBrand } from '~/composables/useBrand'

withDefaults(defineProps<{ height?: number }>(), { height: 30 })
const brand = useBrand()
</script>

<template>
  <img
    v-if="brand.logoUrl"
    :src="brand.logoUrl"
    :alt="brand.displayName"
    class="brand-logo"
    :style="{ height: `${height}px` }"
    decoding="async"
  />
  <span v-else class="brand-wordmark" :style="{ fontSize: `${height * 0.6}px` }">
    {{ brand.displayName }}
  </span>
</template>

<style scoped>
.brand-logo {
  display: block;
  width: auto;
}
.brand-wordmark {
  display: inline-block;
  font-family: var(--font-game, sans-serif);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--brand-primary);
  white-space: nowrap;
}
</style>
```

- [ ] **Step 2: Manual verification**

With API + web running and no `BrandSetting` row, load the home page.
Expected: header shows the "World Bingo" wordmark in brand-primary color (img fallback path, no broken image). After Task 8 sets a `logoUrl`, the image renders instead.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/BrandLogo.vue
git commit -m "feat(web): BrandLogo renders configured logo with text fallback"
```

---

## Task 7: Admin — API client methods for branding

**Files:**
- Modify: `apps/admin/composables/useAdminApi.ts`

- [ ] **Step 1: Inspect the existing composable**

Read `apps/admin/composables/useAdminApi.ts` to confirm the helper it uses for authed requests (e.g. an `apiFetch`/`$fetch` wrapper that attaches the admin JWT and base URL) and the exact return style of existing methods like `getFeatureFlags`/`updateFeatureFlags`. Mirror that wrapper below (shown here as `apiFetch`).

- [ ] **Step 2: Add brand methods**

Inside the object returned by `useAdminApi`, add (adapting `apiFetch` to the real wrapper name found in Step 1):

```typescript
  getBrand: () => apiFetch('/brand', { method: 'GET' }),

  updateBrand: (payload: Record<string, unknown>) =>
    apiFetch('/brand', { method: 'PUT', body: payload }),

  uploadBrandLogo: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return apiFetch('/brand/logo', { method: 'POST', body: form }) as Promise<{ url: string }>
  },

  uploadBrandFavicon: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return apiFetch('/brand/favicon', { method: 'POST', body: form }) as Promise<{ url: string }>
  },
```

Note: `GET /brand` is public; reusing the authed wrapper is fine (extra auth header is harmless). `PUT`/upload require the admin JWT the wrapper already attaches.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @world-bingo/admin typecheck`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/admin/composables/useAdminApi.ts
git commit -m "feat(admin): useAdminApi brand get/update/upload methods"
```

---

## Task 8: Admin — Branding settings page with live preview

**Files:**
- Create: `apps/admin/pages/settings/branding.vue`

- [ ] **Step 1: Confirm token metadata source**

This page imports the canonical token keys + defaults from shared-types so the form never drifts from the schema:

```typescript
import { BRAND_TOKEN_CSS_VARS, DEFAULT_BRAND, type BrandTokenKey } from '@world-bingo/shared-types'
```

- [ ] **Step 2: Create the page**

Create `apps/admin/pages/settings/branding.vue`:

```vue
<script setup lang="ts">
import { BRAND_TOKEN_CSS_VARS, DEFAULT_BRAND, type BrandTokenKey } from '@world-bingo/shared-types'

const { getBrand, updateBrand, uploadBrandLogo, uploadBrandFavicon } = useAdminApi()
const toast = useToast()

const loading = ref(true)
const saving = ref(false)

const form = reactive({
  displayName: DEFAULT_BRAND.displayName,
  shortName: DEFAULT_BRAND.shortName,
  logoUrl: DEFAULT_BRAND.logoUrl as string | null,
  faviconUrl: DEFAULT_BRAND.faviconUrl as string | null,
  tokens: { ...DEFAULT_BRAND.tokens },
})

// Group tokens for display by key prefix.
const GROUPS: { title: string; match: (k: BrandTokenKey) => boolean }[] = [
  { title: 'Brand', match: (k) => k.startsWith('brand') },
  { title: 'Accent', match: (k) => k.startsWith('accent') },
  { title: 'Surface', match: (k) => k.startsWith('surface') },
  { title: 'Text', match: (k) => k.startsWith('text') },
  { title: 'Status', match: (k) => k.startsWith('status') },
  { title: 'Balls', match: (k) => k.startsWith('ball') },
  { title: 'Cartela', match: (k) => k.startsWith('cartela') || k.endsWith('Glow') },
]
const tokenKeys = Object.keys(BRAND_TOKEN_CSS_VARS) as BrandTokenKey[]
function keysFor(group: (typeof GROUPS)[number]) {
  return tokenKeys.filter(group.match)
}

const previewStyle = computed(() =>
  Object.fromEntries(
    tokenKeys.flatMap((k) => BRAND_TOKEN_CSS_VARS[k].map((v) => [v, form.tokens[k]])),
  ),
)

async function load() {
  loading.value = true
  try {
    const b = await getBrand()
    form.displayName = b.displayName
    form.shortName = b.shortName
    form.logoUrl = b.logoUrl
    form.faviconUrl = b.faviconUrl
    form.tokens = { ...DEFAULT_BRAND.tokens, ...b.tokens }
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load branding', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function onLogo(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const { url } = await uploadBrandLogo(file)
    form.logoUrl = url
    toast.add({ title: 'Logo uploaded', color: 'success' })
  } catch {
    toast.add({ title: 'Upload failed', color: 'error' })
  }
}

async function onFavicon(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const { url } = await uploadBrandFavicon(file)
    form.faviconUrl = url
    toast.add({ title: 'Favicon uploaded', color: 'success' })
  } catch {
    toast.add({ title: 'Upload failed', color: 'error' })
  }
}

async function save() {
  saving.value = true
  try {
    await updateBrand({
      displayName: form.displayName,
      shortName: form.shortName,
      logoUrl: form.logoUrl,
      faviconUrl: form.faviconUrl,
      tokens: form.tokens,
    })
    toast.add({ title: 'Branding saved', description: 'Reload the player app to see changes.', color: 'success' })
  } catch (err: any) {
    toast.add({ title: 'Save failed', description: err?.data?.error ?? 'Invalid values', color: 'error' })
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="p-6 space-y-6">
    <h1 class="text-xl font-semibold">Branding</h1>

    <div v-if="loading">Loading…</div>
    <template v-else>
      <section class="grid gap-4 sm:grid-cols-2 max-w-xl">
        <label class="flex flex-col gap-1">
          <span class="text-sm">Display name</span>
          <input v-model="form.displayName" class="border rounded px-2 py-1" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm">Short name</span>
          <input v-model="form.shortName" class="border rounded px-2 py-1" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm">Logo</span>
          <input type="file" accept="image/*" @change="onLogo" />
          <img v-if="form.logoUrl" :src="form.logoUrl" alt="logo preview" class="h-8 mt-1" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm">Favicon</span>
          <input type="file" accept="image/*" @change="onFavicon" />
          <img v-if="form.faviconUrl" :src="form.faviconUrl" alt="favicon preview" class="h-6 mt-1" />
        </label>
      </section>

      <section v-for="group in GROUPS" :key="group.title" class="space-y-2">
        <h2 class="font-medium">{{ group.title }}</h2>
        <div class="grid gap-3 sm:grid-cols-3">
          <label v-for="k in keysFor(group)" :key="k" class="flex items-center gap-2 text-sm">
            <input type="color" v-model="form.tokens[k]" class="h-7 w-9 p-0 border rounded" />
            <input v-model="form.tokens[k]" class="border rounded px-2 py-1 flex-1 font-mono text-xs" />
            <span class="text-xs text-gray-500">{{ k }}</span>
          </label>
        </div>
      </section>

      <section class="space-y-2">
        <h2 class="font-medium">Live preview</h2>
        <div :style="previewStyle" class="rounded-lg p-4 flex flex-wrap gap-3 items-center"
          style="background: var(--surface-base)">
          <span :style="{ background: 'var(--brand-primary)', color: 'var(--text-on-brand)' }"
            class="px-3 py-1 rounded font-semibold">Primary</span>
          <span :style="{ background: 'var(--accent-primary)', color: '#fff' }"
            class="px-3 py-1 rounded">Accent</span>
          <span :style="{ background: 'var(--cartela-marked-bg)', color: 'var(--cartela-marked-text)' }"
            class="px-3 py-1 rounded">Marked</span>
          <span :style="{ color: 'var(--text-primary)' }">Text primary</span>
        </div>
      </section>

      <button :disabled="saving" class="px-4 py-2 rounded bg-primary text-white" @click="save">
        {{ saving ? 'Saving…' : 'Save branding' }}
      </button>
    </template>
  </div>
</template>
```

Note: `type="color"` requires `#rrggbb` values; the paired text input lets the admin enter `rgba(...)` glow tokens. The page follows the existing `settings/*.vue` layout/auth conventions (route is under `pages/settings/`, already guarded by the admin layout/middleware like its siblings).

- [ ] **Step 3: Add a nav entry (if settings nav is a static list)**

If the admin settings navigation is a hardcoded list (check the settings layout/index), add a link to `/settings/branding` labeled "Branding" next to the existing entries. If nav is route-derived, skip.

- [ ] **Step 4: Manual end-to-end verification**

With API + web + admin running:
1. Admin → Settings → Branding. Confirm it loads current values (World Bingo amber).
2. Set displayName "Arada Bingo", shortName "Arada", upload the Arada logo, set `brandPrimary` `#14b8a6`, `brandPrimaryDim` `#0d9488`, `surfaceBase` to a dark teal. Save → success toast.
3. Reload the player app. Expected: header shows the Arada logo, accents are teal, title is "Arada Bingo". View Source confirms `--brand-primary: #14b8a6` in the `#brand-tokens` style (no flash).
4. (Isolation check) Confirm a separate DB with no row still renders World Bingo amber.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/pages/settings/branding.vue
git commit -m "feat(admin): Branding settings page with full token editor + live preview"
```

---

## Final verification

- [ ] Run `pnpm typecheck` (all packages) — expect no errors.
- [ ] Run `pnpm test` — expect brand tests green across shared-types, api.
- [ ] Run `pnpm --filter @world-bingo/shared-types build` then `pnpm build` — expect clean build.
- [ ] Manual end-to-end (Task 8 Step 4) passes.

## Known limitation (documented, not in scope)

PWA `manifest.webmanifest` `name`/`short_name`/`theme_color` remain build-time
values in `apps/web/nuxt.config.ts`. They drive the OS install banner only, not
in-app paint. A later task can serve a dynamic manifest route from the brand
config if per-instance install metadata is required.
