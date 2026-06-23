# Themeable Multi-Brand Frontend — Design

**Date:** 2026-06-23
**Status:** Approved (pending spec review)
**Scope:** Player web app (`apps/web`) + shared UI (`packages/ui`). Admin app out of scope.

## Goal

Make the player-facing betting platform configurable in colors, fonts, logo, name,
and other visual design elements, so multiple branded "systems" can run from the
same codebase. First brand: **Arada Bingo**, built from the Claude Design handoff.

## Deployment model (decided)

**Separate deployment per brand**, theme selected at boot via an environment
variable. Each brand is its own instance with its own DB/Redis — clean financial
and regulatory isolation (no multi-tenant scoping of wallets/transactions).

The architecture is designed with a **single seam** so it can later evolve to an
admin-editable, DB-backed theme source without restructuring components ("C-ready").

### Rejected alternatives

- **Multi-tenant single instance:** forces tenant-scoping onto every wallet query,
  `SELECT FOR UPDATE`, Redis key, and BullMQ job — large surface for cross-brand
  financial leaks. Not worth it for a theming goal.
- **Jump straight to DB/admin-editable themes:** adds API endpoints, admin CRUD,
  and flash-of-unstyled-content handling before brand #1 can ship. Deferred; the
  seam is left in place.

## Scope of a "theme"

**Tokens only** (Q4 option A): same layout and components for every brand; brands
differ by token *values* — colors, fonts, logo, app name, PWA manifest. No
per-brand component/layout divergence in this phase (the token model can still
accommodate the occasional override later).

## Token model (the contract)

Two layers:

- **`base` (shared, brand-agnostic):** spacing scale, radii, shadows, motion
  (durations/easings), breakpoints, z-index, keyframes, and the *semantic
  structure* of color/type tokens (the variable names every component uses).
- **`brand` (per-system):** the *values* — colors, font families + font URL, logo
  assets, app name, PWA manifest fields, favicon.

**Hard rule:** components reference only semantic tokens (e.g. `--brand-primary`,
`--surface-base`, `--font-heading`, `--font-ui`). No component contains a literal
hex color or hardcoded font-family. The Arada prototype hardcodes everything inline
(`#f5a623` ×20, `'Barlow Condensed'` ×31); none of those literals survive the port.

## File layout

```
packages/ui/src/theme/
  tokens.base.css        # shared structural tokens + keyframes (brand-agnostic)
  types.ts               # BrandTheme TypeScript interface (the contract)
  brands/
    arada.ts             # Arada token VALUES
    <future-brand>.ts
  resolveBrand.ts        # single C-ready seam: returns the active BrandTheme
  applyBrand.ts          # BrandTheme -> CSS variables + font <link> + meta/manifest
```

`resolveBrand.ts` is the C-ready seam: today it returns `brands[env.BRAND]`; later
it can `await fetch('/api/brand')` with no changes elsewhere.

## BrandTheme contract (shape)

```ts
interface BrandTheme {
  id: string                 // 'arada'
  name: string               // 'Arada Bingo'  -> app title, manifest name
  colors: {                  // semantic, not raw
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
    // game-specific: cartela unmarked/marked, ball B/I/N/G/O, glows
  }
  fonts: {
    heading: string          // 'Oswald'
    ui: string               // 'Barlow Condensed'
    body: string             // 'Inter'
    googleHref: string       // Google Fonts stylesheet URL for the above
  }
  logo: { full: string; mark: string }      // asset paths under public/brands/<id>/
  manifest: { themeColor: string; backgroundColor: string; shortName: string }
}
```

### Arada token values (from the handoff)

- Surfaces: base `#0a1628`, raised `#0d1f3c`, border `rgba(255,255,255,0.12)`
- Brand: primary `#f5a623`, accent (blue) `#1d4a8a`
- Text: primary `#ffffff`, secondary `rgba(255,255,255,0.7)`, on-brand `#0a1628`
- Fonts: heading Oswald, UI Barlow Condensed, body Inter

## Boot flow (how a brand gets applied)

1. `NUXT_PUBLIC_BRAND=arada` set per deployment (env / `.env`), surfaced through
   Nuxt `runtimeConfig.public`.
2. A Nuxt plugin calls `resolveBrand()` -> `BrandTheme`.
3. `applyBrand()` injects, **server-side during SSR** (so there is no flash of
   unstyled/unthemed content):
   - CSS custom properties onto `:root`
   - the brand's Google Fonts `<link>`
   - `<title>`, favicon, `theme-color` meta, and PWA manifest name/colors
4. App renders; every component reads the now-set variables.

The PWA manifest `theme_color`/`background_color`/`name` (currently hardcoded to
World Bingo amber in `nuxt.config.ts`) become brand-driven.

## Component build (the Arada UI)

Rebuild the player UI to match the Arada handoff, fully tokenized. The current
amber bingo-game-centric UI is replaced by this casino-portal layout. Gameplay
**logic** (cartela, ball draw, countdown, sockets, wallet) is untouched — only the
presentation is restyled to the new tokens.

### Desktop layout (from handoff)

Header (logo · game search · balance + user ID · **Deposit** · mail/wallet/lang
icons) -> primary nav -> hero carousel (welcome bonus) -> winners tabs
(daily/weekly/monthly) -> category filter pills -> game-card grid -> footer.

### Mobile layout (from D3 reference — structure only, Arada paint)

- **Top bar:** hamburger · logo · search icon · balance + ID · **Deposit** · profile avatar
- **Horizontal scrolling icon-nav:** icon + label per item, active item underlined
  in `--brand-primary`
- **Winners tabs** (daily / weekly / monthly)
- **Winner cards** with game thumbnail
- **Horizontal filter pills:** search · ALL · categories · ★ favorites
- **"Providers ▾"** dropdown
- **2-column game-card grid** (thumbnail · name · ★)

Mobile copies the reference *layout* only; all color/typography/branding is Arada.

### Navigation & categories are data-driven

Nav items and game categories are **not hardcoded**. They reflect the products
actually available in the deployment. **No sports** in this phase (SPORT / VIRTUAL
SPORT removed). Making these data-driven also serves the configurable goal — a
brand can list its own games without code edits.

## Adding brand #2 (the payoff)

1. Add `brands/<brand>.ts` with new token values.
2. Drop logo/assets in `public/brands/<brand>/`.
3. Deploy with `NUXT_PUBLIC_BRAND=<brand>`.

No component edits.

## Guardrail (keeps it themeable)

A CI/lint check (ESLint rule or a grep-based test) fails the build if a raw hex
color or hardcoded `font-family` appears in component files — forcing all styling
through tokens and preventing the prototype's hardcode pattern from creeping back.

## Out of scope (YAGNI)

- Multi-tenant single instance (financial isolation).
- Admin app theming + admin live-edit UI (deferred to phase C; seam left in place).
- Per-brand component/layout divergence (Q4 option B).
- Sports / virtual sport.

## Affected areas

- `packages/ui/src/styles/tokens.css` -> split into `theme/tokens.base.css` + brand defs.
- `packages/ui/src/components/*` -> tokenized; new layout components.
- `apps/web/nuxt.config.ts` -> `NUXT_PUBLIC_BRAND`, brand-driven manifest, font handling.
- `apps/web` pages/layouts/components -> rebuilt to Arada layout (desktop + mobile).
- New Nuxt plugin for brand resolution + application.
- CI/lint guardrail.
