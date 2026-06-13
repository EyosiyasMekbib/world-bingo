# Admin Analytics (Layer 2) — Behavioral Events Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-06-13
**Builds on:** Layer 1 (`docs/superpowers/plans/2026-06-12-admin-analytics-layer1.md`) — SQL snapshots over existing tables.

## Goal

Capture behavioral events that do **not** exist in the database today, to answer two
product questions and turn them into action:

1. **Deposit friction** — where do players drop off between opening the deposit modal and
   getting an approved deposit?
2. **Convert lobby browsers** — where do visitors (including anonymous, pre-registration
   guests) leak out of the path: visited → viewed a game → registered → deposited → played?

Layer 1 answers "what happened" from existing rows (funnel, retention, engagement). Layer 2
adds the missing intent signals — modal opens, game views, join clicks — and stitches
anonymous browsing to the user once they register.

## Scope

**In scope**
- A generic `analytics_events` table (Postgres, JSONB props).
- A frontend capture pipeline (`useAnalytics()` composable) in `apps/web` with anonymous-ID +
  session-ID generation and batched, beacon-backed delivery.
- A public, rate-limited, Zod-validated `POST /events` + `POST /events/identify` ingestion API.
- Backend instrumentation of the authoritative `deposit_submitted` event.
- Two new admin analytics funnels (browse-funnel, deposit-funnel) + conversion KPI cards,
  surfaced on the existing `/analytics` page.
- A retention job to bound the events table.

**Out of scope (Layer 3)**
- Session replay.
- Real-time event streaming / live dashboards.
- Automated nudge / campaign triggering off segments. Layer 2 *surfaces* the segments and
  funnels; acting on them automatically is later.
- Frontend events beyond the lobby/deposit paths (e.g. cartela hover heatmaps).

## Architecture overview

```
apps/web (Nuxt)                      apps/api (Fastify)                 Postgres
─────────────────                    ──────────────────                 ────────
useAnalytics()                       POST /events  (public)             analytics_events
  - anonId  (localStorage)   ──────► POST /events/identify (public)  ─► (name, userId?,
  - sessionId (sessionStorage)         - Zod allowlist                    anonId?, sessionId?,
  - track(name, props)                 - rate-limited                     props jsonb, createdAt)
  - batch flush / sendBeacon           - attaches userId from JWT if any
                                       - EventService.record()
deposit modal steps  ──────────────► (frontend events)
POST /deposit handler ─────────────► deposit_submitted (server-authoritative)

AnalyticsService (raw SQL)  ◄──────  analytics_events  ⋈  transactions / users / game_entries
  - getBrowseFunnel(from,to)
  - getDepositFunnel(from,to)
  - getConversionKpis(from,to)
        │
        ▼
GET /admin/analytics/browse-funnel | deposit-funnel   (admin-only, same auth as Layer 1)
        │
        ▼
apps/admin /analytics page  — new cards/charts in the existing Layer 1 style
```

## Data model

New Prisma model in `apps/api/prisma/schema.prisma`:

```prisma
model AnalyticsEvent {
  id        String   @id @default(cuid())
  name      String   // allowlisted event name (see Event Catalog)
  userId    String?  // set when the request carries a valid JWT
  anonId    String?  // client-generated UUID, persists in localStorage pre-login
  sessionId String?  // client-generated, resets per browser session/tab
  props     Json?    // event-specific payload (gameId, amount, paymentMethod, step, etc.)
  createdAt DateTime @default(now())

  @@index([name, createdAt])  // funnel queries scan by name within a date window
  @@index([anonId])           // anonymous → user stitching
  @@index([userId])           // per-user trails
  @@map("analytics_events")
}
```

Notes:
- No foreign key on `userId`/`anonId` — events are append-only telemetry and must not block
  on referential integrity or be cascade-deleted with a user.
- `props` is freeform JSONB but every writer uses a small typed helper so payload shapes stay
  consistent per event name.

### Anonymous → user stitching

- The web app generates `anonId` (UUID, `localStorage`, survives across visits) and
  `sessionId` (`sessionStorage`, per tab/session). Both ride on every event.
