# Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-selectable `theme` axis to `apps/web` that owns typography, density and page shell, supplies a default colour palette which explicit brand tokens override, and ships two themes — `arada` (current look) and `dash5`.

**Architecture:** Theme data is pure TypeScript in `packages/shared-types/src/themes/` so the API can read a theme's default palette; the Vue shell components live in `apps/web/theme/shells.ts`. The active theme id rides on the existing `BrandSetting` row and `GET /brand` payload, so no new endpoint or network call is introduced. `apps/web/plugins/00.brand.ts` stamps `data-theme` on `<html>` and injects two style blocks — theme typography/density, then brand colours. `layouts/default.vue` becomes a dispatcher that picks a shell component from `shells[themeId][route.meta.shell]`.

**Tech Stack:** TypeScript, Zod 3, Prisma 5 + PostgreSQL, Fastify 5, Nuxt 3 / Vue 3, Vitest 3, Playwright.

## Global Constraints

- Package manager is **pnpm**; the repo is a **Turborepo** monorepo. `packages/*` must build before `apps/*`.
- Prettier config: **singleQuote, no semicolons, trailingComma: all**. Match it in every file you touch.
- Colour token values must be hex (`#rgb`/`#rrggbb`/`#rrggbbaa`) or `rgb()`/`rgba()` — enforced by `colorValue` in `packages/shared-types/src/brand.ts`. No `hsl()`, no bare colour names.
- **Never** put a raw hex colour or a `font-family:` declaration inside a `.vue` file under `apps/web/components/`. `apps/web/test/no-hardcoded-theme.test.ts` enforces this; Task 7 extends it to cover `components/shells`. Colours belong in tokens; literal colours that are genuinely theme-specific (e.g. a gradient's dark stop) belong in `apps/web/assets/css/themes/*.css`, which is not scanned.
- CSS custom properties must **not** be named `--text-*` for anything that is not a colour. Tailwind v4 collides with that namespace; see the existing comment in `packages/ui/src/styles/tokens.css`. Base font size uses `--wb-font-size-base`.
- `themeToCssVars` output is injected at **`:root:root`** (specificity 0,2,0). This is required: `packages/ui/src/theme/tokens.base.css` defines `--radius-sm/md/lg` at plain `:root`, and a theme must outrank it regardless of stylesheet order. Brand colours keep their existing `:root:root` block. The two never emit the same property — themes emit no colours, brand emits no typography or density.
- Verification: per repo memory, `apps/admin` typecheck, `apps/web` `pnpm test` and `pnpm lint` are red or blind by default in this repo. **Confirm results by reading the per-file output, not the exit code.** `apps/api` is the exception and its exit codes can be trusted.

### Design quality constraints

These apply to every stylesheet and shell in this plan.

- **No emojis** in code, markup, copy, or alt text — including toast messages. Use an inline SVG or an
  icon component. Where you touch a string that already contains one, remove it.
- **Viewport stability:** full-height shells use `min-height: 100dvh`, never `100vh`. `100vh` jumps
  catastrophically on iOS Safari when the URL bar collapses.
- **Grid, not flex math:** multi-column layout uses CSS Grid with `fr` units. Never
  `width: calc(33% - 1rem)`.
- **Every interactive element needs four states:** rest, `:hover`, `:active` (tactile — `scale(0.98)`
  or a 1px translate), and `:focus-visible` (a visible ring; keyboard users currently get nothing).
- **Animate `transform` and `opacity` only.** Never `top`/`left`/`width`/`height`. No
  `window.addEventListener('scroll')`. `tokens.base.css` already honours `prefers-reduced-motion`.
- **Z-index restraint:** only for systemic layers (sticky chrome, modal, toast) using the existing
  `--z-*` tokens. No arbitrary `z-50`.
- **Numeric readouts** (balances, counts, odds) get `font-variant-numeric: tabular-nums` so digits
  stop jittering as values update.
- **Fidelity beats house style where they conflict.** `dash5` deliberately uses a near-black ground,
  a highly saturated accent and 13px/27px density because it is reproducing a specific reference.
  Do not desaturate, loosen, or "improve" those values. `arada`'s palette is likewise frozen.

---

### Task 1: Theme contract and registry

Creates the pure-data theme module and deletes the orphaned parallel registry it supersedes.

**Files:**
- Create: `packages/shared-types/src/themes/types.ts`
- Create: `packages/shared-types/src/themes/arada.ts`
- Create: `packages/shared-types/src/themes/dash5.ts`
- Create: `packages/shared-types/src/themes/index.ts`
- Create: `packages/shared-types/src/themes/themes.test.ts`
- Modify: `packages/shared-types/src/index.ts`
- Delete: `packages/ui/src/theme/types.ts`, `resolveBrand.ts`, `resolveBrand.test.ts`, `brandToCssVars.ts`, `brandToCssVars.test.ts`, `brands/arada.ts`, `brands/index.ts`
- Modify: `packages/ui/src/index.ts:12-15`

**Interfaces:**
- Consumes: `BrandTokens`, `DEFAULT_BRAND` from `packages/shared-types/src/brand.ts`
- Produces:
  - `THEME_IDS: readonly ['arada', 'dash5']`, `type ThemeId`
  - `SHELL_KEYS: readonly ['rails', 'wide']`, `type ShellKey`
  - `interface ThemeTypography { ui: string; body: string; heading: string; googleHref: string | null; baseSize: string }`
  - `interface ThemeDensity { utilH, navH, rowH, controlH, inputH, railW, asideW, radiusSm, radiusMd, radiusLg, borderW: string }`
  - `interface ThemeDefinition { id: ThemeId; name: string; defaultTokens: BrandTokens; typography: ThemeTypography; density: ThemeDensity }`
  - `themes: Record<ThemeId, ThemeDefinition>`
  - `DEFAULT_THEME_ID: ThemeId`
  - `resolveTheme(id: string | undefined): ThemeDefinition`
  - `themeToCssVars(theme: ThemeDefinition): string`

- [ ] **Step 1: Write the failing test**

Create `packages/shared-types/src/themes/themes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BrandTokensSchema, DEFAULT_BRAND } from '../brand'
import { THEME_IDS, themes, DEFAULT_THEME_ID, resolveTheme, themeToCssVars } from './index'

describe('theme registry', () => {
  it('registers every declared id', () => {
    expect(Object.keys(themes).sort()).toEqual([...THEME_IDS].sort())
  })

  it('keys each theme by its own id', () => {
    for (const [key, theme] of Object.entries(themes)) {
      expect(theme.id).toBe(key)
    }
  })

  it('gives every theme a full, valid palette', () => {
    for (const theme of Object.values(themes)) {
      expect(() => BrandTokensSchema.parse(theme.defaultTokens)).not.toThrow()
    }
  })

  it('keeps arada identical to the shipped brand defaults', () => {
    expect(themes.arada.defaultTokens).toEqual(DEFAULT_BRAND.tokens)
  })

  it('gives dash5 its own palette', () => {
    expect(themes.dash5.defaultTokens.brandPrimary).toBe('#00ff9d')
    expect(themes.dash5.defaultTokens.surfaceRaised).toBe('#06262d')
  })
})

describe('resolveTheme', () => {
  it('returns the named theme', () => {
    expect(resolveTheme('dash5').id).toBe('dash5')
  })

  it('falls back to the default for undefined', () => {
    expect(resolveTheme(undefined).id).toBe(DEFAULT_THEME_ID)
  })

  it('falls back to the default for an unknown id', () => {
    expect(resolveTheme('nope').id).toBe(DEFAULT_THEME_ID)
  })
})

describe('themeToCssVars', () => {
  it('emits typography', () => {
    const css = themeToCssVars(themes.dash5)
    expect(css).toContain("--font-ui: 'Roboto Condensed', sans-serif;")
    expect(css).toContain("--font-body: 'Roboto Condensed', sans-serif;")
    expect(css).toContain('--wb-font-size-base: 13px;')
  })

  it('aliases --font-game to the heading family', () => {
    const css = themeToCssVars(themes.arada)
    expect(css).toContain(`--font-game: ${themes.arada.typography.heading};`)
  })

  it('emits density', () => {
    const css = themeToCssVars(themes.dash5)
    expect(css).toContain('--row-h: 27px;')
    expect(css).toContain('--rail-w: 225px;')
    expect(css).toContain('--radius-sm: 2px;')
  })

  it('emits no colour tokens', () => {
    const css = themeToCssVars(themes.dash5)
    expect(css).not.toContain('--brand-primary')
    expect(css).not.toContain('--surface-base')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/shared-types test`
Expected: FAIL — `Failed to resolve import "./index"` / module not found.

- [ ] **Step 3: Write the type definitions**

Create `packages/shared-types/src/themes/types.ts`:

```ts
import type { BrandTokens } from '../brand'

export const THEME_IDS = ['arada', 'dash5'] as const
export type ThemeId = (typeof THEME_IDS)[number]

/** Layout shells a page can ask for. Phase 1 ships two; 'docs' and 'auth' follow later. */
export const SHELL_KEYS = ['rails', 'wide'] as const
export type ShellKey = (typeof SHELL_KEYS)[number]

export interface ThemeTypography {
  /** Chrome, labels, buttons — the condensed/display face. */
  ui: string
  /** Body copy. */
  body: string
  /** Headings; also aliased to --font-game. */
  heading: string
  /** Stylesheet to inject at boot, or null for system fonts only. */
  googleHref: string | null
  /** Root font size, e.g. '13px'. */
  baseSize: string
}

export interface ThemeDensity {
  /** Top utility bar height. */
  utilH: string
  /** Nav strip height. */
  navH: string
  /** Data table row height. */
  rowH: string
  /** Button height. */
  controlH: string
  /** Input height. */
  inputH: string
  /** Left rail width; '0px' means this theme's rails shell renders no left rail. */
  railW: string
  /** Right rail width; '0px' means no right rail. */
  asideW: string
  radiusSm: string
  radiusMd: string
  radiusLg: string
  borderW: string
}

export interface ThemeDefinition {
  id: ThemeId
  name: string
  /** Full palette this theme renders with when no brand override is set. */
  defaultTokens: BrandTokens
  typography: ThemeTypography
  density: ThemeDensity
}
```

- [ ] **Step 4: Write the arada theme**

Create `packages/shared-types/src/themes/arada.ts`. Density values are read off the live
`apps/web/layouts/default.vue` and `assets/css/components.css`, so the current look is preserved.
`defaultTokens` imports `DEFAULT_BRAND.tokens` rather than restating it, so the two cannot drift.

```ts
import { DEFAULT_BRAND } from '../brand'
import type { ThemeDefinition } from './types'

export const arada: ThemeDefinition = {
  id: 'arada',
  name: 'Arada',
  defaultTokens: DEFAULT_BRAND.tokens,
  typography: {
    ui: "'Barlow Condensed', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    heading: "'Oswald', system-ui, sans-serif",
    googleHref:
      'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap',
    baseSize: '16px',
  },
  density: {
    utilH: '64px',
    navH: '50px',
    rowH: '44px',
    controlH: '44px',
    inputH: '44px',
    railW: '0px',
    asideW: '0px',
    radiusSm: '6px',
    radiusMd: '12px',
    radiusLg: '16px',
    borderW: '1px',
  },
}
```

- [ ] **Step 5: Write the dash5 theme**

Create `packages/shared-types/src/themes/dash5.ts`. Values measured from dash5.bet at 1440×900 —
see §3 of `docs/superpowers/specs/2026-08-25-theme-system-design.md`.

```ts
import type { ThemeDefinition } from './types'

export const dash5: ThemeDefinition = {
  id: 'dash5',
  name: 'Dash',
  defaultTokens: {
    surfaceBase: '#101013',
    surfaceRaised: '#06262d',
    surfaceOverlay: '#0a3b3a',
    surfaceBorder: 'rgba(255, 255, 255, 0.12)',
    brandPrimary: '#00ff9d',
    brandPrimaryDim: '#00c77a',
    brandPrimaryGlow: 'rgba(0, 255, 157, 0.25)',
    accentPrimary: '#fad113',
    accentDim: '#ffb300',
    accentGlow: 'rgba(250, 209, 19, 0.25)',
    statusSuccess: '#00c77a',
    statusError: '#cd0013',
    statusWarning: '#ffb300',
    statusInfo: '#2ba0c4',
    textPrimary: '#ffffff',
    textSecondary: 'rgba(255, 255, 255, 0.6)',
    textDisabled: '#7b7f85',
    textOnBrand: '#001a1a',
    cartelaUnmarkedBg: '#0f5149',
    cartelaMarkedBg: '#00ff9d',
    cartelaMarkedText: '#001a1a',
    cartelaFreeBg: '#fad113',
    cartelaFreeText: '#101013',
    numberCalledGlow: 'rgba(0, 255, 157, 0.6)',
    winnerGlow: 'rgba(250, 209, 19, 0.8)',
    ballB: '#fad113',
    ballI: '#00ff9d',
    ballN: '#2ba0c4',
    ballG: '#8ec714',
    ballO: '#cd0013',
  },
  typography: {
    ui: "'Roboto Condensed', sans-serif",
    body: "'Roboto Condensed', sans-serif",
    heading: "'Roboto Condensed', sans-serif",
    googleHref:
      'https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;500;700&display=swap',
    baseSize: '13px',
  },
  density: {
    utilH: '43px',
    navH: '50px',
    rowH: '27px',
    controlH: '42px',
    inputH: '36px',
    railW: '225px',
    asideW: '329px',
    radiusSm: '2px',
    radiusMd: '3px',
    radiusLg: '4px',
    borderW: '1px',
  },
}
```

- [ ] **Step 6: Write the registry and the CSS emitter**

Create `packages/shared-types/src/themes/index.ts`:

```ts
import type { ThemeDefinition, ThemeId } from './types'
import { arada } from './arada'
import { dash5 } from './dash5'

export * from './types'
export { arada, dash5 }

export const themes: Record<ThemeId, ThemeDefinition> = { arada, dash5 }
export const DEFAULT_THEME_ID: ThemeId = 'arada'

/**
 * Single seam for choosing the active theme. Unknown ids fall back to the
 * default rather than throwing — a bad value in the DB must never break boot.
 */
export function resolveTheme(id: string | undefined): ThemeDefinition {
  if (id && id in themes) return themes[id as ThemeId]
  if (id) console.warn(`[theme] unknown theme "${id}", falling back to ${DEFAULT_THEME_ID}`)
  return themes[DEFAULT_THEME_ID]
}

/**
 * Render a theme's typography and density as the body of a CSS block.
 * Colours are NOT emitted here — they flow through brandTokensToCss so that a
 * brand override always wins. Injected at :root:root by the web plugin.
 */
export function themeToCssVars(theme: ThemeDefinition): string {
  const t = theme.typography
  const d = theme.density
  return [
    `--font-ui: ${t.ui};`,
    `--font-body: ${t.body};`,
    `--font-heading: ${t.heading};`,
    `--font-game: ${t.heading};`,
    `--wb-font-size-base: ${t.baseSize};`,
    `--util-h: ${d.utilH};`,
    `--nav-h: ${d.navH};`,
    `--row-h: ${d.rowH};`,
    `--control-h: ${d.controlH};`,
    `--input-h: ${d.inputH};`,
    `--rail-w: ${d.railW};`,
    `--aside-w: ${d.asideW};`,
    `--radius-sm: ${d.radiusSm};`,
    `--radius-md: ${d.radiusMd};`,
    `--radius-lg: ${d.radiusLg};`,
    `--border-w: ${d.borderW};`,
  ].join('\n')
}
```

- [ ] **Step 7: Export the module from the package root**

Modify `packages/shared-types/src/index.ts` — add one line after `export * from './brand'`:

```ts
export * from './themes'
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @world-bingo/shared-types test`
Expected: PASS — all 12 assertions across the four describe blocks.

- [ ] **Step 9: Delete the superseded packages/ui theme registry**

Nothing imports these but `packages/ui/src/index.ts`; they are an orphaned parallel brand registry
that the shared-types brand contract already replaced.

```bash
git rm packages/ui/src/theme/types.ts \
       packages/ui/src/theme/resolveBrand.ts \
       packages/ui/src/theme/resolveBrand.test.ts \
       packages/ui/src/theme/brandToCssVars.ts \
       packages/ui/src/theme/brandToCssVars.test.ts \
       packages/ui/src/theme/brands/arada.ts \
       packages/ui/src/theme/brands/index.ts
```

`packages/ui/src/theme/tokens.base.css` **stays** — it holds brand-agnostic structural tokens that
`apps/web/nuxt.config.ts` still loads.

- [ ] **Step 10: Drop the deleted exports**

Modify `packages/ui/src/index.ts` — delete these four lines:

```ts
export * from './theme/types'
export * from './theme/resolveBrand'
export * from './theme/brandToCssVars'
export * from './theme/brands'
```

- [ ] **Step 11: Verify both packages still build and test**

Run: `pnpm --filter @world-bingo/shared-types test && pnpm --filter @world-bingo/shared-types build && pnpm --filter @world-bingo/ui test`
Expected: shared-types tests PASS, build emits `dist/`, ui tests PASS (the two deleted ui test files are gone).

- [ ] **Step 12: Commit**

```bash
git add packages/shared-types/src packages/ui/src/index.ts
git commit -m "feat(theme): add theme contract and arada/dash5 registry

Replaces the orphaned packages/ui brand registry with a pure-data theme
module in shared-types, so the API can read a theme's default palette.
arada.defaultTokens aliases DEFAULT_BRAND.tokens so the two cannot drift."
```

---

### Task 2: `themeId` on the brand contract

**Files:**
- Modify: `packages/shared-types/src/brand.ts`
- Modify: `packages/shared-types/src/brand.test.ts`

**Interfaces:**
- Consumes: `THEME_IDS`, `DEFAULT_THEME_ID` from Task 1
- Produces: `BrandConfig.themeId: ThemeId`, `BrandConfigUpdate.themeId?: ThemeId`, `DEFAULT_BRAND.themeId === 'arada'`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared-types/src/brand.test.ts`:

```ts
describe('themeId on the brand contract', () => {
  it('defaults DEFAULT_BRAND to arada', () => {
    expect(DEFAULT_BRAND.themeId).toBe('arada')
  })

  it('accepts a known theme id', () => {
    expect(() => BrandConfigSchema.parse({ ...DEFAULT_BRAND, themeId: 'dash5' })).not.toThrow()
  })

  it('rejects an unknown theme id', () => {
    expect(() => BrandConfigSchema.parse({ ...DEFAULT_BRAND, themeId: 'nope' })).toThrow()
  })

  it('defaults themeId when the field is absent', () => {
    const { themeId, ...withoutTheme } = DEFAULT_BRAND
    expect(BrandConfigSchema.parse(withoutTheme).themeId).toBe('arada')
  })

  it('accepts a themeId-only update payload', () => {
    expect(() => BrandConfigUpdateSchema.parse({ themeId: 'dash5' })).not.toThrow()
  })

  it('rejects an unknown themeId in an update payload', () => {
    expect(() => BrandConfigUpdateSchema.parse({ themeId: 'nope' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/shared-types test -- brand.test.ts`
Expected: FAIL — `expected undefined to be 'arada'`.

- [ ] **Step 3: Add themeId to the schemas**

Modify `packages/shared-types/src/brand.ts`.

Add the import at the top of the file:

```ts
import { THEME_IDS, DEFAULT_THEME_ID } from './themes/types'
```

> Import from `./themes/types`, **not** `./themes` — `themes/index.ts` imports `arada.ts`, which
> imports `DEFAULT_BRAND` from this file. Going through `types.ts` keeps the cycle out.

In `BrandConfigSchema`, add the field before `tokens`:

```ts
    themeId: z.enum(THEME_IDS).default(DEFAULT_THEME_ID),
```

In `BrandConfigUpdateSchema`, add the same field **without** `.default()` (the whole object is
`.partial()`, and a default would silently reset the theme on every unrelated save):

```ts
    themeId: z.enum(THEME_IDS),
```

In `DEFAULT_BRAND`, add before `tokens`:

```ts
  themeId: DEFAULT_THEME_ID,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @world-bingo/shared-types test`
Expected: PASS — including the pre-existing `accepts DEFAULT_BRAND` test.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types/src/brand.ts packages/shared-types/src/brand.test.ts
git commit -m "feat(theme): carry themeId on the brand config contract

Rides the existing GET /brand payload so the web app needs no extra request."
```

---

### Task 3: Persist and resolve the active theme

Adds the DB column, switches the token merge base to the active theme, and clears colour overrides
on a theme change — without that last part, switching to `dash5` renders in amber.

**Files:**
- Modify: `apps/api/prisma/schema.prisma:519-529`
- Create: `apps/api/prisma/migrations/<timestamp>_add_brand_theme_id/migration.sql` (generated)
- Modify: `apps/api/src/services/brand.service.ts`
- Modify: `apps/api/src/services/brand.service.test.ts`

**Interfaces:**
- Consumes: `resolveTheme` (Task 1), `BrandConfig.themeId` (Task 2)
- Produces: `BrandService.getBrand()` and `updateBrand()` both return `BrandConfig` including `themeId`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/brand.service.test.ts`:

```ts
describe('BrandService theme resolution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('merges sparse overrides over the active theme palette', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'Dash',
      shortName: 'Dash',
      logoUrl: null,
      faviconUrl: null,
      themeId: 'dash5',
      tokens: { brandPrimary: '#123456' },
      updatedAt: new Date(),
    })
    const brand = await BrandService.getBrand()
    expect(brand.themeId).toBe('dash5')
    // explicit override wins
    expect(brand.tokens.brandPrimary).toBe('#123456')
    // untouched key comes from the dash5 palette, not DEFAULT_BRAND
    expect(brand.tokens.surfaceRaised).toBe('#06262d')
  })

  it('falls back to arada for an unknown stored themeId', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'X',
      shortName: 'X',
      logoUrl: null,
      faviconUrl: null,
      themeId: 'nope',
      tokens: {},
      updatedAt: new Date(),
    })
    const brand = await BrandService.getBrand()
    expect(brand.themeId).toBe('arada')
    expect(brand.tokens.brandPrimary).toBe(DEFAULT_BRAND.tokens.brandPrimary)
  })

  it('clears colour overrides when the theme changes', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'X',
      shortName: 'X',
      logoUrl: null,
      faviconUrl: null,
      themeId: 'arada',
      tokens: { brandPrimary: '#111111', surfaceBase: '#222222' },
      updatedAt: new Date(),
    })
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    await BrandService.updateBrand({ themeId: 'dash5' })
    const arg = (prisma.brandSetting.upsert as any).mock.calls[0][0]
    expect(arg.update.themeId).toBe('dash5')
    expect(arg.update.tokens).toEqual({})
  })

  it('keeps overrides when themeId is unchanged', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'X',
      shortName: 'X',
      logoUrl: null,
      faviconUrl: null,
      themeId: 'dash5',
      tokens: { brandPrimary: '#111111' },
      updatedAt: new Date(),
    })
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    await BrandService.updateBrand({ themeId: 'dash5', displayName: 'Y' })
    const arg = (prisma.brandSetting.upsert as any).mock.calls[0][0]
    expect(arg.update.tokens).toEqual({ brandPrimary: '#111111' })
  })

  it('keeps overrides when the caller sends tokens alongside a theme change', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'X',
      shortName: 'X',
      logoUrl: null,
      faviconUrl: null,
      themeId: 'arada',
      tokens: {},
      updatedAt: new Date(),
    })
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    await BrandService.updateBrand({ themeId: 'dash5', tokens: { brandPrimary: '#abcdef' } })
    const arg = (prisma.brandSetting.upsert as any).mock.calls[0][0]
    expect(arg.update.tokens).toEqual({ brandPrimary: '#abcdef' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- brand.service`
Expected: FAIL — `expected '#f59e0b' to be '#06262d'` on the first new test.

- [ ] **Step 3: Add the Prisma column**

Modify `apps/api/prisma/schema.prisma`, in `model BrandSetting`, after `faviconUrl`:

```prisma
  themeId     String   @default("arada")
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @world-bingo/api db:migrate -- --name add_brand_theme_id`
Expected: creates `apps/api/prisma/migrations/<timestamp>_add_brand_theme_id/migration.sql`
containing `ALTER TABLE "brand_settings" ADD COLUMN "themeId" TEXT NOT NULL DEFAULT 'arada';`

The default is what preserves existing deployments: every current row becomes an `arada` row, and
`arada.defaultTokens` is `DEFAULT_BRAND.tokens`, so the merged colour output is unchanged.

- [ ] **Step 5: Rewrite the service**

Modify `apps/api/src/services/brand.service.ts`. Replace the imports, `mergeBrand`, and
`updateBrand` body:

```ts
import prisma from '../lib/prisma'
import {
  BrandConfig,
  BrandConfigUpdate,
  BrandConfigUpdateSchema,
  DEFAULT_BRAND,
  resolveTheme,
} from '@world-bingo/shared-types'

const SINGLETON_ID = 'default'

/**
 * Merge a stored row over its theme's default palette. The stored `tokens` blob
 * holds only the keys an admin explicitly overrode; everything else comes from
 * the active theme.
 */
function mergeBrand(row: {
  displayName: string
  shortName: string
  logoUrl: string | null
  faviconUrl: string | null
  themeId: string | null
  tokens: unknown
} | null): BrandConfig {
  if (!row) return DEFAULT_BRAND
  const theme = resolveTheme(row.themeId ?? undefined)
  const rowTokens = (row.tokens ?? {}) as Partial<BrandConfig['tokens']>
  return {
    displayName: row.displayName ?? DEFAULT_BRAND.displayName,
    shortName: row.shortName ?? DEFAULT_BRAND.shortName,
    logoUrl: row.logoUrl ?? DEFAULT_BRAND.logoUrl,
    faviconUrl: row.faviconUrl ?? DEFAULT_BRAND.faviconUrl,
    themeId: theme.id,
    tokens: { ...theme.defaultTokens, ...rowTokens },
  }
}
```

In `updateBrand`, replace the token-merge block and the `data` object:

```ts
    const existing = await prisma.brandSetting.findUnique({ where: { id: SINGLETON_ID } })
    const existingTokens = ((existing?.tokens ?? {}) as Record<string, string>) || {}
    const existingThemeId = existing?.themeId ?? DEFAULT_BRAND.themeId
    const nextThemeId = patch.themeId ?? existingThemeId

    // Switching theme discards colour overrides — otherwise the previous theme's
    // palette would fully mask the new one and the switch would be invisible.
    // An explicit `tokens` payload in the same request wins over the reset.
    const themeChanged = nextThemeId !== existingThemeId
    const mergedTokens = patch.tokens
      ? { ...(themeChanged ? {} : existingTokens), ...patch.tokens }
      : themeChanged
        ? {}
        : existingTokens

    const data = {
      displayName: patch.displayName ?? existing?.displayName ?? DEFAULT_BRAND.displayName,
      shortName: patch.shortName ?? existing?.shortName ?? DEFAULT_BRAND.shortName,
      logoUrl: patch.logoUrl !== undefined ? patch.logoUrl : existing?.logoUrl ?? null,
      faviconUrl: patch.faviconUrl !== undefined ? patch.faviconUrl : existing?.faviconUrl ?? null,
      themeId: nextThemeId,
      tokens: mergedTokens,
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test -- brand`
Expected: PASS — the five new tests plus the four pre-existing `brand.service` tests and the three
`routes/brand` tests. The pre-existing `returns DEFAULT_BRAND when no row exists` still passes
because `DEFAULT_BRAND` now carries `themeId: 'arada'` on both sides of the comparison.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma apps/api/src/services/brand.service.ts apps/api/src/services/brand.service.test.ts
git commit -m "feat(theme): resolve brand tokens against the active theme

Stored tokens become sparse overrides layered on the theme's default palette.
Changing themeId clears them, so a switch to dash5 actually shows dash5 rather
than the previous theme's colours masking it."
```

---

### Task 4: Admin theme picker and sparse token writes

Fixes the write half of the masking defect: the branding page currently seeds from
`DEFAULT_BRAND.tokens` and POSTs all 30 keys on every save.

**Files:**
- Modify: `apps/admin/pages/settings/branding.vue`

**Interfaces:**
- Consumes: `themes`, `resolveTheme`, `THEME_IDS` (Task 1); `BrandConfig.themeId` (Task 2)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the theme imports and form field**

Modify `apps/admin/pages/settings/branding.vue`. Replace the import on line 2:

```ts
import {
  BRAND_TOKEN_CSS_VARS,
  DEFAULT_BRAND,
  themes,
  resolveTheme,
  type BrandConfig,
  type BrandTokenKey,
  type ThemeId,
} from '@world-bingo/shared-types'
```

Replace the `form` object (lines 10-16):

```ts
const form = reactive({
  displayName: DEFAULT_BRAND.displayName,
  shortName: DEFAULT_BRAND.shortName,
  logoUrl: DEFAULT_BRAND.logoUrl as string | null,
  faviconUrl: DEFAULT_BRAND.faviconUrl as string | null,
  themeId: DEFAULT_BRAND.themeId as ThemeId,
  tokens: { ...DEFAULT_BRAND.tokens },
})

/** Theme id as loaded from the server — used to detect an unsaved theme switch. */
const savedThemeId = ref<ThemeId>(DEFAULT_BRAND.themeId as ThemeId)

const themeOptions = Object.values(themes).map((t) => ({ label: t.name, value: t.id }))

/** The active theme's palette — the baseline every token is diffed against. */
const themeDefaults = computed(() => resolveTheme(form.themeId).defaultTokens)

/** Keys the admin has explicitly moved off the theme default. */
const overriddenKeys = computed(() =>
  tokenKeys.filter((k) => form.tokens[k] !== themeDefaults.value[k]),
)
```

- [ ] **Step 2: Reset colours when the theme changes in the form**

Add after the computed properties:

```ts
// Mirrors the server: switching theme discards colour overrides.
watch(
  () => form.themeId,
  (next) => {
    form.tokens = { ...resolveTheme(next).defaultTokens }
  },
)

function resetToken(k: BrandTokenKey) {
  form.tokens[k] = themeDefaults.value[k]
}

function resetAllTokens() {
  form.tokens = { ...themeDefaults.value }
}
```

- [ ] **Step 3: Seed the form from the theme, not from DEFAULT_BRAND**

In `load()`, replace lines 55-59:

```ts
    form.displayName = b.displayName
    form.shortName = b.shortName
    form.logoUrl = b.logoUrl
    form.faviconUrl = b.faviconUrl
    form.themeId = b.themeId
    savedThemeId.value = b.themeId
    // b.tokens is already the theme palette with overrides applied.
    form.tokens = { ...resolveTheme(b.themeId).defaultTokens, ...b.tokens }
```

> The `watch` on `form.themeId` fires here. That is harmless: it writes the theme defaults, and the
> line immediately after overwrites them with the server's merged values.

- [ ] **Step 4: Send only the overridden keys**

Replace the `updateBrand` call in `save()` (lines 94-100):

```ts
    const sparseTokens = Object.fromEntries(
      overriddenKeys.value.map((k) => [k, form.tokens[k]]),
    ) as Partial<BrandConfig['tokens']>

    await updateBrand({
      displayName: form.displayName,
      shortName: form.shortName,
      logoUrl: form.logoUrl,
      faviconUrl: form.faviconUrl,
      themeId: form.themeId,
      tokens: sparseTokens,
    })
    savedThemeId.value = form.themeId
```

While you are in this function, drop the emoji from the success toast (line 101) — emojis are banned
in copy, and it renders inconsistently across platforms:

```ts
    toast.add({
      title: 'Branding saved',
      description: 'Reload the player app to see changes.',
      color: 'success',
    })
```

- [ ] **Step 5: Add the theme picker and reset controls to the template**

Insert a new section immediately before the `<!-- ── Identity ── -->` block (line 125):

```vue
      <!-- ── Theme ── -->
      <div class="space-y-4">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:paint-brush" class="w-5 h-5 text-yellow-500" />
          Theme
        </h2>

        <div
          class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
          style="background: var(--surface-raised);"
        >
          <p class="text-sm font-bold text-white mb-1.5">Active theme</p>
          <p class="text-xs text-white/40 mb-2 font-medium">
            Controls typography, density and page layout in the player app, and supplies the default
            colours below.
          </p>
          <USelect v-model="form.themeId" :items="themeOptions" class="w-full sm:w-64" />

          <p
            v-if="form.themeId !== savedThemeId"
            class="text-xs mt-3 font-semibold"
            style="color: var(--status-warning);"
          >
            Switching theme resets your colour overrides. Saving will apply
            {{ themes[form.themeId].name }}'s palette.
          </p>
        </div>
      </div>
```

In the colour-tokens section, add a reset control per token. Inside the
`<div v-for="k in keys" …>` block, replace the label line (216) with:

```vue
                <div class="flex items-center justify-between gap-2">
                  <p class="text-xs font-semibold text-white/70">{{ k }}</p>
                  <button
                    v-if="form.tokens[k] !== themeDefaults[k]"
                    class="text-[10px] font-bold uppercase tracking-wide text-yellow-500 hover:text-yellow-400"
                    @click="resetToken(k)"
                  >
                    Reset
                  </button>
                </div>
```

Add a global reset next to the save button — replace the `<!-- ── Save ── -->` block (lines 303-313):

```vue
      <!-- ── Save ── -->
      <div class="flex justify-end items-center gap-3 pt-2">
        <span class="text-xs text-white/40 font-medium mr-auto">
          {{ overriddenKeys.length }} colour override{{ overriddenKeys.length === 1 ? '' : 's' }}
        </span>
        <UButton
          v-if="overriddenKeys.length > 0"
          color="neutral"
          variant="ghost"
          icon="i-heroicons:arrow-uturn-left"
          @click="resetAllTokens"
        >
          Reset colours to theme default
        </UButton>
        <UButton
          color="primary"
          :loading="saving"
          icon="i-heroicons:check"
          @click="save"
        >
          Save Branding
        </UButton>
      </div>
```

- [ ] **Step 6: Verify the page compiles**

Run: `pnpm --filter @world-bingo/admin typecheck 2>&1 | grep -i "branding"`
Expected: no output (no errors mentioning `branding.vue`).

> Per the Global Constraints, admin typecheck is red for unrelated reasons — grep for this file
> rather than trusting the exit code.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/pages/settings/branding.vue
git commit -m "feat(theme): add theme picker and sparse token writes to branding

The page previously POSTed all 30 token keys on every save, so a stored row
always masked the theme palette. It now diffs against the active theme and
sends only real overrides, with per-token and global reset controls."
```

---

### Task 5: Inject the theme in the web app

Stamps `data-theme` on `<html>`, loads the theme's font, emits its typography/density block, and
retires the stale stylesheet that was supplying the wrong fonts.

**Files:**
- Modify: `apps/web/composables/useBrand.ts`
- Modify: `apps/web/composables/useBrand.test.ts`
- Modify: `apps/web/plugins/00.brand.ts`
- Modify: `apps/web/nuxt.config.ts:48-53`
- Delete: `packages/ui/src/styles/tokens.css`

**Interfaces:**
- Consumes: `resolveTheme`, `themeToCssVars` (Task 1); `BrandConfig.themeId` (Task 2)
- Produces: `buildThemeStyle(theme: ThemeDefinition): string` from `apps/web/composables/useBrand.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/composables/useBrand.test.ts`:

```ts
import { themes, themeToCssVars } from '@world-bingo/shared-types'
import { buildThemeStyle } from './useBrand'

describe('buildThemeStyle', () => {
  it('wraps the theme CSS in a :root:root block', () => {
    const style = buildThemeStyle(themes.dash5)
    expect(style.startsWith(':root:root {')).toBe(true)
    expect(style).toContain(themeToCssVars(themes.dash5))
    expect(style.trim().endsWith('}')).toBe(true)
  })

  it('sets the root font size from the theme', () => {
    expect(buildThemeStyle(themes.dash5)).toContain('--wb-font-size-base: 13px;')
    expect(buildThemeStyle(themes.arada)).toContain('--wb-font-size-base: 16px;')
  })

  it('emits no colour tokens, so brand overrides always win', () => {
    expect(buildThemeStyle(themes.dash5)).not.toContain('--brand-primary')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/web test -- useBrand`
Expected: FAIL — `buildThemeStyle is not a function`.

- [ ] **Step 3: Add the helper**

Modify `apps/web/composables/useBrand.ts`. Extend the import and add the function after
`buildBrandStyle`:

```ts
import {
  type BrandConfig,
  type BrandTokens,
  type ThemeDefinition,
  DEFAULT_BRAND,
  brandTokensToCss,
  themeToCssVars,
} from '@world-bingo/shared-types'
```

```ts
/**
 * Build the `<style>` body for the active theme's typography and density.
 * `:root:root` (specificity 0,2,0) is required so these outrank the plain
 * `:root` defaults in tokens.base.css regardless of stylesheet order.
 * Emits no colours — brand tokens own those and land in their own block.
 */
export function buildThemeStyle(theme: ThemeDefinition): string {
  return `:root:root {\n${themeToCssVars(theme)}\n}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/web test -- useBrand`
Expected: PASS — the three new tests plus the pre-existing `buildBrandStyle` test.

- [ ] **Step 5: Wire the plugin**

Modify `apps/web/plugins/00.brand.ts`. Update the imports:

```ts
import { type BrandConfig, DEFAULT_BRAND, resolveTheme } from '@world-bingo/shared-types'
import { buildBrandStyle, buildThemeStyle, useBrand } from '~/composables/useBrand'
```

Replace the `useHead` call at the end of the plugin:

```ts
  const b = brand.value
  const theme = resolveTheme(b.themeId)

  useHead({
    title: b.displayName,
    titleTemplate: (t) => (t && t !== b.displayName ? `${t} · ${b.displayName}` : b.displayName),
    // Selects which [data-theme='…'] skin block applies. SSR-rendered, so there
    // is no flash — including on the ssr:false routes.
    htmlAttrs: { 'data-theme': theme.id },
    style: [
      // Theme first, brand second: brand colours must land after so an override wins.
      { id: 'theme-tokens', innerHTML: buildThemeStyle(theme) },
      { id: 'brand-tokens', innerHTML: buildBrandStyle(b.tokens) },
    ],
    link: [
      ...(theme.typography.googleHref
        ? [
            { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
            { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
            { rel: 'stylesheet', href: theme.typography.googleHref },
          ]
        : []),
      ...(b.faviconUrl ? [{ rel: 'icon', href: b.faviconUrl }] : []),
    ],
    meta: [{ name: 'application-name', content: b.displayName }],
  })
```

- [ ] **Step 6: Apply the base font size**

Modify `apps/web/assets/css/theme.css`. Add to the existing `body` rule:

```css
body {
  font-family: var(--font-body);
  font-size: var(--wb-font-size-base);
  background: var(--surface-base);
  color: var(--text-primary);
}
```

- [ ] **Step 7: Retire the stale stylesheet**

Modify `apps/web/nuxt.config.ts` — replace the `css` array:

```ts
    css: [
        '@world-bingo/ui/theme/tokens.base.css',
        '~/assets/css/theme.css',
        '~/assets/css/components.css',
        '~/assets/css/themes/arada.css',
        '~/assets/css/themes/dash5.css',
    ],
```

> The two theme files are created in Tasks 8 and 9. Create empty placeholders now so the build does
> not break: `mkdir -p apps/web/assets/css/themes && touch apps/web/assets/css/themes/arada.css apps/web/assets/css/themes/dash5.css`

Delete the stale file — it hardcoded a dead palette and `@import`ed Rajdhani/Nunito/Space Grotesk,
which is where web's wrong fonts came from. Its keyframes and extra vars have **zero** consumers
(verified by grep across `apps/web` and `packages/ui`).

```bash
git rm packages/ui/src/styles/tokens.css
```

- [ ] **Step 8: Verify the app boots and the fonts are right**

Run: `pnpm --filter @world-bingo/web build`
Expected: build succeeds.

Then start the preview and confirm the injected values:

```bash
pnpm --filter @world-bingo/web dev
```

In the browser at `http://localhost:3002`, check:
- `document.documentElement.dataset.theme` → `'arada'`
- `getComputedStyle(document.documentElement).getPropertyValue('--font-ui')` → `'Barlow Condensed', system-ui, sans-serif` (previously **empty** — this is Defect B fixed)
- `getComputedStyle(document.body).fontSize` → `16px`

- [ ] **Step 9: Commit**

```bash
git add apps/web/composables/useBrand.ts apps/web/composables/useBrand.test.ts \
        apps/web/plugins/00.brand.ts apps/web/nuxt.config.ts \
        apps/web/assets/css/theme.css apps/web/assets/css/themes packages/ui/src/styles
git commit -m "feat(theme): inject theme typography and density in the web app

Stamps data-theme on <html>, loads the theme's font and emits its
typography/density block ahead of the brand colour block.

Also fixes --font-ui, which was referenced 9x in the default layout and
defined nowhere in apps/web; the app's only font source was a stale
packages/ui stylesheet loading three unrelated families."
```

---

### Task 6: Extract the shell composable

Pulls the shared shell state out of `layouts/default.vue` so two shells can render the same data.
`showDeposit`/`showWithdrawal` become `useState` because the buttons live in a shell while the
modals live in the dispatcher.

**Files:**
- Create: `apps/web/composables/useAppShell.ts`
- Create: `apps/web/composables/useAppShell.test.ts`

**Interfaces:**
- Consumes: `useAuthStore` from `~/store/auth`, `useSocket`, `useFeatureFlags`, `useSupport`
- Produces:
  - `formatBalance(realBalance, bonusBalance): string`
  - `useAppShell()` returning `{ auth, locale, showDeposit, showWithdrawal, mobileNavOpen, search, predictionsEnabled, referralsEnabled, formattedBalance, playerId, toggleLocale, submitSearch, handleLogout, openChat }` — **side-effect free**, safe to call from any number of components
  - `useShellBootstrap(): void` — the mount effects, called **exactly once**, by the layout dispatcher only

- [ ] **Step 1: Write the failing test**

`formatBalance` is extracted as a pure function so the arithmetic is testable without a Nuxt runtime
— the same split the existing `buildBrandStyle` uses.

The rest of `useAppShell` (locale toggle, search submit, player-id fallback, logout) depends on Nuxt
auto-imports — `useState`, `useI18n`, `navigateTo`, `useRouter` — and mounting that in Vitest would
cost more than it proves. Those paths are exercised by the Playwright specs in Task 11 instead.

Create `apps/web/composables/useAppShell.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatBalance } from './useAppShell'

describe('formatBalance', () => {
  it('sums real and bonus balances', () => {
    expect(formatBalance(1000, 234.5)).toBe('1,234.50')
  })

  it('always shows two decimals', () => {
    expect(formatBalance(5, 0)).toBe('5.00')
  })

  it('treats null and undefined as zero', () => {
    expect(formatBalance(null, undefined)).toBe('0.00')
  })

  it('accepts decimal strings from Prisma', () => {
    expect(formatBalance('1000.25', '0.25')).toBe('1,000.50')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/web test -- useAppShell`
Expected: FAIL — cannot find module `./useAppShell`.

- [ ] **Step 3: Write the composable**

Create `apps/web/composables/useAppShell.ts`. The body is moved from
`apps/web/layouts/default.vue:1-52`; the only behavioural change is that the two modal flags become
`useState` so the dispatcher and the shell share them.

```ts
import { useAuthStore } from '~/store/auth'

type Money = number | string | null | undefined

/** Total wallet balance, formatted for display. Pure — no Nuxt runtime needed. */
export function formatBalance(realBalance: Money, bonusBalance: Money): string {
  const total = Number(realBalance ?? 0) + Number(bonusBalance ?? 0)
  return total.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Shared chrome state for the layout shells. Every theme's shell renders the
 * same data through this composable, so adding a theme never duplicates wiring.
 *
 * Deliberately side-effect free: the layout dispatcher AND the active shell both
 * call this, so registering onMounted here would fire every effect twice. Mount
 * effects live in useShellBootstrap, which the dispatcher calls exactly once.
 */
export function useAppShell() {
  const auth = useAuthStore()
  const router = useRouter()
  const { locale, setLocale } = useI18n()
  const { referralsEnabled, flags } = useFeatureFlags()
  const { openChat } = useSupport()

  // useState, not ref: the Deposit/Withdraw buttons live inside a shell while the
  // modals are rendered by the layout dispatcher, so the flags must be shared.
  const showDeposit = useState<boolean>('shell-deposit-open', () => false)
  const showWithdrawal = useState<boolean>('shell-withdrawal-open', () => false)

  const mobileNavOpen = ref(false)
  const search = ref('')

  const predictionsEnabled = computed(() => flags.value.feature_prediction_market === true)

  const formattedBalance = computed(() =>
    formatBalance(auth.wallet?.realBalance, auth.wallet?.bonusBalance),
  )

  const playerId = computed(() => auth.user?.serial ?? '—')

  const toggleLocale = () => setLocale(locale.value === 'en' ? 'am' : 'en')

  function submitSearch() {
    const q = search.value.trim()
    if (q) navigateTo(`/search?q=${encodeURIComponent(q)}`)
  }

  async function handleLogout() {
    await (auth as any).logout()
    await router.push('/auth/login')
  }

  return {
    auth,
    locale,
    showDeposit,
    showWithdrawal,
    mobileNavOpen,
    search,
    predictionsEnabled,
    referralsEnabled,
    formattedBalance,
    playerId,
    toggleLocale,
    submitSearch,
    handleLogout,
    openChat,
  }
}

/**
 * Mount-time side effects for the shell. Call this from the layout dispatcher
 * and nowhere else — useAppShell is called by both the dispatcher and the active
 * shell, so anything registered there would run twice and fire a duplicate
 * fetchWallet on every page load. (connect() self-guards on an open socket;
 * fetchWallet does not.)
 */
export function useShellBootstrap() {
  const auth = useAuthStore()
  const { connect } = useSocket()

  onMounted(async () => {
    if (auth.isAuthenticated) {
      await auth.fetchWallet()
      connect()
    }
  })

  watch(
    () => auth.isAuthenticated,
    (val) => {
      if (val) connect()
    },
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/web test -- useAppShell`
Expected: PASS — four assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/composables/useAppShell.ts apps/web/composables/useAppShell.test.ts
git commit -m "feat(theme): extract shared shell state into useAppShell

Lets two themes' shells render the same chrome data without duplicating the
auth, socket, wallet and i18n wiring."
```

---

### Task 7: Shell dispatch and the arada rails shell

Turns the 749-line `default.vue` into a ~30-line dispatcher and moves today's markup into
`AradaRailsShell.vue` unchanged, so `arada` renders exactly as it does now.

**Files:**
- Create: `apps/web/components/shells/arada/RailsShell.vue`
- Create: `apps/web/theme/shells.ts`
- Modify: `apps/web/layouts/default.vue` (full rewrite)
- Modify: `apps/web/test/no-hardcoded-theme.test.ts:6`

**Interfaces:**
- Consumes: `useAppShell` (Task 6); `SHELL_KEYS`, `ThemeId`, `ShellKey`, `resolveTheme` (Task 1)
- Produces, from `apps/web/theme/shells.ts`:
  - `shells: Partial<Record<ThemeId, Partial<Record<ShellKey, Component>>>>`
  - `FALLBACK_SHELL: ShellKey`
  - `pickShell(registry, themeId, requested): Component`

- [ ] **Step 1: Create the arada rails shell from the current layout**

Create `apps/web/components/shells/arada/RailsShell.vue`.

1. Copy `apps/web/layouts/default.vue` lines **53-287** (the `<template>` block) into the new file
   **verbatim**, except: delete the three modal/launcher lines (`<DepositModal …>`,
   `<WithdrawalModal …>`, `<SupportLauncher />`) near the end — those move to the dispatcher.
2. Copy lines **289-749** (the `<style scoped>` block) into the new file verbatim.
3. Give it this script block:

```vue
<script setup lang="ts">
const {
  auth,
  locale,
  showDeposit,
  showWithdrawal,
  mobileNavOpen,
  search,
  predictionsEnabled,
  referralsEnabled,
  formattedBalance,
  playerId,
  toggleLocale,
  submitSearch,
  handleLogout,
  openChat,
} = useAppShell()
</script>
```

4. Replace `<slot />` inside `<main class="ab-main">` — it stays exactly as it is. The shell receives
   page content through its own default slot.

> Do not retype the markup. Use `sed -n '53,287p'` and `sed -n '289,749p'` to extract the blocks.

- [ ] **Step 2: Write the failing resolution test**

Create `apps/web/theme/shells.test.ts`. `pickShell` is a pure function so the fallback chain is
testable without mounting Nuxt:

```ts
import { describe, it, expect } from 'vitest'
import { pickShell, FALLBACK_SHELL } from './shells'

const A_RAILS = { name: 'a-rails' }
const A_WIDE = { name: 'a-wide' }
const D_RAILS = { name: 'd-rails' }
const registry = {
  arada: { rails: A_RAILS, wide: A_WIDE },
  dash5: { rails: D_RAILS },
} as any

describe('pickShell', () => {
  it('returns the requested shell for the theme', () => {
    expect(pickShell(registry, 'arada', 'wide')).toBe(A_WIDE)
  })

  it('defaults to rails when no shell is requested', () => {
    expect(pickShell(registry, 'dash5', undefined)).toBe(D_RAILS)
    expect(FALLBACK_SHELL).toBe('rails')
  })

  it("falls back to the theme's own rails when it lacks the requested shell", () => {
    expect(pickShell(registry, 'dash5', 'wide')).toBe(D_RAILS)
  })

  it('falls back to arada when the theme is absent from the registry', () => {
    expect(pickShell(registry, 'nope' as any, 'wide')).toBe(A_WIDE)
  })

  it('never returns undefined', () => {
    expect(pickShell(registry, 'nope' as any, 'nope' as any)).toBe(A_RAILS)
  })
})
```

Run: `pnpm --filter @world-bingo/web test -- shells`
Expected: FAIL — cannot find module `./shells`.

- [ ] **Step 3: Create the shell registry**

Create `apps/web/theme/shells.ts`:

```ts
import type { Component } from 'vue'
import type { ShellKey, ThemeId } from '@world-bingo/shared-types'
import AradaRailsShell from '~/components/shells/arada/RailsShell.vue'

export type ShellRegistry = Partial<Record<ThemeId, Partial<Record<ShellKey, Component>>>>

/**
 * Statically imported on purpose. `/` is ssr:false, so an async shell would
 * flash unstyled content on first paint. The cost is every theme's shell in
 * the bundle, which is a few KB of markup.
 *
 * Phase 1: only `rails` exists for arada. `wide` lands in Task 10, dash5 in
 * Task 9. Missing keys fall back through pickShell.
 */
export const shells: ShellRegistry = {
  arada: { rails: AradaRailsShell },
}

export const FALLBACK_SHELL: ShellKey = 'rails'

/**
 * Resolve a shell component, degrading rather than rendering nothing:
 * requested → the theme's own rails → arada's rails.
 */
export function pickShell(
  registry: ShellRegistry,
  themeId: ThemeId,
  requested: ShellKey | undefined,
): Component {
  const themeShells = registry[themeId] ?? {}
  return (
    themeShells[requested ?? FALLBACK_SHELL] ??
    themeShells[FALLBACK_SHELL] ??
    registry.arada![FALLBACK_SHELL]!
  )
}
```

Run: `pnpm --filter @world-bingo/web test -- shells`
Expected: PASS — five assertions.

- [ ] **Step 4: Rewrite the layout as a dispatcher**

Replace the entire contents of `apps/web/layouts/default.vue`:

```vue
<script setup lang="ts">
import { resolveTheme } from '@world-bingo/shared-types'
import { shells, pickShell } from '~/theme/shells'

const route = useRoute()
const brand = useBrand()
const { auth, showDeposit, showWithdrawal } = useAppShell()

// Exactly one caller, by contract — see the comment on useShellBootstrap.
useShellBootstrap()

const shell = computed(() =>
  pickShell(shells, resolveTheme(brand.value.themeId).id, route.meta.shell),
)
</script>

<template>
  <component :is="shell">
    <slot />
  </component>

  <DepositModal v-model="showDeposit" @deposited="auth.fetchWallet(); showDeposit = false" />
  <WithdrawalModal
    v-model="showWithdrawal"
    :balance="Number(auth.wallet?.realBalance ?? 0)"
    @withdrawn="auth.fetchWallet(); showWithdrawal = false"
  />
  <SupportLauncher />
</template>
```

- [ ] **Step 5: Declare the route meta type**

Create `apps/web/theme/route-meta.d.ts` so `route.meta.shell` type-checks:

```ts
import type { ShellKey } from '@world-bingo/shared-types'

declare module 'vue-router' {
  interface RouteMeta {
    /** Which layout shell this page wants. Defaults to 'rails'. */
    shell?: ShellKey
  }
}

export {}
```

- [ ] **Step 6: Extend the hardcoded-theme guard to cover shells**

Modify `apps/web/test/no-hardcoded-theme.test.ts` line 6:

```ts
const ROOTS = [
  join(__dirname, '..', 'components', 'brand'),
  join(__dirname, '..', 'components', 'shells'),
]
```

- [ ] **Step 7: Run the guard and expect it to fail**

Run: `pnpm --filter @world-bingo/web test -- no-hardcoded-theme`
Expected: FAIL — `AradaRailsShell.vue` carries raw hex colours and `font-family:` declarations
inherited from the old layout's scoped CSS.

- [ ] **Step 8: Move the shell's scoped CSS into the theme stylesheet**

The guard flags any `#rrggbb` literal and any `font-family:` declaration in a shell `.vue`. The old
layout's scoped CSS has both. Rather than rewrite ~460 lines of CSS in place, move the whole block to
the theme stylesheet — it is not scanned, and Task 8 consolidates arada's look there anyway.

Extract the block, strip the `<style scoped>` wrapper, prefix every selector with
`[data-theme='arada'] `, and append the result to `apps/web/assets/css/themes/arada.css`:

```bash
SHELL=apps/web/components/shells/arada/RailsShell.vue
sed -n '/^<style scoped>$/,/^<\/style>$/p' "$SHELL" \
  | sed '1d;$d' \
  | perl -pe 's/^([.#\w][^{}\n]*?)(\s*\{)$/[data-theme=\x27arada\x27] $1$2/' \
  >> apps/web/assets/css/themes/arada.css
```

Then delete the `<style scoped>` block from the shell:

```bash
perl -0pi -e 's/\n<style scoped>.*?<\/style>\n//s' "$SHELL"
```

While reviewing, make two corrections to the moved CSS. Neither changes a colour, so arada's
byte-identical colour guarantee holds:

- `.ab-shell { min-height: 100vh }` → `min-height: 100dvh`. `100vh` overflows on iOS Safari when the
  URL bar collapses, which is the mobile layout jump this shell has today.
- Add a focus ring — the layout currently gives keyboard users no visible focus anywhere:

  ```css
  [data-theme='arada'] :focus-visible {
    outline: 2px solid var(--brand-primary);
    outline-offset: 2px;
  }
  ```

Review the appended CSS by hand afterwards. Two things the regex cannot do:
- `@media` and `@keyframes` blocks must **not** be prefixed. Move the `[data-theme='arada']` prefix
  onto the selectors *inside* each `@media` block, and leave `@keyframes` names untouched.
- Selectors that were already scoped by Vue's `scoped` attribute now apply globally. The `ab-`
  prefix on every class in this layout makes collisions unlikely, but confirm with a grep that no
  `ab-` class is defined anywhere else: `grep -rn "\.ab-" apps/web --include='*.vue' --include='*.css' | grep -v shells/arada`

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter @world-bingo/web test`
Expected: PASS — `no-hardcoded-theme`, `useBrand`, `useAppShell`, `useSupport`, `lobby-search`.

- [ ] **Step 10: Verify the app looks unchanged**

Run: `pnpm --filter @world-bingo/web dev` and open `http://localhost:3002`.
Expected: the lobby renders exactly as before — header, nav strip, footer, mobile drawer, deposit
and withdrawal modals all functional.

- [ ] **Step 11: Commit**

```bash
git add apps/web/components/shells apps/web/theme apps/web/layouts/default.vue \
        apps/web/assets/css/themes/arada.css apps/web/test/no-hardcoded-theme.test.ts
git commit -m "refactor(theme): split default layout into dispatcher and arada shell

749-line layout becomes a ~30-line dispatcher plus AradaRailsShell. Markup and
styles move verbatim, so arada renders identically. Extends the hardcoded-theme
guard to cover components/shells."
```

---

### Task 8: Split the shared component CSS

`components.css` currently bakes arada's look into the shared `wb-*` classes. Leaving it that way
would make arada the implicit base that every future theme has to fight on specificity.

**Files:**
- Modify: `apps/web/assets/css/components.css`
- Modify: `apps/web/assets/css/themes/arada.css`

**Interfaces:**
- Consumes: density tokens emitted by `themeToCssVars` (Task 1)
- Produces: `wb-*` classes whose structure is theme-neutral and whose look is theme-supplied

- [ ] **Step 1: Make the shared classes token-driven**

In `apps/web/assets/css/components.css`, replace hardcoded metrics with the density tokens so the
same class reshapes under a different theme. Concretely:

- `.wb-btn` — `padding: 12px 22px` → `min-height: var(--control-h); padding: 0 22px;`
  and `border-radius: var(--radius-md, 12px)` → `border-radius: var(--radius-md);`
- `.wb-input, .wb-select, .wb-textarea` — `padding: 12px 14px` → `min-height: var(--input-h); padding: 0 14px;`
  and `border-radius: var(--radius-md, 12px)` → `border-radius: var(--radius-md);`
- `.wb-table tbody td`, `.wb-table thead th` — `padding: 13px 16px` → `height: var(--row-h); padding: 0 16px;`
- `.wb-modal`, `.wb-table-wrap`, `.wb-notice`, `.wb-tab` — drop every `, 12px` / `, 16px` fallback
  from `var(--radius-*)`; the theme always supplies them now.

Leave structure (flex, grid, gap, overflow, transitions, animations) exactly as it is.

- [ ] **Step 2: Move arada's aesthetic choices into its theme file**

Append to `apps/web/assets/css/themes/arada.css`, wrapping each selector:

```css
/* Arada skin — the soft, rounded, amber look. Structure lives in components.css. */
[data-theme='arada'] .wb-btn {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.7px;
  text-transform: uppercase;
}

[data-theme='arada'] .wb-input,
[data-theme='arada'] .wb-select,
[data-theme='arada'] .wb-textarea {
  font-family: var(--font-body);
  font-size: 15px;
  background: rgba(255, 255, 255, 0.04);
}

[data-theme='arada'] .wb-modal {
  box-shadow: var(--shadow-modal);
}

[data-theme='arada'] .wb-table thead th {
  font-family: var(--font-ui);
  font-size: 11px;
  letter-spacing: 0.9px;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.02);
}

[data-theme='arada'] .wb-table tbody td {
  font-size: 13.5px;
}

[data-theme='arada'] .wb-tab {
  font-family: var(--font-ui);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
```

Delete those same declarations from `components.css`.

- [ ] **Step 3: Verify arada is visually unchanged**

Run: `pnpm --filter @world-bingo/web dev` and open `http://localhost:3002/wallet`.
Expected: buttons, inputs, the transactions table and modals look exactly as before. Compare against
`git stash` if unsure.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @world-bingo/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/assets/css
git commit -m "refactor(theme): make wb-* classes theme-neutral

components.css keeps structure and drives its metrics off density tokens;
arada's typography and fills move to its own theme file so a second theme
does not have to out-specify them."
```

---

### Task 9: The dash5 theme

**Files:**
- Create: `apps/web/components/shells/dash5/RailsShell.vue`
- Modify: `apps/web/assets/css/themes/dash5.css`
- Modify: `apps/web/theme/shells.ts`

**Interfaces:**
- Consumes: `useAppShell` (Task 6); `shells` registry (Task 7); density tokens (Task 1)
- Produces: `shells.dash5.rails`

- [ ] **Step 1: Build the dash5 rails shell**

Create `apps/web/components/shells/dash5/RailsShell.vue`. Structure mirrors dash5.bet: a utility bar,
a nav strip, then a three-column body. No `<style>` block — **all** styling lives in `dash5.css`,
which keeps the hardcoded-theme guard green.

```vue
<script setup lang="ts">
const {
  auth,
  locale,
  showDeposit,
  showWithdrawal,
  mobileNavOpen,
  search,
  predictionsEnabled,
  formattedBalance,
  playerId,
  toggleLocale,
  submitSearch,
  handleLogout,
} = useAppShell()
</script>

<template>
  <div class="d5-shell">
    <!-- ── Utility bar ── -->
    <header class="d5-util">
      <NuxtLink to="/" class="d5-logo" aria-label="Home">
        <BrandLogo :height="26" />
      </NuxtLink>

      <div class="d5-search">
        <input
          v-model="search"
          class="d5-search-input"
          type="search"
          :placeholder="$t('common.search')"
          @keyup.enter="submitSearch"
        />
        <button class="d5-search-btn" aria-label="Search" @click="submitSearch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <path stroke-linecap="round" d="m20 20-3.5-3.5" />
          </svg>
        </button>
      </div>

      <div class="d5-util-end">
        <template v-if="auth.isAuthenticated">
          <div class="d5-balance">
            <strong>{{ formattedBalance }} <span>ETB</span></strong>
            <small>ID: {{ playerId }}</small>
          </div>
          <button class="d5-btn d5-btn--primary" @click="showDeposit = true">Deposit</button>
          <button class="d5-btn d5-btn--ghost" @click="showWithdrawal = true">Withdraw</button>
          <button class="d5-btn d5-btn--ghost" @click="handleLogout">Logout</button>
        </template>
        <template v-else>
          <NuxtLink to="/auth/login" class="d5-btn d5-btn--ghost">Login</NuxtLink>
          <NuxtLink to="/auth/register" class="d5-btn d5-btn--primary">Register</NuxtLink>
        </template>
        <button class="d5-lang" @click="toggleLocale">{{ locale === 'en' ? 'EN' : 'አማ' }}</button>
      </div>
    </header>

    <!-- ── Nav strip ── -->
    <nav class="d5-nav">
      <button class="d5-burger" aria-label="Menu" @click="mobileNavOpen = !mobileNavOpen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <NuxtLink to="/" class="d5-nav-link" exact-active-class="d5-nav-active">Home</NuxtLink>
      <NuxtLink to="/games/mini" class="d5-nav-link" active-class="d5-nav-active">Aviator</NuxtLink>
      <NuxtLink to="/games" class="d5-nav-link" exact-active-class="d5-nav-active">Games</NuxtLink>
      <NuxtLink
        v-if="predictionsEnabled"
        to="/predictions"
        class="d5-nav-link"
        active-class="d5-nav-active"
      >
        Fights
      </NuxtLink>
      <NuxtLink to="/promotions" class="d5-nav-link" active-class="d5-nav-active">
        Promotions
      </NuxtLink>
      <NuxtLink to="/wallet" class="d5-nav-link" active-class="d5-nav-active">Deposit</NuxtLink>
      <NuxtLink to="/transactions" class="d5-nav-link" active-class="d5-nav-active">
        History
      </NuxtLink>
    </nav>

    <!-- ── Three-column body ── -->
    <div class="d5-body" :class="{ 'd5-body--nav-open': mobileNavOpen }">
      <aside class="d5-rail">
        <div class="d5-panel">
          <h3 class="d5-panel-head">Game Rooms</h3>
          <NuxtLink to="/games" class="d5-rail-row">All Games</NuxtLink>
          <NuxtLink to="/games/bingo" class="d5-rail-row">Bingo</NuxtLink>
          <NuxtLink to="/games/mini" class="d5-rail-row">Aviator</NuxtLink>
          <NuxtLink to="/games/live" class="d5-rail-row">Live</NuxtLink>
          <NuxtLink v-if="predictionsEnabled" to="/predictions" class="d5-rail-row">
            Fights
          </NuxtLink>
        </div>
        <div class="d5-panel">
          <h3 class="d5-panel-head">Account</h3>
          <NuxtLink to="/wallet" class="d5-rail-row">Wallet</NuxtLink>
          <NuxtLink to="/transactions" class="d5-rail-row">History</NuxtLink>
          <NuxtLink to="/profile" class="d5-rail-row">Profile</NuxtLink>
          <NuxtLink to="/refer" class="d5-rail-row">Refer &amp; Earn</NuxtLink>
        </div>
      </aside>

      <main class="d5-main">
        <slot />
      </main>

      <aside class="d5-aside">
        <div class="d5-panel">
          <h3 class="d5-panel-head">My Cartelas</h3>
          <p v-if="!auth.isAuthenticated" class="d5-aside-empty">Log in to see your cartelas.</p>
          <p v-else class="d5-aside-empty">No active cartelas. Join a game to start.</p>
        </div>
      </aside>
    </div>

    <footer class="d5-footer">
      <p>
        Responsible Gaming: 18+ only. Gambling can be addictive — play within your limits.
      </p>
      <span class="d5-18">18+</span>
    </footer>
  </div>
</template>
```

- [ ] **Step 2: Write the dash5 stylesheet**

Replace `apps/web/assets/css/themes/dash5.css`. Every selector is scoped to `[data-theme='dash5']`,
and metrics read from the density tokens the theme already emits.

```css
/* Dash skin. Structure in components.css; tokens from themeToCssVars.
   Literal colours here are intentional theme constants with no token equivalent. */

[data-theme='dash5'] .d5-shell {
  /* dvh, not vh — vh jumps when iOS Safari collapses its URL bar. */
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

/* Keyboard users get nothing from :hover. One ring for every interactive element. */
[data-theme='dash5'] :focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
}

/* ── Utility bar ── */
[data-theme='dash5'] .d5-util {
  display: flex;
  align-items: center;
  gap: 16px;
  height: var(--util-h);
  padding: 0 25px;
  background: var(--surface-raised);
}
[data-theme='dash5'] .d5-logo { display: inline-flex; align-items: center; }
[data-theme='dash5'] .d5-search {
  flex: 1;
  max-width: 320px;
  margin-left: auto;
  display: flex;
  align-items: center;
  background: #02191e;
  border-radius: var(--radius-sm);
}
[data-theme='dash5'] .d5-search-input {
  flex: 1;
  min-width: 0;
  height: var(--input-h);
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-body);
  outline: none;
}
[data-theme='dash5'] .d5-search-btn {
  flex: none;
  width: 32px;
  height: var(--input-h);
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
[data-theme='dash5'] .d5-search-btn svg { width: 16px; height: 16px; }

[data-theme='dash5'] .d5-util-end { display: flex; align-items: center; gap: 10px; }
[data-theme='dash5'] .d5-balance { display: flex; flex-direction: column; line-height: 1.15; }
[data-theme='dash5'] .d5-balance strong {
  font-family: var(--font-ui);
  font-size: 15px;
  color: var(--brand-primary);
  /* Digits stop jittering as the balance updates. */
  font-variant-numeric: tabular-nums;
}
[data-theme='dash5'] .d5-balance small {
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

[data-theme='dash5'] .d5-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--control-h);
  padding: 0 24px;
  border: 0;
  border-radius: var(--radius-md);
  font-family: var(--font-ui);
  font-size: 16px;
  font-weight: 700;
  text-transform: uppercase;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
[data-theme='dash5'] .d5-btn--primary {
  background: linear-gradient(var(--brand-primary-dim), #1b4334);
  color: var(--text-primary);
}
[data-theme='dash5'] .d5-btn--ghost {
  background: transparent;
  border: var(--border-w) solid var(--surface-border);
  color: var(--text-primary);
}
[data-theme='dash5'] .d5-btn:hover { filter: brightness(1.08); }
/* Tactile press. transform only — no layout properties. */
[data-theme='dash5'] .d5-btn:active { transform: scale(0.98); }
[data-theme='dash5'] .d5-btn { transition: transform 0.12s, filter 0.12s; }
[data-theme='dash5'] .d5-lang {
  height: var(--control-h);
  padding: 0 12px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-ui);
  text-transform: uppercase;
  cursor: pointer;
}

/* ── Nav strip ── */
[data-theme='dash5'] .d5-nav {
  display: flex;
  align-items: stretch;
  height: var(--nav-h);
  padding: 0 25px;
  background: linear-gradient(var(--surface-raised), #0f5149);
  overflow-x: auto;
}
[data-theme='dash5'] .d5-burger {
  display: none;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}
[data-theme='dash5'] .d5-burger svg { width: 20px; height: 20px; }
[data-theme='dash5'] .d5-nav-link {
  display: inline-flex;
  align-items: center;
  padding: 0 16px;
  font-family: var(--font-ui);
  font-size: 13px;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--text-primary);
  white-space: nowrap;
}
[data-theme='dash5'] .d5-nav-link:hover { background: rgba(255, 255, 255, 0.06); }
[data-theme='dash5'] .d5-nav-active {
  background: var(--surface-base);
  color: var(--brand-primary);
}

/* ── Three-column body ── */
[data-theme='dash5'] .d5-body {
  flex: 1;
  display: grid;
  grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--aside-w);
  gap: 10px;
  padding: 10px;
  background: var(--surface-base);
}
[data-theme='dash5'] .d5-main { min-width: 0; }

[data-theme='dash5'] .d5-panel {
  background: var(--surface-raised);
  border-radius: var(--radius-lg);
  overflow: hidden;
  margin-bottom: 10px;
}
[data-theme='dash5'] .d5-panel-head {
  margin: 0;
  height: 44px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  background: #0f5149;
  font-family: var(--font-ui);
  font-size: 16px;
  font-weight: 500;
  text-transform: uppercase;
  color: var(--text-primary);
}
[data-theme='dash5'] .d5-rail-row {
  display: flex;
  align-items: center;
  height: 38px;
  padding: 0 10px;
  font-size: 13px;
  text-decoration: none;
  color: var(--text-primary);
  border-bottom: var(--border-w) solid rgba(255, 255, 255, 0.06);
}
[data-theme='dash5'] .d5-rail-row:hover { background: rgba(255, 255, 255, 0.06); }
[data-theme='dash5'] .d5-aside-empty {
  margin: 0;
  padding: 24px 10px;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
}

/* ── Footer ── */
[data-theme='dash5'] .d5-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 25px;
  background: var(--surface-raised);
  font-size: 12px;
  color: var(--text-secondary);
}
[data-theme='dash5'] .d5-footer p { margin: 0; flex: 1; }
[data-theme='dash5'] .d5-18 {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-full, 9999px);
  border: var(--border-w) solid var(--surface-border);
  font-weight: 700;
}

/* ── Responsive: collapse the rails ── */
@media (max-width: 1279px) {
  [data-theme='dash5'] .d5-body { grid-template-columns: var(--rail-w) minmax(0, 1fr); }
  [data-theme='dash5'] .d5-aside { display: none; }
}
@media (max-width: 900px) {
  [data-theme='dash5'] .d5-body { grid-template-columns: minmax(0, 1fr); }
  [data-theme='dash5'] .d5-rail { display: none; }
  [data-theme='dash5'] .d5-body--nav-open .d5-rail { display: block; }
  [data-theme='dash5'] .d5-burger { display: inline-flex; align-items: center; padding: 0 12px; }
  [data-theme='dash5'] .d5-search { display: none; }
}
```

- [ ] **Step 3: Register the shell**

Modify `apps/web/theme/shells.ts`:

```ts
import Dash5RailsShell from '~/components/shells/dash5/RailsShell.vue'
```

```ts
export const shells: Partial<Record<ThemeId, Partial<Record<ShellKey, Component>>>> = {
  arada: { rails: AradaRailsShell },
  dash5: { rails: Dash5RailsShell },
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @world-bingo/web test`
Expected: PASS — in particular `no-hardcoded-theme`, since `Dash5RailsShell.vue` has no `<style>`
block and no hex colours.

- [ ] **Step 5: Verify dash5 renders**

Switch the theme in the admin branding page (or set it directly):

```bash
psql "$DATABASE_URL" -c "UPDATE brand_settings SET \"themeId\"='dash5', tokens='{}' WHERE id='default';"
```

Open `http://localhost:3002` and confirm:
- `document.documentElement.dataset.theme` → `'dash5'`
- `getComputedStyle(document.body).fontSize` → `13px`
- Deep-teal chrome, electric-green accents, three columns at ≥1280px wide

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/shells/dash5 apps/web/assets/css/themes/dash5.css apps/web/theme/shells.ts
git commit -m "feat(theme): add the dash5 rails shell and skin

Three-column chrome at the measured dash5.bet metrics: 43px util bar, 50px nav,
225/329px rails, 13px base, 2-3px radii. Rails collapse at 1280 and 900px."
```

---

### Task 10: The `wide` shell

Full-bleed, rail-free shell for the games grid — dash5's second layout.

**Files:**
- Create: `apps/web/components/shells/arada/WideShell.vue`
- Create: `apps/web/components/shells/dash5/WideShell.vue`
- Modify: `apps/web/assets/css/themes/dash5.css`
- Modify: `apps/web/theme/shells.ts`
- Modify: `apps/web/pages/games/index.vue`, `apps/web/pages/games/[category].vue`
- Note: Task 11 adds `apps/web/test/page-shells.test.ts`, which asserts these declarations exist

**Interfaces:**
- Consumes: `useAppShell` (Task 6); `shells` registry (Task 7)
- Produces: `shells.arada.wide`, `shells.dash5.wide`

- [ ] **Step 1: Create the arada wide shell**

Create `apps/web/components/shells/arada/WideShell.vue`. Arada has no rails, so its wide shell is its
rails shell — reuse rather than duplicate:

```vue
<script setup lang="ts">
import RailsShell from './RailsShell.vue'
</script>

<template>
  <RailsShell>
    <slot />
  </RailsShell>
</template>
```

- [ ] **Step 2: Create the dash5 wide shell**

Create `apps/web/components/shells/dash5/WideShell.vue`. Same chrome as the rails shell, no rails.
Extract the util bar and nav strip into a shared child so the markup is written once.

First create `apps/web/components/shells/dash5/Chrome.vue` by moving the `<header class="d5-util">`
and `<nav class="d5-nav">` blocks out of `dash5/RailsShell.vue` verbatim, with this script:

```vue
<script setup lang="ts">
const {
  auth,
  locale,
  showDeposit,
  showWithdrawal,
  mobileNavOpen,
  search,
  predictionsEnabled,
  formattedBalance,
  playerId,
  toggleLocale,
  submitSearch,
  handleLogout,
} = useAppShell()
</script>
```

Then have `dash5/RailsShell.vue` render `<Chrome />` in their place, and create
`dash5/WideShell.vue`:

```vue
<script setup lang="ts">
import Chrome from './Chrome.vue'
</script>

<template>
  <div class="d5-shell">
    <Chrome />
    <main class="d5-wide">
      <slot />
    </main>
    <footer class="d5-footer">
      <p>Responsible Gaming: 18+ only. Gambling can be addictive — play within your limits.</p>
      <span class="d5-18">18+</span>
    </footer>
  </div>
</template>
```

- [ ] **Step 3: Style the wide main**

Append to `apps/web/assets/css/themes/dash5.css`:

```css
[data-theme='dash5'] .d5-wide {
  flex: 1;
  min-width: 0;
  background: var(--surface-base);
}
```

- [ ] **Step 4: Register both shells**

Modify `apps/web/theme/shells.ts`:

```ts
import AradaWideShell from '~/components/shells/arada/WideShell.vue'
import Dash5WideShell from '~/components/shells/dash5/WideShell.vue'
```

```ts
export const shells: Partial<Record<ThemeId, Partial<Record<ShellKey, Component>>>> = {
  arada: { rails: AradaRailsShell, wide: AradaWideShell },
  dash5: { rails: Dash5RailsShell, wide: Dash5WideShell },
}
```

- [ ] **Step 5: Opt the games pages into the wide shell**

Add to the `<script setup>` block of both `apps/web/pages/games/index.vue` and
`apps/web/pages/games/[category].vue`:

```ts
definePageMeta({ shell: 'wide' })
```

- [ ] **Step 6: Run tests and verify**

Run: `pnpm --filter @world-bingo/web test && pnpm --filter @world-bingo/web build`
Expected: PASS, build succeeds.

Then with `themeId='dash5'`, open `http://localhost:3002/games`.
Expected: full-bleed grid, no rails. `http://localhost:3002/` still shows three columns.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/shells apps/web/theme/shells.ts \
        apps/web/assets/css/themes/dash5.css apps/web/pages/games
git commit -m "feat(theme): add the wide shell for the games grid

dash5 runs a rail-free full-bleed layout on its casino pages; arada's wide
shell delegates to its rails shell since arada has no rails."
```

---

### Task 11: End-to-end coverage

**Files:**
- Create: `apps/web/test/page-shells.test.ts`
- Create: `apps/web/e2e/theme.spec.ts`

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Guard the page-meta declarations**

`page.route` cannot stub the brand on an SSR route: `00.brand.ts` fetches `/brand` inside Nitro and
serializes the result into the payload, and the client-side `loaded` guard stops it refetching.
`/` is `ssr: false` (see `routeRules` in `nuxt.config.ts`) so stubbing works there, but `/games`
is not, so the wide shell cannot be asserted from a stubbed e2e run.

Cover it with a filesystem guard instead — the same technique
`apps/web/test/no-hardcoded-theme.test.ts` already uses. Create
`apps/web/test/page-shells.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGES = join(__dirname, '..', 'pages')

describe('page shell declarations', () => {
  it.each(['games/index.vue', 'games/[category].vue'])(
    '%s opts into the wide shell',
    (rel) => {
      const src = readFileSync(join(PAGES, rel), 'utf8')
      expect(src).toMatch(/definePageMeta\(\s*\{[^}]*shell:\s*'wide'/)
    },
  )
})
```

Run: `pnpm --filter @world-bingo/web test -- page-shells`
Expected: PASS (Task 10 added the declarations).

- [ ] **Step 2: Write the spec**

Create `apps/web/e2e/theme.spec.ts`. Every test targets `/`, which is `ssr: false`, so the brand
fetch happens in the browser and `page.route` can stub it — no seeded database required.

> **Known repo issue, not introduced here:** `playwright.config.ts` sets `baseURL` and
> `webServer.url` to `http://localhost:3000`, but `pnpm --filter @world-bingo/web dev` serves on
> **3002**. Every existing e2e spec has the same mismatch. Use relative `page.goto('/')` so this
> spec picks up whatever `baseURL` resolves to, and run with
> `BASE_URL=http://localhost:3002` until the config is corrected separately.

```ts
import { test, expect } from '@playwright/test'
import { DEFAULT_BRAND, themes } from '@world-bingo/shared-types'

async function stubBrand(page: import('@playwright/test').Page, themeId: 'arada' | 'dash5') {
  await page.route('**/brand', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...DEFAULT_BRAND,
        themeId,
        tokens: themes[themeId].defaultTokens,
      }),
    })
  })
}

test.describe('theme system', () => {
  test('arada renders its own chrome at 16px', async ({ page }) => {
    await stubBrand(page, 'arada')
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'arada')
    const size = await page.evaluate(() => getComputedStyle(document.body).fontSize)
    expect(size).toBe('16px')
    await expect(page.locator('.ab-shell')).toBeVisible()
  })

  test('dash5 renders three columns at 13px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await stubBrand(page, 'dash5')
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dash5')
    const size = await page.evaluate(() => getComputedStyle(document.body).fontSize)
    expect(size).toBe('13px')
    await expect(page.locator('.d5-rail')).toBeVisible()
    await expect(page.locator('.d5-aside')).toBeVisible()
  })

  test('dash5 collapses to one column on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await stubBrand(page, 'dash5')
    await page.goto('/')
    await expect(page.locator('.d5-rail')).toBeHidden()
    await expect(page.locator('.d5-aside')).toBeHidden()
  })

  test('brand colours override the theme palette', async ({ page }) => {
    await page.route('**/brand', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...DEFAULT_BRAND,
          themeId: 'dash5',
          tokens: { ...themes.dash5.defaultTokens, brandPrimary: '#ff00ff' },
        }),
      })
    })
    await page.goto('/')
    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim(),
    )
    expect(primary).toBe('#ff00ff')
  })
})
```

- [ ] **Step 3: Run the spec**

Run: `BASE_URL=http://localhost:3002 pnpm --filter @world-bingo/web test:e2e -- theme.spec.ts`
Expected: 4 passed.

- [ ] **Step 4: Run the full suite**

Run: `pnpm --filter @world-bingo/shared-types test && pnpm --filter @world-bingo/api test && pnpm --filter @world-bingo/web test`
Expected: all PASS. Read the per-file output for `apps/web` rather than trusting the exit code.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/theme.spec.ts
git commit -m "test(theme): e2e coverage for theme dispatch and brand override

Stubs GET /brand so the specs run without a seeded database."
```

---

## Definition of Done

- `pnpm build` succeeds across the monorepo
- `pnpm --filter @world-bingo/shared-types test`, `--filter @world-bingo/api test`,
  `--filter @world-bingo/web test` all pass
- `BASE_URL=http://localhost:3002 pnpm --filter @world-bingo/web test:e2e -- theme.spec.ts` passes
- An existing deployment upgraded with no admin action renders **identically** in colour to before —
  `themeId` defaults to `arada` and `arada.defaultTokens` is `DEFAULT_BRAND.tokens`
- `--font-ui` resolves to a real family in `apps/web` (Defect B closed)
- Switching to `dash5` in admin produces the teal/electric-green look at 13px with three columns
