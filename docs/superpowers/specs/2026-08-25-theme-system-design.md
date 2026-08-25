# Theme system — design

**Date:** 2026-08-25
**Status:** approved, ready for implementation planning
**Scope:** `apps/web` (player app) + the `packages/shared-types` contract + `apps/api` brand service + `apps/admin` branding page

---

## 1. Problem

`world-bingo` already has a **brand** system: an admin-editable, DB-backed set of 30 colour tokens plus
logo/display name, served by `GET /brand` and injected as CSS custom properties at boot
(`packages/shared-types/src/brand.ts`, `apps/api/src/services/brand.service.ts`,
`apps/web/plugins/00.brand.ts`, `apps/admin/pages/settings/branding.vue`).

What it cannot express is a **design language** — typography, density, radii, border weight, and the
shape of the page shell. A deployment can recolour the app, but every deployment looks structurally
identical.

We want a second, orthogonal axis: a **theme**, selected by an admin, that owns the design language and
supplies a default palette which brand settings then override. The first non-default theme reproduces
the visual language of `dash5.bet`.

### 1.1 Two defects this work has to fix first

**Defect A — brand rows mask any theme palette.**
`apps/admin/pages/settings/branding.vue:15` seeds its form from the complete `DEFAULT_BRAND.tokens`
and line 99 POSTs `tokens: form.tokens` — all 30 keys, every save. `mergeBrand` then spreads that row
over the defaults, so for any deployment that has ever opened the branding page, the stored row is a
*complete* palette. Changing the merge base from `DEFAULT_BRAND.tokens` to a theme's `defaultTokens`
would therefore have **no visible effect**. The write path must be fixed, not just the read path.

**Defect B — web typography is broken today.**
`--font-ui` is referenced 9× in `apps/web/layouts/default.vue` (lines 329, 366, 395, 411, 432, 534,
600, 700, 734) and is **never defined anywhere in `apps/web`**. Oswald / Barlow Condensed / Inter are
never loaded by the web app at all — only by `apps/admin`. The sole font source reaching web is the
stale `packages/ui/src/styles/tokens.css`, which `@import`s Rajdhani / Nunito / Space Grotesk and
hardcodes a dead palette at `:root`. Every `var(--font-ui)` rule silently falls through to Space
Grotesk. A theme that owns typography fixes this as a side effect.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Switchable **theme registry**, separate from brand | Future themes are cheap; the brand system stays intact |
| D2 | Theme owns tokens **+ component skins + layout shell** | dash5's identity is mostly structure and density, not colour alone |
| D3 | `apps/web` only | Admin is `@nuxt/ui`-based; a parallel implementation for a staff-only back-office is not worth it |
| D4 | Active theme stored in the **DB**, on the existing `BrandSetting` row | `/brand` is already fetched at boot — theme arrives with zero new network calls |
| D5 | **Two themes** ship: `arada` (default, current look) + `dash5` | Proves the registry with >1 entry and gives a rollback |
| D6 | Theme supplies **default** colours; explicit brand tokens override | dash5 looks like dash5 out of the box; deployments can still retint |
| D7 | **Phase 1 ships two shell keys**: `rails` + `wide`. `docs` / `auth` follow later | Covers lobby + games, the pages users actually occupy |

---

## 3. Reference analysis — dash5.bet

Measured live at 1440×900 on 2026-08-25.

### 3.1 Shells

`dash5.bet` runs **four** distinct shells beneath one constant chrome (43px top bar `#06262d` → 50px
nav strip → content), plus one rail-count variant.

| Section | Route | Shell |
|---|---|---|
| Home, Sport | `/en/home`, `/en/sport` | **rails** — left 225 / center 846 / betslip 329 |
| Games, Virtual Sport, Live Games | `/en/virtualgames`, `/en/virtualsport` | **wide** — full-bleed, no rails |
| Check Ticket | `/en/betinfo` | `rails` minus the left rail — a variant, not a sixth shell |
| Promotions | `/en/promotions` | **docs** — index rail + content pane |
| Deposit → Login | `/en/auth/signin` | **auth** — ~400px centered column |

Live is geo/auth-gated and did not load. Rules redirects to home.

Layout is **full-bleed** — no max-width container. Gutters are 10px.

### 3.2 Measured primitives