- On register/login the client calls `track('identify', {})`. The backend writes an `identify`
  event carrying both the now-known `userId` and the current `anonId`.
- Funnel queries resolve a converted visitor's full pre-signup trail by joining a user back to
  their `anonId`(s) via the most recent `identify` event for that user.

## Event catalog (allowlist)

The `POST /events` endpoint rejects any `name` not in this enum. Frontend events are written by
the composable; the one backend event is written server-side.

| name                     | source   | key props                          | purpose |
|--------------------------|----------|------------------------------------|---------|
| `lobby_view`             | frontend | —                                  | browse funnel stage 1 |
| `game_view`              | frontend | `gameId`                           | browse funnel stage 2 |
| `join_click`             | frontend | `gameId`                           | browse funnel stage 3 (intent) |
| `deposit_modal_opened`   | frontend | —                                  | deposit funnel stage 1 |
| `deposit_method_selected`| frontend | `paymentMethod`                    | deposit funnel stage 2 |
| `deposit_amount_entered` | frontend | `paymentMethod`, `amountBucket`    | deposit funnel stage 3 |
| `deposit_submitted`      | backend  | `paymentMethod`, `amount`, `txId`  | deposit funnel stage 4 (authoritative) |
| `identify`               | both     | (links `anonId` ↔ `userId`)        | anonymous stitching |

`amountBucket` (not raw amount) is used for the pre-submit frontend step to avoid trusting
client-reported money; the authoritative amount comes from `deposit_submitted`/transactions.

Deposit *outcomes* (`approved` / `declined` / time-to-decision) are **derived from the existing
`transactions` table** in SQL — they are not events. Layer 2 joins the frontend funnel to the
transaction record by `userId` + `txId`.

## Capture pipeline

### Frontend — `useAnalytics()` (`apps/web/composables/useAnalytics.ts`)

- On first load: ensure `anonId` in `localStorage`, `sessionId` in `sessionStorage`.
- `track(name, props?)`: push `{ name, props, anonId, sessionId, ts }` into an in-memory queue.
- Flush: every ~5s if the queue is non-empty, and on `visibilitychange`→hidden /
  `beforeunload`, using `navigator.sendBeacon('/api/events', batch)` so the final flush
  survives page close. Falls back to `fetch(..., { keepalive: true })` where beacon is absent.
- Auth: requests include the existing auth cookie/header when logged in; the backend derives
  `userId` from the JWT. Anonymous requests carry only `anonId`/`sessionId`.
- Instrumented call sites:
  - `lobby_view` — lobby page mount (`pages/index.vue`).
  - `game_view` — opening a game / cartela-selection screen.
  - `join_click` — tapping the join/confirm action.
  - `deposit_modal_opened` / `deposit_method_selected` / `deposit_amount_entered` — deposit
    modal step transitions.
  - `identify` — after successful register/login.

### Backend — ingestion API (`apps/api/src/routes/events/`)

- `POST /events` and `POST /events/identify` — **public** (anonymous visitors must reach them),
  but behind the existing Fastify rate-limiter with a tightened budget (e.g. 60 req/min/IP).
- Zod validation:
  - `name` ∈ allowlist enum (unknown names dropped).
  - Batch length capped (≤ 50 events/request).
  - `props` size-capped; only expected keys per event are persisted.
- `userId` is taken from the JWT if a valid one is present, never from the body.
- `EventService.record(events, ctx)` bulk-inserts via `prisma.analyticsEvent.createMany`.
- Bot consistency: events authored by `bot_t%` users are excluded at **query time** (same rule
  as Layer 1), so ingestion stays simple.

### Backend — deposit instrumentation

- In the `POST /deposit` handler (`apps/api/src/routes/wallet/index.ts`), after the pending
  transaction is created, write `deposit_submitted` with `{ paymentMethod, amount, txId }`.
  Server-authoritative — not trusted from the client.

## Analytics queries & dashboard

