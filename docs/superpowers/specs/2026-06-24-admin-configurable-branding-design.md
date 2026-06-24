# Admin-Configurable Branding (White-Label) — Design

**Date:** 2026-06-24
**Branch:** `feat/env-driven-brand`
**Status:** Approved design, pending implementation plan

## Problem

We deploy the same codebase as multiple independent instances (separate DBs,
separate admin panels). Each instance must present its own brand — name, logo,
favicon, and color theme — without code changes. The first new instance is
**Arada Bingo** (deep teal/green), distinct from the existing **World Bingo**
(amber). Branding must be editable at runtime from each instance's admin panel,
not baked in at build time.

## Goals

- One active brand per deployment, edited in place from the admin panel.
- Full color-token control (brand, accent, surface, text, status, balls, cartela),
  plus display name, short name, logo, and favicon.
- No color/name flash on page load (SSR-injected).
- Zero-config default: an instance with no brand record renders exactly the
  current World Bingo amber look. No data migration required.

## Non-Goals

- No multi-brand switcher / brand library (one brand per instance — the instance
  *is* the brand boundary, enforced by separate DBs).
- No admin app re-theming in this pass (admin keeps its current look; it only
  *edits* the player-app brand). Scope is the player web app's appearance.
- No font-family configuration in this pass (colors + identity only). Fonts stay
  on the current token defaults; can be added later behind the same schema.

## Architecture

### Single source of truth — `packages/shared-types`

A Zod schema `BrandConfigSchema` defines every brand-controllable field:

- `displayName: string` (e.g. "Arada Bingo")
- `shortName: string` (e.g. "Arada")
- `logoUrl: string | null`
- `faviconUrl: string | null`
- `tokens: Record<BrandTokenKey, string>` — hex/rgba color strings keyed by a
  closed enum of token names mirroring `packages/ui/src/styles/tokens.css`
  (e.g. `brandPrimary`, `brandPrimaryDim`, `brandPrimaryGlow`, `accentPrimary`,
  `accentDim`, `surfaceBase`, `surfaceRaised`, `textPrimary`, `statusSuccess`,
  `ballB`…`ballO`, `cartelaMarkedBg`, `winnerGlow`, …).

Exported alongside it: `DEFAULT_BRAND: BrandConfig`, holding the current World
Bingo values copied from `tokens.css`. This constant is the fallback used by both
API (merge base) and web (build-time default). The mapping from `tokens.*` keys
to CSS custom properties (`brandPrimary` → `--brand-primary`) lives here too as
`BRAND_TOKEN_CSS_VARS`, consumed by the web injector.

Color values validated as hex (`#rgb`/`#rrggbb`) or `rgba(...)` strings.

### Data — Prisma `BrandSetting`

A singleton row with a fixed string `id` of `"default"`:

```prisma
model BrandSetting {
  id          String   @id @default("default")
  displayName String
  shortName   String
  logoUrl     String?
  faviconUrl  String?
  tokens      Json     // validated against BrandConfigSchema.tokens on write
  updatedAt   DateTime @updatedAt
  @@map("brand_settings")
}
```

Rationale for a dedicated model over reusing `SiteSetting` (key/value strings):
the brand is a structured JSON document with a typed column and a single logical
record — a dedicated model reads clearly and avoids JSON-in-a-string-column.

The row is **absent by default**. The API treats absent → `DEFAULT_BRAND`.

### API (`apps/api`)

Reuse existing infra: `@fastify/multipart` (already registered), `storage.ts`
`uploadFile()` (validated image upload, local/GCS/MinIO, returns a `/uploads/...`
URL), and static serving of `/uploads/`.

- **`GET /brand`** — *public*, no auth. Returns `DEFAULT_BRAND` deep-merged with
  the `BrandSetting` row if present (DB values win; missing token keys fall back
  to default). New `brandRoutes` registered at prefix `/brand`
  (→ web sees it at `/api/brand`). Cacheable (short `Cache-Control`).
- **`PUT /admin/brand`** — admin JWT (under existing `adminRoutes`). Body
  validated by `BrandConfigSchema` (partial allowed; unknown token keys rejected).
  Upserts the singleton.
- **`POST /admin/brand/logo`** and **`POST /admin/brand/favicon`** — admin JWT,
  multipart. Validate + `uploadFile()`, return `{ url }`. Admin then includes the
  returned URL in the `PUT /admin/brand` payload (upload and save are separate
  steps; save persists the URL).

### Web (`apps/web`)