| Primitive | Value |
|---|---|
| nav strip / nav item | h 50, padding `0 25px` / w 70 |
| left rail / betslip rail | 225 / 329 |
| rail section header | h 44, bg `#0f5149`, radius `4px 4px 0 0`, 16px uppercase |
| rail row | h 38 |
| tab | h 49, bg `rgba(6,38,45,.5)`, 1px bottom rule `rgba(255,255,255,.2)`, 13px uppercase, inactive `rgba(255,255,255,.5)` |
| table row | **h 27**, bg `#06262d`, 1px bottom `rgba(255,255,255,.12)`, padding `0 12px` |
| odds cell | 45 × 24 |
| input | h 36, radius **2px**, bg `#02191e` |
| button | h 42, padding `12px 24px`, radius **3px**, 16px / 700, uppercase |
| primary gradient | `linear-gradient(#00c77a, #1b4334)` |
| base font size | **13px** |

Type is Roboto Condensed, with bold delivered as a **separate face**
(`robotocondensed-bold-webfont`), not a weight of the regular family.

### 3.3 Palette → `BrandTokens`

`dash5.bet` carries hundreds of ad-hoc legacy custom properties (PrimeVue + Bootstrap + several
generations of per-product prefixes). It is not a design system to copy literally. The values below
are the identity distilled into our existing 29-key vocabulary.

| Token | Value |
|---|---|
| `surfaceBase` | `#101013` |
| `surfaceRaised` | `#06262d` |
| `surfaceOverlay` | `#0a3b3a` |
| `surfaceBorder` | `rgba(255,255,255,0.12)` |
| `brandPrimary` / `brandPrimaryDim` | `#00ff9d` / `#00c77a` |
| `brandPrimaryGlow` | `rgba(0,255,157,0.25)` |
| `accentPrimary` / `accentDim` | `#fad113` / `#ffb300` |
| `accentGlow` | `rgba(250,209,19,0.25)` |
| `statusSuccess` / `statusError` | `#00c77a` / `#cd0013` |
| `statusWarning` / `statusInfo` | `#ffb300` / `#2ba0c4` |
| `textPrimary` / `textSecondary` | `#ffffff` / `rgba(255,255,255,0.6)` |
| `textDisabled` / `textOnBrand` | `#7b7f85` / `#001a1a` |
| `cartelaUnmarkedBg` / `cartelaMarkedBg` | `#0f5149` / `#00ff9d` |
| `cartelaMarkedText` | `#001a1a` |
| `cartelaFreeBg` / `cartelaFreeText` | `#fad113` / `#101013` |
| `numberCalledGlow` | `rgba(0,255,157,0.6)` |
| `winnerGlow` | `rgba(250,209,19,0.8)` |
| `ballB` `ballI` `ballN` `ballG` `ballO` | `#fad113` `#00ff9d` `#2ba0c4` `#8ec714` `#cd0013` |

The cartela and ball tokens have no counterpart on a sportsbook; they are derived from the dash5
palette so bingo surfaces stay in-family.

---

## 4. Contract

Themes split across two packages because the API needs the palette but cannot import Vue components.

### 4.1 `packages/shared-types/src/themes/` — pure data, API-safe

```ts
export const THEME_IDS = ['arada', 'dash5'] as const
export type ThemeId = (typeof THEME_IDS)[number]

export const SHELL_KEYS = ['rails', 'wide'] as const   // phase 1; 'docs' | 'auth' later
export type ShellKey = (typeof SHELL_KEYS)[number]

export interface ThemeTypography {
  ui: string                  // CSS font stack for chrome/labels
  body: string
  heading: string
  googleHref: string | null   // stylesheet to inject, null = system fonts
  baseSize: string            // '13px' | '15px'
}

export interface ThemeDensity {
  navH: string; rowH: string; railW: string; asideW: string
  controlH: string; inputH: string
  radiusSm: string; radiusMd: string; radiusLg: string
  borderW: string
}

export interface ThemeDefinition {
  id: ThemeId
  name: string                // admin dropdown label
  defaultTokens: BrandTokens  // reuses the existing 29-key colour vocabulary
  typography: ThemeTypography
  density: ThemeDensity
}
```

- `themes: Record<ThemeId, ThemeDefinition>`
- `DEFAULT_THEME_ID = 'arada'`
- `resolveTheme(id: string | undefined): ThemeDefinition` — falls back to `arada`, warns once on an
  unknown id (mirrors the existing `resolveBrand` seam this replaces)
- `themeToCssVars(theme): string` — emits the typography + density block. Colours continue to flow
  through the existing `brandTokensToCss`.

`arada.defaultTokens` **imports `DEFAULT_BRAND.tokens` directly** rather than restating the values, so
the two cannot drift.

### 4.2 `apps/web/theme/shells.ts` — Vue side

```ts
export const shells: Record<ThemeId, Record<ShellKey, Component>> = {
  arada: { rails: AradaRailsShell, wide: AradaWideShell },
  dash5: { rails: Dash5RailsShell, wide: Dash5WideShell },
}
```