New static methods on `AnalyticsService` (raw SQL, `::int` casts, bot exclusion — same
conventions as Layer 1), new admin-only endpoints, new sections on the existing `/analytics`
page using the established card/chart components.

### `getBrowseFunnel(from, to)` → `GET /admin/analytics/browse-funnel`
Stages over the range (distinct actors = userId when present else anonId):
`visited` (`lobby_view`) → `viewed_game` (`game_view`) → `join_click` → `registered`
(`users.createdAt` in range, stitched via `identify`) → `deposited` (approved deposit) →
`played` (`game_entries`). Returns counts + drop-off % between stages.

### `getDepositFunnel(from, to)` → `GET /admin/analytics/deposit-funnel`
Stages: `modal_opened` → `method_selected` → `amount_entered` → `submitted` → `approved`
(from `transactions`). Returns per-step abandonment %, avg time-to-approval (from transaction
timestamps), and a breakdown by `paymentMethod` (which method abandons most).

### `getConversionKpis(from, to)` → KPI cards
Visitor→registration rate, registration→first-deposit rate, browse-session count vs. join
rate, anonymous visitors in the last 7/30 days.

### Admin client + page
- `apps/admin/composables/useAdminApi.ts`: typed methods for the two new endpoints + KPIs.
- `apps/admin/pages/analytics.vue`: new "Acquisition & Deposits" sections — two funnel
  visualizations + KPI cards, reusing existing styles and the range selector.

## Volume, retention, testing

- **Indexing:** `@@index([name, createdAt])` serves the funnel scans; batching keeps write load
  low.
- **Retention:** a small BullMQ scheduled job prunes raw `analytics_events` older than 90 days.
  Funnels run on recent windows; long-term trends already live in Layer 1 snapshots. Keeps the
  table bounded.
- **Testing:**
  - Pure shaping helpers (funnel stage math, drop-off %) unit-tested (Vitest), like Layer 1.
  - SQL methods covered by mocked-prisma shaping tests + a manual dev-stack pass.
  - Ingestion endpoint: Zod allowlist / rate-limit / userId-from-JWT-not-body covered by tests.

## File map (anticipated)

| File | Action | Responsibility |
|---|---|---|
| `apps/api/prisma/schema.prisma` | Modify | Add `AnalyticsEvent` model |
| `apps/api/prisma/migrations/<ts>_add_analytics_events/` | Create | Generated migration |
| `apps/api/src/services/event.service.ts` | Create | `record()` bulk insert + allowlist |
| `apps/api/src/routes/events/index.ts` | Create | Public `POST /events`, `/events/identify` |
| `apps/api/src/routes/wallet/index.ts` | Modify | Emit `deposit_submitted` |
| `apps/api/src/services/analytics.service.ts` | Modify | `getBrowseFunnel`, `getDepositFunnel`, `getConversionKpis` |
| `apps/api/src/routes/admin/analytics.ts` | Modify | New endpoints |
| `apps/api/src/jobs/` (BullMQ) | Create/Modify | 90-day prune job |
| `apps/api/src/test/*` | Create | Helper + shaping + endpoint tests |
| `apps/web/composables/useAnalytics.ts` | Create | Capture pipeline, anonId/sessionId |
| `apps/web/pages/index.vue` + game/deposit components | Modify | `track()` call sites |
| `apps/admin/composables/useAdminApi.ts` | Modify | Client methods |
| `apps/admin/pages/analytics.vue` | Modify | New funnel + KPI sections |

## Key decisions (resolved)

- **Capture mechanism:** custom Postgres `analytics_events` table (not PostHog) — keeps data in
  Postgres, no new infra/cost, matches Layer 1's raw-SQL style.
- **Storage shape:** single generic table + JSONB props (Approach A) — new event types need no
  migration.
- **Anonymous tracking:** yes — anonId + sessionId with `identify`-based stitching, because
  "convert browsers" depends on the pre-registration funnel.
- **Trust boundary:** `userId` and deposit amounts/outcomes are server-authoritative; the
  public endpoint only accepts allowlisted names and capped payloads.
