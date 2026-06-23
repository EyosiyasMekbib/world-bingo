# Themeable Multi-Brand Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the player web app fully themeable so multiple branded "systems" run from one codebase, selected per-deployment by env var, starting with the Arada Bingo design.

**Architecture:** A two-layer token model — shared `base` tokens + per-brand value definitions implementing a `BrandTheme` contract. A single `resolveBrand()` seam picks the active brand; a Nuxt SSR plugin applies it as `:root` CSS variables, fonts, and document meta. Every component references semantic tokens only; a CI guardrail forbids raw hex/font literals. Layout/components are then rebuilt to the Arada design (desktop + mobile) wired to existing stores.

**Tech Stack:** Nuxt 3, Vue 3, Pinia, Vitest (jsdom), CSS custom properties, Google Fonts.

---

## Phase Overview

This plan is delivered in phases. **Phase 1 is fully detailed and executable below.** Phases 2–6 are scoped roadmap entries; each becomes its own detailed plan (via the writing-plans skill) when reached, because their component code depends on the Phase 1 primitives and the pixel-level handoff details.

| Phase | Title | Outcome |
|-------|-------|---------|
| 1 | Theming infrastructure | Token contract + brand resolution + SSR application + Arada brand + CI guardrail. App runs themed by env var. **(Detailed below.)** |
| 2 | Layout shell | Header, primary nav (desktop) + icon-nav (mobile), footer — rebuilt to Arada, tokenized, wired to auth/wallet stores. |
| 3 | Home/lobby | Hero carousel, winners tabs, filter pills, Providers dropdown, game-card grid — Arada design on existing `provider-games`/`promotions` stores. |
| 4 | Gameplay screens | Restyle cartela grid, bingo ball, countdown to new tokens. Logic untouched. |
| 5 | Tokenize + retire old theme | Convert all remaining components to tokens; remove legacy amber `tokens.css`; guardrail passes repo-wide. |
| 6 | Responsive + brand #2 proof | Mobile polish vs D3 reference; add a throwaway second brand to prove "new brand = one file"; PWA manifest per brand verified. |

---

## File Structure (Phase 1)

- Create: `packages/ui/src/theme/types.ts` — `BrandTheme` interface (the contract).
- Create: `packages/ui/src/theme/tokens.base.css` — shared structural tokens + keyframes (extracted from current `styles/tokens.css`).
- Create: `packages/ui/src/theme/brands/arada.ts` — Arada token values.
- Create: `packages/ui/src/theme/brands/index.ts` — brand registry.
- Create: `packages/ui/src/theme/resolveBrand.ts` — the C-ready seam.
- Create: `packages/ui/src/theme/brandToCssVars.ts` — pure `BrandTheme` → CSS-var map.
- Create: `packages/ui/src/theme/resolveBrand.test.ts`, `brandToCssVars.test.ts`.
- Create: `apps/web/plugins/00.brand.ts` — SSR plugin applying the active brand.
- Create: `apps/web/test/no-hardcoded-theme.test.ts` — CI guardrail.
- Modify: `packages/ui/src/index.ts` — export theme module.
- Modify: `apps/web/nuxt.config.ts` — add `NUXT_PUBLIC_BRAND`, swap css to base tokens.
- Modify: `packages/ui/package.json` — add `vitest` devDep + `test` script (none today).

---

## Phase 1: Theming Infrastructure

### Task 1: BrandTheme contract

**Files:**
- Create: `packages/ui/src/theme/types.ts`

- [ ] **Step 1: Write the type definition**