Statically imported, not `defineAsyncComponent`: `/` is `ssr: false`, so an async shell would flash.
Cost is both themes' shells in the bundle — accepted.

### 4.3 Brand contract changes

- `BrandConfigSchema` gains `themeId: z.enum(THEME_IDS).default('arada')`
- `BrandConfigUpdateSchema` gains optional `themeId`
- `DEFAULT_BRAND.themeId = 'arada'`

---

## 5. Data flow

```
BrandSetting row (DB)
  ├── themeId ──────────────► resolveTheme() ──► ThemeDefinition
  └── tokens (sparse overrides)                    │
                                                   ├── defaultTokens ─┐
                                                   ├── typography ──┐ │
                                                   └── density ─────┤ │
                                                                    │ │
GET /brand ── BrandConfig { …, themeId, tokens: merged } ───────────┘ │
                                                                      │
apps/web/plugins/00.brand.ts                                          │
  ├── htmlAttrs: { 'data-theme': themeId }        ◄── selects skin CSS │
  ├── <link> theme.typography.googleHref                               │
  ├── <style> themeToCssVars(theme)               ◄── typography+density
  └── <style> :root:root { brandTokensToCss(tokens) }  ◄── colours ────┘

layouts/default.vue ──► shells[themeId][route.meta.shell ?? 'rails']
```

Merge rule (`brand.service.mergeBrand`): base becomes `resolveTheme(row.themeId).defaultTokens`
instead of `DEFAULT_BRAND.tokens`; the stored sparse row spreads over it.

---

## 6. Implementation

### 6.1 `packages/shared-types`

- **Add** `src/themes/{types,arada,dash5,index}.ts`
- **Add** `themeToCssVars`
- **Edit** `src/brand.ts` — `themeId` on config + update schemas and on `DEFAULT_BRAND`

### 6.2 `apps/api`

- **Migration** — `BrandSetting.themeId String @default("arada")`
- **`brand.service.mergeBrand`** — merge base becomes the active theme's `defaultTokens`
- **`brand.service.updateBrand`** — when `themeId` changes and the payload carries no `tokens`,
  **clear the stored token overrides to `{}`**. Without this a switch to `dash5` renders in amber and
  does not resemble dash5.

### 6.3 `apps/admin` (branding page only)

- Theme `<select>` bound to `themeId`
- Form seeds from the **active theme's** `defaultTokens`, not `DEFAULT_BRAND.tokens`
- Save sends **only keys differing from those defaults** — this is the fix for Defect A
- Per-token "reset" control + a global "Reset colours to theme default"
- Confirm dialog on theme change: *"Switching theme resets your colour overrides."*

### 6.4 `apps/web`

**New**
- `composables/useAppShell.ts` — auth/wallet/socket wiring, `formattedBalance`, `playerId`, locale
  toggle, search submit, nav item list, and `showDeposit` / `showWithdrawal` as `useState` (the
  buttons live in a shell, the modals in the dispatcher, so the flags must be shared state)
- `theme/shells.ts`
- `components/shells/arada/{RailsShell,WideShell}.vue`
- `components/shells/dash5/{RailsShell,WideShell}.vue`
- `assets/css/themes/{arada,dash5}.css`

**Edited**
- `layouts/default.vue` → ~20 lines: `<component :is="shell"><slot/></component>` + modals +
  `SupportLauncher`. Today's 26KB of markup and scoped CSS moves into `AradaRailsShell.vue` verbatim.
- `plugins/00.brand.ts` → `data-theme` attribute, font link, theme var block
- `assets/css/components.css` → **structure only**. Its 404 lines currently bake the arada look into
  the shared `wb-*` classes (12px radii, uppercase Barlow, soft hover lift, blurred overlays); those
  declarations move to `themes/arada.css`. Skipping this would make arada the implicit base and every
  future theme would fight its specificity.
- `nuxt.config.ts` `css[]` → drop `@world-bingo/ui/styles/tokens.css`, add the two theme files
- Pages gain `definePageMeta({ shell: 'wide' })` where applicable (`games/*`); everything else
  defaults to `rails`

**Deleted**
- `packages/ui/src/styles/tokens.css` — stale palette + wrong fonts; web's `css[]` is its only consumer
- `packages/ui/src/theme/{types,resolveBrand,brandToCssVars,brands/}.ts` — an orphaned parallel brand
  registry superseded by the shared-types brand contract; nothing imports it but `packages/ui/src/index.ts`
- Corresponding exports in `packages/ui/src/index.ts`

**Kept**
- `packages/ui/src/theme/tokens.base.css` — brand-agnostic structural tokens, still valid

### 6.5 Skin CSS mechanism

There are two layers and they must not overlap:

**Token values come only from `themeToCssVars`.** The plugin emits one `:root` block built from the
active `ThemeDefinition`. Typography and density have exactly one source of truth — the TypeScript
definition — so a theme file never declares a `--font-*`, `--row-h`, `--radius-*` or `--border-w`.

**Theme CSS files carry only skin rules**, wholly wrapped in an attribute scope, and consume the
tokens above:

```css
[data-theme='dash5'] .wb-btn {
  height: var(--control-h);
  border-radius: var(--radius-sm);
  text-transform: uppercase;
  background: linear-gradient(var(--brand-primary), #1b4334);
}
```

Both files load unconditionally; the `data-theme` attribute on `<html>` selects one. It is
SSR-rendered by `useHead`, so there is no flash — including on the `ssr: false` routes, where a
dynamic `import()` would have flashed. Cost is a few KB of unused CSS.

Specificity: `themeToCssVars` emits at **`:root:root`**, the same 0,2,0 the brand block already uses.
Plain `:root` would not be enough — `packages/ui/src/theme/tokens.base.css` defines `--radius-sm/md/lg`
at `:root`, and a theme must outrank it deterministically rather than depending on stylesheet order.
The two `:root:root` blocks do not compete: themes never emit colour tokens, brand never emits
typography or density. The plugin injects theme first, brand second.

---

## 7. Migration & backward compatibility

- Existing `BrandSetting` singletons keep their full token set and receive `themeId = 'arada'`.
- `arada.defaultTokens` is `DEFAULT_BRAND.tokens` verbatim, so the merged **colour** output is
  byte-identical to today for every existing deployment.
- Typography is the deliberate exception. Fixing Defect B means `arada` starts defining `--font-ui`
  and loading Oswald / Barlow Condensed / Inter, so text that silently rendered in Space Grotesk will
  change. That is the bug being fixed, not a regression.
- The stored `tokens` column changes semantics from "complete palette" to "sparse overrides". Existing
  rows remain valid — a complete set is simply a sparse set that happens to cover every key.
- **Accepted trade-off:** a retinted deployment (e.g. betbawa) that switches to `dash5` loses its
  custom colours and must re-apply them. Surfaced in the confirm dialog.

---

## 8. Testing

**`packages/shared-types`**
- Every theme's `defaultTokens` parses against `BrandTokensSchema`
- Theme ids are unique and match their registry keys
- **`arada.defaultTokens` deep-equals `DEFAULT_BRAND.tokens`** — the no-regression guarantee
- `resolveTheme` falls back to `arada` for unknown / undefined ids
- `themeToCssVars` emits every declared typography and density key

**`apps/api`**
- `mergeBrand` uses the active theme's defaults as its base
- Sparse overrides win over theme defaults
- Unknown stored `themeId` falls back to `arada` without throwing
- `updateBrand` clears token overrides on a theme change, and preserves them when `themeId` is unchanged
- Existing brand route tests continue to pass with `themeId` present in the payload

**`apps/web`**
- `useAppShell` — balance formatting, player id fallback, locale toggle, search submit
- `buildBrandStyle` unchanged (regression)
- Shell dispatch resolves `route.meta.shell`, and defaults to `rails` when absent

**E2E (Playwright)**
- `html[data-theme]` matches the configured theme
- Under `dash5`: computed base font-size is 13px and the left rail renders
- Under `arada`: lobby renders unchanged

**Verification note.** Per repo memory, `apps/admin` typecheck, web `pnpm test`, and lint are red or
blind by default in this repo — results must be confirmed by grepping per-file output rather than
trusting exit codes. `apps/api` is the exception and can be trusted.

---

## 9. Out of scope

- `apps/admin` visual theming (D3) — it keeps its `@nuxt/ui` look and continues to read brand colours
- The `docs` and `auth` shell keys (D7) — promotions, wallet, transactions, profile and auth pages keep
  today's layout until a follow-up
- Player-selectable themes — the choice is a single admin-level setting
- Admin-editable typography or density — themes own these; admins may retint but not restyle
- dash5's betslip rail as a *feature*. Bingo has no betslip; the dash5 `rails` shell uses the right rail
  for active cartelas and the left rail for game rooms

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| `components.css` refactor touches every `wb-*` class | Mechanical move, not a rewrite; the `arada` E2E assertion catches regressions |
| Both themes' shells and CSS ship in the bundle | A few KB; the alternative (async) flashes on `ssr: false` routes |
| Sparse-token write path is a behaviour change in admin | Covered by API tests; existing complete rows stay valid |
| dash5's 13px / 27px density may be too tight on mobile | Density values are tokens — tune per breakpoint in `themes/dash5.css` |