- **Nuxt plugin** (`plugins/00.brand.ts` — the path `theme.css` already
  references): on **server** render, fetch `/api/brand`, store in `useState`,
  and inject into `<head>` via `useHead`:
  1. a `<style id="brand-tokens">:root{ --brand-primary: …; … }</style>` built by
     mapping `tokens` through `BRAND_TOKEN_CSS_VARS` — this paints correct colors
     in the initial SSR HTML, **no flash**;
  2. `<title>` / meta application name from `displayName`;
  3. favicon `<link>` from `faviconUrl` when set.
  Client hydrates from the same `useState` (no refetch).
- **`tokens.css`** keeps its current literal values as the always-present
  fallback layer; the injected `#brand-tokens` block overrides `:root`.
- **`BrandLogo.vue`** reads `logoUrl` (and `displayName` for `alt`) from the brand
  state instead of the hardcoded `/brands/arada/logo.png`; falls back to
  `DEFAULT_BRAND.logoUrl` when unset.
- **PWA manifest**: `name`/`short_name`/`theme_color` currently hardcoded in
  `nuxt.config.ts`. These are build-time and cannot read runtime DB. Acceptable
  for v1 (manifest is install-time chrome, not in-app paint). Documented as a
  known limitation; a follow-up can serve a dynamic `manifest.webmanifest` route.

### Admin (`apps/admin`)

New page `pages/settings/branding.vue`, following the existing settings-page
pattern (`features.vue`, `payment-methods.vue`):

- Text inputs: display name, short name.
- Logo + favicon upload widgets (POST to upload endpoints, show preview from
  returned URL).
- Color inputs (native `<input type="color">` + hex text field) for every token,
  grouped by section: Brand, Accent, Surface, Text, Status, Balls, Cartela.
- A small live-preview panel applying the in-progress tokens to sample chips /
  buttons / a cartela cell.
- Load current config via `GET /brand`; Save via `PUT /admin/brand`.

## Data Flow

1. Admin edits tokens/name, uploads logo → `POST /admin/brand/logo` → URL.
2. Admin saves → `PUT /admin/brand` (Zod-validated) → upsert `BrandSetting`.
3. Player loads page → web SSR `GET /api/brand` → injects tokens + name + logo
   into HTML head → correct brand painted on first byte.

## Error Handling

- `GET /brand` on DB error → return `DEFAULT_BRAND` (never break the player app).
- `PUT /admin/brand` invalid body → 400 with Zod issues; row unchanged.
- Upload: invalid type/size → 400 (reuse `validateFile` errors). Save with a
  logo URL that later 404s → image `alt` text shows; non-fatal.
- Web plugin: `/api/brand` fetch fails → fall back to `DEFAULT_BRAND` baked in;
  page still renders branded (as World Bingo) rather than unstyled.

## Testing

- **shared-types**: `BrandConfigSchema` accepts `DEFAULT_BRAND`; rejects bad hex,
  unknown token keys, missing required name fields.
- **API**: `GET /brand` returns defaults when empty, merged when set; `PUT`
  validates and upserts; upload returns a URL; admin endpoints reject non-admin.
- **Web**: plugin injects a `#brand-tokens` style whose `--brand-primary` matches
  the served config; `BrandLogo` renders the configured `logoUrl`.
- **Manual**: seed teal Arada values + Arada logo via admin, load player app,
  confirm teal theme + Arada logo with no flash; confirm a fresh DB still shows
  World Bingo amber.

## Rollout

1. Land schema + shared-types + API + web injector with `DEFAULT_BRAND` = current
   World Bingo. Existing instance behavior is byte-for-byte unchanged (no row).
2. Add the admin Branding page.
3. On the new Arada instance: via admin, enter the teal palette
   (suggested start: `brandPrimary #14b8a6`, `brandPrimaryDim #0d9488`, dark-teal
   surface to match the target header gradient), upload the Arada logo/favicon,
   set name "Arada Bingo" / "Arada", save.

## Open Implementation Detail (resolve in plan, not blocking)

- Confirm the web→API proxy path so the public read is reachable as `/api/brand`
  (existing feature-flag reads establish the working pattern to mirror).

## Affected Files (indicative)

- `packages/shared-types/src/entities/brand.ts` (+ `index.ts` export)
- `apps/api/prisma/schema.prisma` (+ migration)
- `apps/api/src/routes/brand/index.ts` (public GET), `routes/admin/*` (PUT+upload),
  `apps/api/src/index.ts` (register `brandRoutes`)
- `apps/web/plugins/00.brand.ts`, `apps/web/components/BrandLogo.vue`,
  `apps/web/composables/useBrand.ts`
- `apps/admin/pages/settings/branding.vue`