```ts
// packages/ui/src/theme/types.ts
export interface BrandColors {
  surfaceBase: string
  surfaceRaised: string
  surfaceBorder: string
  brandPrimary: string
  brandPrimaryDim: string
  accent: string
  textPrimary: string
  textSecondary: string
  textOnBrand: string
  statusSuccess: string
  statusError: string
  statusWarning: string
  statusInfo: string
  cartelaUnmarkedBg: string
  cartelaMarkedBg: string
  ballB: string
  ballI: string
  ballN: string
  ballG: string
  ballO: string
}

export interface BrandFonts {
  heading: string // e.g. 'Oswald'
  ui: string // e.g. 'Barlow Condensed'
  body: string // e.g. 'Inter'
  googleHref: string // Google Fonts stylesheet URL for the three families
}

export interface BrandManifest {
  themeColor: string
  backgroundColor: string
  shortName: string
}

export interface BrandTheme {
  id: string
  name: string
  colors: BrandColors
  fonts: BrandFonts
  logo: { full: string; mark: string }
  manifest: BrandManifest
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @world-bingo/ui typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/theme/types.ts
git commit -m "feat(theme): add BrandTheme contract"
```

---

### Task 2: Add Vitest to the ui package

The `@world-bingo/ui` package has no test runner today. Phase 1 logic lives there, so add Vitest.

**Files:**
- Modify: `packages/ui/package.json`
- Create: `packages/ui/vitest.config.ts`

- [ ] **Step 1: Add test script and devDependency**

In `packages/ui/package.json`, add to `scripts`:

```json
"test": "vitest run"
```

Add to `devDependencies`:

```json
"vitest": "^2.1.0"
```

Add a `./theme/*` subpath to `exports` so Nuxt can load `tokens.base.css` (Task 6). The `exports` block becomes:

```json
"exports": {
  ".": "./src/index.ts",
  "./styles/*": "./src/styles/*",
  "./theme/*": "./src/theme/*"
}
```

- [ ] **Step 2: Create vitest config**

```ts
// packages/ui/vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
})
```

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: vitest added to `packages/ui`.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/package.json packages/ui/vitest.config.ts pnpm-lock.yaml
git commit -m "chore(ui): add vitest to ui package"
```

---

### Task 3: brandToCssVars (pure mapping)

Maps a `BrandTheme` to the CSS custom properties the components consume. This is the single source of the name mapping (e.g. `colors.brandPrimary` → `--brand-primary`).

**Files:**
- Create: `packages/ui/src/theme/brandToCssVars.ts`
- Test: `packages/ui/src/theme/brandToCssVars.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/theme/brandToCssVars.test.ts
import { describe, expect, it } from 'vitest'
import { brandToCssVars } from './brandToCssVars'
import type { BrandTheme } from './types'

const theme: BrandTheme = {
  id: 'test',
  name: 'Test Brand',
  colors: {
    surfaceBase: '#000', surfaceRaised: '#111', surfaceBorder: '#222',
    brandPrimary: '#f5a623', brandPrimaryDim: '#c8851a', accent: '#1d4a8a',
    textPrimary: '#fff', textSecondary: '#aaa', textOnBrand: '#000',
    statusSuccess: '#0f0', statusError: '#f00', statusWarning: '#ff0', statusInfo: '#00f',
    cartelaUnmarkedBg: '#1a2', cartelaMarkedBg: '#2b3',
    ballB: '#1', ballI: '#2', ballN: '#3', ballG: '#4', ballO: '#5',
  },
  fonts: { heading: 'Oswald', ui: 'Barlow Condensed', body: 'Inter', googleHref: 'https://x' },
  logo: { full: '/logo.svg', mark: '/mark.svg' },
  manifest: { themeColor: '#000', backgroundColor: '#000', shortName: 'TB' },
}

describe('brandToCssVars', () => {
  it('maps brand color to --brand-primary', () => {
    expect(brandToCssVars(theme)['--brand-primary']).toBe('#f5a623')
  })
  it('maps fonts to --font-heading/--font-ui/--font-body with fallback', () => {
    const vars = brandToCssVars(theme)
    expect(vars['--font-heading']).toBe("'Oswald', sans-serif")
    expect(vars['--font-ui']).toBe("'Barlow Condensed', sans-serif")
    expect(vars['--font-body']).toBe("'Inter', sans-serif")
  })
  it('produces a flat record of string CSS values', () => {
    const vars = brandToCssVars(theme)
    expect(Object.values(vars).every((v) => typeof v === 'string')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/ui test`
Expected: FAIL — cannot find module `./brandToCssVars`.

- [ ] **Step 3: Implement**

```ts
// packages/ui/src/theme/brandToCssVars.ts
import type { BrandTheme } from './types'

export function brandToCssVars(theme: BrandTheme): Record<string, string> {
  const c = theme.colors
  return {
    '--surface-base': c.surfaceBase,
    '--surface-raised': c.surfaceRaised,
    '--surface-border': c.surfaceBorder,
    '--brand-primary': c.brandPrimary,
    '--brand-primary-dim': c.brandPrimaryDim,
    '--accent-primary': c.accent,
    '--text-primary': c.textPrimary,
    '--wb-text-primary': c.textPrimary,
    '--text-secondary': c.textSecondary,
    '--wb-text-secondary': c.textSecondary,
    '--text-on-brand': c.textOnBrand,
    '--wb-text-on-brand': c.textOnBrand,
    '--status-success': c.statusSuccess,
    '--status-error': c.statusError,
    '--status-warning': c.statusWarning,
    '--status-info': c.statusInfo,
    '--cartela-unmarked-bg': c.cartelaUnmarkedBg,
    '--cartela-marked-bg': c.cartelaMarkedBg,
    '--ball-b': c.ballB,
    '--ball-i': c.ballI,
    '--ball-n': c.ballN,
    '--ball-g': c.ballG,
    '--ball-o': c.ballO,
    '--font-heading': `'${theme.fonts.heading}', sans-serif`,
    '--font-ui': `'${theme.fonts.ui}', sans-serif`,
    '--font-body': `'${theme.fonts.body}', sans-serif`,
    '--font-game': `'${theme.fonts.heading}', sans-serif`,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/ui test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/theme/brandToCssVars.ts packages/ui/src/theme/brandToCssVars.test.ts
git commit -m "feat(theme): add brandToCssVars mapping"
```

---

### Task 4: Arada brand definition + registry

**Files:**
- Create: `packages/ui/src/theme/brands/arada.ts`
- Create: `packages/ui/src/theme/brands/index.ts`

- [ ] **Step 1: Define the Arada brand**

```ts
// packages/ui/src/theme/brands/arada.ts
import type { BrandTheme } from '../types'

export const arada: BrandTheme = {
  id: 'arada',
  name: 'Arada Bingo',
  colors: {
    surfaceBase: '#0a1628',
    surfaceRaised: '#0d1f3c',
    surfaceBorder: 'rgba(255,255,255,0.12)',
    brandPrimary: '#f5a623',
    brandPrimaryDim: '#c8851a',
    accent: '#1d4a8a',
    textPrimary: '#ffffff',
    textSecondary: 'rgba(255,255,255,0.7)',
    textOnBrand: '#0a1628',
    statusSuccess: '#1a7a4a',
    statusError: '#ef4444',
    statusWarning: '#f5a623',
    statusInfo: '#1d4a8a',
    cartelaUnmarkedBg: '#0d1f3c',
    cartelaMarkedBg: '#f5a623',
    ballB: '#f5a623',
    ballI: '#1d4a8a',
    ballN: '#7a2a8a',
    ballG: '#1a7a4a',
    ballO: '#a8521a',
  },
  fonts: {
    heading: 'Oswald',
    ui: 'Barlow Condensed',
    body: 'Inter',
    googleHref:
      'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap',
  },
  logo: { full: '/brands/arada/logo.svg', mark: '/brands/arada/mark.svg' },
  manifest: { themeColor: '#f5a623', backgroundColor: '#0a1628', shortName: 'Arada' },
}
```

- [ ] **Step 2: Create the registry**

```ts
// packages/ui/src/theme/brands/index.ts
import type { BrandTheme } from '../types'
import { arada } from './arada'

export const brands: Record<string, BrandTheme> = { arada }
export const DEFAULT_BRAND_ID = 'arada'
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @world-bingo/ui typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/theme/brands/
git commit -m "feat(theme): add Arada brand definition and registry"
```

---

### Task 5: resolveBrand (the C-ready seam)

**Files:**
- Create: `packages/ui/src/theme/resolveBrand.ts`
- Test: `packages/ui/src/theme/resolveBrand.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/theme/resolveBrand.test.ts
import { describe, expect, it } from 'vitest'
import { resolveBrand } from './resolveBrand'

describe('resolveBrand', () => {
  it('returns the requested brand', () => {
    expect(resolveBrand('arada').id).toBe('arada')
  })
  it('falls back to the default brand for an unknown id', () => {
    expect(resolveBrand('does-not-exist').id).toBe('arada')
  })
  it('falls back to the default brand for undefined', () => {
    expect(resolveBrand(undefined).id).toBe('arada')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/ui test`
Expected: FAIL — cannot find module `./resolveBrand`.

- [ ] **Step 3: Implement**

```ts
// packages/ui/src/theme/resolveBrand.ts
import type { BrandTheme } from './types'
import { brands, DEFAULT_BRAND_ID } from './brands'

/**
 * Single seam for choosing the active brand. Today it reads from the in-repo
 * registry by id. To become admin/DB-editable later, replace the body with an
 * async fetch — callers and components do not change.
 */
export function resolveBrand(id: string | undefined): BrandTheme {
  if (id && brands[id]) return brands[id]
  if (id) console.warn(`[theme] unknown brand "${id}", falling back to ${DEFAULT_BRAND_ID}`)
  return brands[DEFAULT_BRAND_ID]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/ui test`
Expected: PASS.

- [ ] **Step 5: Export theme module**

In `packages/ui/src/index.ts`, append:

```ts
export * from './theme/types'
export * from './theme/resolveBrand'
export * from './theme/brandToCssVars'
export * from './theme/brands'
```

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/theme/resolveBrand.ts packages/ui/src/theme/resolveBrand.test.ts packages/ui/src/index.ts
git commit -m "feat(theme): add resolveBrand seam and export theme module"
```

---

### Task 6: Split base tokens out of the legacy stylesheet

Extract the brand-agnostic structural tokens (spacing, radius, shadow, motion, breakpoints, z-index) and keyframes into `tokens.base.css`. The brand-specific color/font values are now supplied at runtime by the plugin (Task 7), so they are removed from the base file. The legacy `styles/tokens.css` stays in place until Phase 5 to avoid breaking currently-styled components mid-migration.

**Files:**
- Create: `packages/ui/src/theme/tokens.base.css`

- [ ] **Step 1: Create the base tokens file**

```css
/* packages/ui/src/theme/tokens.base.css
   Brand-agnostic structural tokens. Color/font tokens are injected at runtime
   by the brand plugin (apps/web/plugins/00.brand.ts). */
:root {
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;
  --space-12: 48px; --space-16: 64px;

  --radius-sm: 6px; --radius-md: 12px; --radius-lg: 16px;
  --radius-xl: 24px; --radius-full: 9999px;

  --shadow-card: 0 4px 24px rgba(0, 0, 0, 0.4);
  --shadow-modal: 0 20px 60px rgba(0, 0, 0, 0.6);

  --duration-instant: 100ms; --duration-fast: 200ms; --duration-normal: 350ms;
  --duration-slow: 500ms; --duration-xslow: 800ms;

  --wb-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --wb-ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);

  --bp-sm: 480px; --bp-md: 768px; --bp-lg: 1024px; --bp-xl: 1280px;

  --z-base: 0; --z-dropdown: 10; --z-modal: 100; --z-toast: 200;

  --wb-text-game: 3rem; --wb-text-bingo: 4rem;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 2: Register it in Nuxt (keep legacy file for now)**

In `apps/web/nuxt.config.ts`, change the `css` array to load base tokens first:

```ts
css: [
  '@world-bingo/ui/theme/tokens.base.css',
  '@world-bingo/ui/styles/tokens.css',
  '~/assets/css/theme.css',
],
```

- [ ] **Step 3: Verify dev server boots**

Run: `pnpm --filter @world-bingo/web dev` (then Ctrl-C)
Expected: starts with no CSS resolution errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/theme/tokens.base.css apps/web/nuxt.config.ts
git commit -m "feat(theme): extract brand-agnostic base tokens"
```

---

### Task 7: Apply the active brand at SSR

Adds `NUXT_PUBLIC_BRAND` and a numbered plugin (`00.` runs early) that resolves the brand and injects CSS variables, the font stylesheet, title, theme-color meta, and PWA manifest fields — all during SSR so there is no flash of unthemed content.

**Files:**
- Modify: `apps/web/nuxt.config.ts`
- Create: `apps/web/plugins/00.brand.ts`

- [ ] **Step 1: Add the brand env to runtimeConfig.public**

In `apps/web/nuxt.config.ts`, inside `runtimeConfig.public`, add:

```ts
brand: 'arada', // overridden per-deployment by NUXT_PUBLIC_BRAND
```

- [ ] **Step 2: Make the PWA manifest brand-driven**

In `apps/web/nuxt.config.ts`, the static `pwa.manifest` no longer hardcodes colors. Replace the `manifest` block with:

```ts
manifest: {
  name: 'Arada Bingo',
  short_name: 'Arada',
  theme_color: '#f5a623',
  background_color: '#0a1628',
},
```

(Per-visitor manifest overrides are out of scope for separate-deployment-per-brand; the env-selected brand and this manifest match because each deployment builds for one brand.)

- [ ] **Step 3: Create the brand plugin**

```ts
// apps/web/plugins/00.brand.ts
import { resolveBrand, brandToCssVars } from '@world-bingo/ui'

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const theme = resolveBrand(config.public.brand as string | undefined)

  const cssText = Object.entries(brandToCssVars(theme))
    .map(([k, v]) => `${k}:${v}`)
    .join(';')

  useHead({
    title: theme.name,
    link: [{ rel: 'stylesheet', href: theme.fonts.googleHref }],
    meta: [{ name: 'theme-color', content: theme.manifest.themeColor }],
    style: [{ children: `:root{${cssText}}` }],
    htmlAttrs: { 'data-brand': theme.id },
  })
})
```

- [ ] **Step 4: Verify themed output in SSR HTML**

Run: `pnpm --filter @world-bingo/web dev` then in another shell:
`curl -s http://localhost:3002/ | grep -o 'data-brand="[a-z]*"'`
Expected: `data-brand="arada"`. Also confirm `--brand-primary:#f5a623` appears in the response. Ctrl-C the dev server.

- [ ] **Step 5: Verify brand override works**

Run: `NUXT_PUBLIC_BRAND=arada pnpm --filter @world-bingo/web dev` then `curl -s http://localhost:3002/ | grep -o 'Oswald'`
Expected: at least one match (font href injected). Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add apps/web/nuxt.config.ts apps/web/plugins/00.brand.ts
git commit -m "feat(theme): apply active brand at SSR via plugin"
```

---

### Task 8: CI guardrail against hardcoded theme values

A test that scans component source for raw hex colors and hardcoded `font-family` declarations and fails if any are found outside the theme directory. This is what keeps the codebase themeable as Phases 2–6 add components.

**Files:**
- Create: `apps/web/test/no-hardcoded-theme.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/no-hardcoded-theme.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = [join(__dirname, '..', 'components'), join(__dirname, '..', 'layouts')]
const HEX = /#[0-9a-fA-F]{3,8}\b/
const FONT_FAMILY = /font-family\s*:/i

function vueFiles(dir: string): string[] {
  let out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out = out.concat(vueFiles(p))
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

describe('no hardcoded theme values in components', () => {
  const files = ROOTS.flatMap((r) => {
    try {
      return vueFiles(r)
    } catch {
      return []
    }
  })

  it('has no raw hex colors', () => {
    const offenders = files.filter((f) => HEX.test(readFileSync(f, 'utf8')))
    expect(offenders, `Use CSS tokens, not hex: ${offenders.join(', ')}`).toEqual([])
  })

  it('has no hardcoded font-family', () => {
    const offenders = files.filter((f) => FONT_FAMILY.test(readFileSync(f, 'utf8')))
    expect(offenders, `Use --font-* tokens: ${offenders.join(', ')}`).toEqual([])
  })
})
```

- [ ] **Step 2: Run it — expect FAIL listing current offenders**

Run: `pnpm --filter @world-bingo/web test no-hardcoded-theme`
Expected: FAIL — existing components (e.g. `DepositModal.vue`) contain hex/font literals. This documents the migration debt resolved in Phase 5.

- [ ] **Step 3: Scope the guardrail to pass now, widen in Phase 5**

So the guardrail is green for new work without blocking on the legacy migration, restrict `ROOTS` to the new theme-clean directory created in later phases. Replace the `ROOTS` line with:

```ts
const ROOTS = [join(__dirname, '..', 'components', 'brand')]
```

Create a placeholder so the directory exists: `apps/web/components/brand/.gitkeep`.

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter @world-bingo/web test no-hardcoded-theme`
Expected: PASS (empty directory, no offenders). Phase 5 widens `ROOTS` back to all components once they are migrated.

- [ ] **Step 5: Commit**

```bash
git add apps/web/test/no-hardcoded-theme.test.ts apps/web/components/brand/.gitkeep
git commit -m "test(theme): add guardrail against hardcoded theme values"
```

---

## Phase 1 Self-Review

- Token contract (Task 1) ↔ spec "BrandTheme contract": covered.
- base/brand split (Tasks 3, 6) ↔ spec "Token model": covered.
- `resolveBrand` seam (Task 5) ↔ spec "C-ready seam": covered.
- SSR application + no-flash + manifest (Task 7) ↔ spec "Boot flow": covered.
- Guardrail (Task 8) ↔ spec "Guardrail": covered; legacy migration deferred to Phase 5 (consistent with spec "Affected areas").
- Type names consistent across tasks: `BrandTheme`, `brandToCssVars`, `resolveBrand`, `brands`, `DEFAULT_BRAND_ID` used identically everywhere.

---

## Phases 2–6 (Roadmap — detailed plans written when reached)

Each phase below will get its own `docs/superpowers/plans/` document with bite-sized tasks at execution time. They are intentionally not expanded now because their component code depends on Phase 1 primitives and the pixel-level desktop/mobile handoff.

### Phase 2 — Layout shell
- Build into `apps/web/components/brand/`: `BrandHeader.vue`, `BrandNavDesktop.vue`, `BrandNavMobile.vue` (horizontal icon-nav), `BrandFooter.vue`.
- Wire balance/ID to `store/auth` + wallet; Deposit button to existing `DepositModal.vue`.
- Nav items data-driven (no sports). Update `layouts/default.vue` to use the new shell.
- Acceptance: header/nav/footer match Arada (desktop) and D3 structure (mobile), guardrail green, responsive at `--bp-md`.

### Phase 3 — Home/lobby
- `BrandHero.vue` (carousel from `store/promotions`), `BrandWinnersTabs.vue`, `BrandFilterPills.vue`, `BrandProvidersDropdown.vue`, `BrandGameGrid.vue`.
- Wire to existing `store/provider-games` (providers, categories, search) and the `games.vue` page.
- Acceptance: lobby renders existing data in Arada design; 2-col grid on mobile; guardrail green.

### Phase 4 — Gameplay screens
- Restyle `packages/ui` `CartelaGrid.vue`, `BingoBall.vue`, `CountdownTimer.vue` and `apps/web/pages/play/**` to new tokens. Logic untouched; existing game-logic tests stay green.
- Acceptance: gameplay visually on-brand; `pnpm test` passes.

### Phase 5 — Tokenize + retire legacy theme
- Convert all remaining components to tokens; delete brand colors from `styles/tokens.css` (or remove the file), keeping only what `tokens.base.css` doesn't cover.
- Widen the Task 8 guardrail `ROOTS` back to `components/` + `layouts/`; make it pass repo-wide.
- Acceptance: no raw hex/font literals anywhere in web components; full `pnpm test` + `pnpm typecheck` green.

### Phase 6 — Responsive polish + brand #2 proof
- Mobile QA vs D3 reference across breakpoints.
- Add a throwaway `brands/<demo>.ts` + assets, boot with `NUXT_PUBLIC_BRAND=<demo>`, confirm full re-skin with zero component edits, then remove it.
- Acceptance: "new brand = one file" proven; PWA manifest reflects the brand.
```
