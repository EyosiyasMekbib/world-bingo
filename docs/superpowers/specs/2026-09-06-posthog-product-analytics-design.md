# PostHog Product Analytics — Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-09-06
**Builds on:** Layer 1 (`docs/superpowers/plans/2026-06-12-admin-analytics-layer1.md`), Layer 2
(`docs/superpowers/specs/2026-06-13-admin-analytics-layer2-design.md`), game retention insights
(`docs/superpowers/specs/2026-06-14-game-retention-insights-design.md`), observability
(`docs/superpowers/specs/2026-06-26-observability-and-devops-design.md`).

## Goal

Answer "why are players declining" with PostHog: session replay, retention, lifecycle, paths and
funnels over both browser behaviour and the server-authoritative money and game outcomes — with the
history that already sits in Postgres backfilled so trends are visible on day one.

The custom pipeline built in June (`analytics_events`, `useAnalytics()`, the admin `/analytics`
page) stays. PostHog is added beside it, not instead of it. That decision is revisited once PostHog
has proven itself on live data; nothing here depends on the custom pipeline going away.

## Why PostHog on top of what exists

The custom pipeline answers "what happened" for a fixed set of questions with SQL written per
question. It cannot:

- show the actual session of a player who deposited and never played (session replay);
- answer a new question (path analysis, a new cohort, a lifecycle split) without a code change;
- separate "fewer new players" from "more dormant players" without another SQL method.

Both are the shape of "why are users declining". PostHog Cloud does all three for free at this
volume (1M events and 5k replays per month on the free tier).

## Scope

**In scope**

- `posthog-js` in `apps/web`, env-gated, proxied through the Nuxt server so ad blockers do not eat
  events. Session replay on, all inputs masked, receipt images blocked.
- `posthog-node` in `apps/api`, env-gated, emitting the server-authoritative lifecycle events listed
  in the catalog below.
- `useAnalytics().track()` becomes an adapter: every call goes to PostHog **and** to the existing
  `/events` endpoint. No call site changes.
- Three defects in the existing pipeline that sit directly on this path, fixed as part of the work.
- A one-off, re-runnable backfill script that turns existing Postgres rows into historical PostHog
  events.
- A runbook (`docs/posthog.md`) covering setup, verification, the backfill, and the six insights to
  build for churn diagnosis.

**Out of scope**

- PostHog in `apps/admin`. Admin behaviour is not the question.
- Self-hosted PostHog. It needs ClickHouse, Kafka and 16 GB; that is its own infrastructure project.
- Feature flags, experiments, surveys. PostHog offers them; nothing here wires them.
- Replacing GlitchTip with PostHog error tracking.
- Removing the custom `analytics_events` pipeline or the admin `/analytics` page.
- Creating PostHog dashboards through its API. The runbook describes them; they are built in the UI.

## Architecture

```
apps/web (Nuxt)                          PostHog Cloud EU
─────────────────                        ────────────────
plugins/02.posthog.client.ts             eu.i.posthog.com   ◄── /ingest/**  (Nuxt routeRule proxy)
  posthog-js init (env-gated)            eu-assets.i.posthog.com ◄── /ingest/static/**
  super props: brand, locale, is_pwa
  $pageview on history change
  session replay, masked
  identify / reset from store/auth.ts
                                                  ▲
composables/useAnalytics.ts                       │
  track(name, props) ──► posthog.capture ─────────┤
                     └─► POST /events (unchanged) │
                                                  │
apps/api (Fastify)                                │
──────────────────                                │
lib/posthog.ts  (mirrors lib/sentry.ts)           │
  initPostHog / captureEvent / shutdownPostHog ───┘
  bot exclusion, never throws, no-op when POSTHOG_KEY unset

  emitted post-commit from:
    auth.service        user_registered, user_logged_in
    wallet.service      deposit_submitted, deposit_approved, withdrawal_requested, withdrawal_rejected
    zarecash-checkout   deposit_submitted
    admin.service       deposit_rejected, withdrawal_approved
    game.service        game_joined, game_left, game_finished (winner path), game_refunded
    lib/game-engine     game_finished (no-winner path)
    bonus callers       bonus_granted
    account-status      account_status_changed
    game-provider route provider_game_launched

scripts/posthog-backfill.ts
  Postgres rows ──► lib/posthog-backfill.ts (pure mappers) ──► posthog-node batch, historicalMigration
```

## Identity

- **distinct_id** is the user UUID (`users.id`). Never phone, username or Telegram id.
- Anonymous visitors get PostHog's own device id. On login/register the client calls
  `posthog.identify(user.id, personProps)`, which merges the anonymous trail into the person.
- **Person properties** (set on identify and on `user_registered`): `serial`, `brand`,
  `signup_method` (`phone` | `telegram`), `referred` (boolean, server-side only — the client never
  sees `referredById`), `created_at`.
  Never phone, first or last name, password hash, account numbers, receipt URLs.
- `person_profiles: 'identified_only'` — anonymous events are captured, person rows are only created
  once someone signs in. Keeps the person table to real players.
- Logout calls `posthog.reset()` **and** rotates `wb_anon_id`, so the next account on a shared
  phone does not inherit the previous player's trail (defect 3 below).
- Bots (`username LIKE 'bot_t%'` or `passwordHash = 'BOT_ACCOUNT'`) and staff (`role != PLAYER`) are
  excluded at emit time on the server and at the source in the backfill, matching `AnalyticsService`. The server helper caches `userId → isBot` in a bounded
  in-memory map (one `findUnique` per unseen user, then free).

## Client (`apps/web`)

### Plugin `plugins/02.posthog.client.ts`

Env-gated exactly like `sentry.client.config.ts`: empty `NUXT_PUBLIC_POSTHOG_KEY` means the plugin
returns without initialising and `$posthog` is `null`. Everything downstream checks for `null`.

```ts
posthog.init(key, {
  api_host: config.public.posthog.host,          // '/ingest' by default
  ui_host: config.public.posthog.uiHost,         // 'https://eu.posthog.com'
  person_profiles: 'identified_only',
  capture_pageview: 'history_change',            // SPA route changes count as pageviews
  capture_pageleave: true,
  autocapture: false,                             // explicit events only; keeps volume predictable
  disable_session_recording: !config.public.posthog.replay,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: '[data-ph-mask]',
    blockSelector: 'img[src*="/uploads/"], [data-ph-block]',
  },
})
posthog.register({ brand, locale, is_pwa })      // super properties on every event
if (auth.user) posthog.identify(auth.user.id, buildPersonProps(auth.user, brand))
nuxtApp.provide('posthog', posthog)
```

`autocapture` is off on purpose. Clicks on every element would multiply event volume on a game
screen that redraws every few seconds and would bury the named events that matter.

Pure helpers live in `utils/posthog.ts` so they are unit-testable without a Nuxt runtime:
`buildPersonProps(user, brand)`, `buildSuperProps({ brand, locale, standalone })`,
`resolveReplayEnabled(raw)`.

### Reverse proxy (Nuxt `routeRules`)

```ts
'/ingest/static/**': { proxy: `${POSTHOG_ASSETS_PROXY_TARGET}/static/**` },
'/ingest/**':        { proxy: `${POSTHOG_PROXY_TARGET}/**` },
```

Build-time constants, same pattern as `API_PROXY_TARGET`, defaulting to the EU hosts. The browser
only ever talks to the app's own origin, so DNS-level and extension ad blockers do not see PostHog.

### Adapter `composables/useAnalytics.ts`

- `track(name, props)`: forwards to `$posthog.capture(name, props)` when PostHog is live, **then**
  the existing allowlist-and-queue path, unchanged. PostHog accepts any name; the DB path keeps
  its allowlist. A new event no longer silently vanishes just because a list was not updated.
- `identify(user)`: `posthog.identify(user.id, personProps)` plus the existing
  `POST /events/identify`. Replaces the duplicate `sendIdentify` in `store/auth.ts`.
- `reset()`: `posthog.reset()`, remove `wb_anon_id` and `wb_session_id`.

`store/auth.ts` calls `identify(user)` after `login`, `register`, `telegramLogin`, and `reset()`
in `logout` and `clearStoredUser`. The plugin handles the persisted-store case (page reload with a
user already hydrated).

### Defects fixed in passing

1. `games_lobby_view` is tracked in `pages/games/index.vue` but is in neither allowlist. Added to
   both.
2. `telegramLogin` never sends identify, so Telegram players are never stitched to their anonymous
   trail. Fixed by the shared `identify(user)`.
3. Logout keeps `wb_anon_id`. Fixed by `reset()`.

## Server (`apps/api`)

### `lib/posthog.ts`

Mirrors `lib/sentry.ts`:

- `initPostHog()` — reads `POSTHOG_KEY`, `POSTHOG_HOST`, `POSTHOG_BRAND`. Unset key logs one line
  and leaves every helper a no-op. Called from `index.ts` right after `initSentry()`.
- `captureEvent(userId, event, props?, opts?)` — resolves bot status from the cache, drops bots,
  adds `brand`, calls `client.capture`. Wrapped in try/catch; **never throws, never awaited by
  callers**.
- `setPersonProps(userId, props)` — `$set` for `user_registered`.
- `shutdownPostHog()` — `client.shutdown()` in the graceful shutdown path, after queues close,
  so the last batch flushes.

### Emission rule

Events are emitted **post-commit**, after the Prisma transaction resolves, never inside a
`$transaction` callback. A rolled-back write must not leave a phantom event.

### Event catalog — server

| event | hook | properties |
|---|---|---|
| `user_registered` | `AuthService.register`; `AuthService.telegramAuth` when the pre-upsert lookup finds no user | `signup_method`, `referred`; `$set` person props |
| `user_logged_in` | `AuthService.login`, `AuthService.telegramAuth` | `signup_method` |
| `deposit_submitted` | `WalletService.initiateDeposit`; `ZareCashCheckoutService` when it creates the Transaction row | `amount`, `method`, `gateway` (`manual` \| `zarecash`), `tx_id` |
| `deposit_approved` | `WalletService.approveDeposit` (covers manual review and ZareCash webhook) | `amount`, `method`, `gateway`, `hours_to_approve`, `is_first_deposit`, `tx_id` |
| `deposit_rejected` | `AdminService.reviewTransaction`, REJECTED + DEPOSIT branch | `amount`, `method`, `hours_to_decision`, `has_note`, `tx_id` |
| `withdrawal_requested` | `WalletService.requestWithdrawal` | `amount`, `method`, `tx_id` |
| `withdrawal_approved` | `AdminService.reviewTransaction`, APPROVED + WITHDRAWAL branch; `ZareCashService.settleApprovedWithdrawal` | `amount`, `method`, `gateway`, `hours_to_decision`, `tx_id` |
| `withdrawal_rejected` | `WalletService.rejectWithdrawal` | `amount`, `method`, `hours_to_decision`, `tx_id` |
| `game_joined` | `GameService.joinGame` | `game_id`, `template_id`, `ticket_price`, `cartelas`, `stake`, `spend_account` |
| `game_left` | `GameService.leaveGame` | `game_id`, `refund` |
| `game_finished` | `GameService.claimBingo` (winner path) and `endGameNoWinner` in `lib/game-engine.ts`, one event per distinct human entrant | `game_id`, `template_id`, `ticket_price`, `cartelas`, `stake`, `outcome` (`won` \| `lost` \| `no_winner`), `prize`, `net`, `duration_secs` |
| `game_refunded` | `GameService.cancelGame`, one per refunded player | `game_id`, `template_id`, `reason`, `refund` |
| `bonus_granted` | post-commit in the four owners of a `BonusService.grant` transaction: `WalletService.approveDeposit` (first-deposit and rule grants), `CampaignService` delivery, `CashbackService` disbursement, the admin adjust-balance route | `amount`, `source` (`FIRST_DEPOSIT` \| `DEPOSIT_RULE` \| `CAMPAIGN` \| `CASHBACK` \| `ADMIN`), `rule_id` |
| `account_status_changed` | `AccountStatusService.transition` when `result.changed` | `from`, `to`, `category`, `has_expiry` |
| `provider_game_launched` | existing emit site in `routes/game-provider/index.ts` | `provider_code`, `game_code` |

`hours_to_*` are computed from the Transaction's `createdAt` and now. `net` on `game_finished` is
`prize - stake`. Money is in ETB as a number; PostHog does numeric math on it.

`game_finished` fans out one event per player. A ten-player game emits ten events, which is the
point: "lost N games in a row" is a per-player fact, not a per-game one.

### Event catalog — client

Everything `track()` already sends, with the same names and props, plus `$pageview`,
`$pageleave`, and the replay stream. `join_click`, `game_view`, `lobby_view`,
`deposit_modal_opened`, `deposit_method_selected`, `deposit_amount_entered`,
`provider_game_view`, `provider_session_ended`, `hero_predictions_click`,
`lobby_predictions_click`, `games_lobby_view`.

## Backfill

`apps/api/scripts/posthog-backfill.ts`, run from `apps/api`:

```bash
pnpm posthog:backfill -- --since 2026-02-20 [--until 2026-09-06] [--dry-run]
```

- Pure mappers in `src/lib/posthog-backfill.ts` turn rows into `{ distinctId, event, properties,
  timestamp, uuid }`. The script only streams rows and batches.
- **Deterministic UUIDs** (uuid v5 over `source:rowId:event`) make the script idempotent: PostHog
  de-duplicates on event uuid, so re-running after a partial failure adds nothing twice.
- Client constructed with `historicalMigration: true` so the import bypasses real-time ingestion
  limits and is billed as an import.
- Bots and staff excluded at the source query (same predicate as `AnalyticsService`).
- Brand comes from `POSTHOG_BRAND`; each brand's deployment has its own database.

| source | events |
|---|---|
| `users` | `user_registered` @ `createdAt`, with `$set` person props |
| `transactions` DEPOSIT | `deposit_submitted` @ `createdAt`; `deposit_approved` / `deposit_rejected` @ `createdAt` + 1 s with `hours_to_*: null` (the table has no decision timestamp) |
| `transactions` WITHDRAWAL | `withdrawal_requested` @ `createdAt`; `withdrawal_approved` / `withdrawal_rejected` @ `createdAt` + 1 s with `hours_to_*: null` |
| `game_entries` grouped by (`gameId`, `userId`) | `game_joined` @ min `joinedAt` |
| `games` COMPLETED, joined to entries | `game_finished` per player @ `endedAt`; prize from the `PRIZE_WIN` transaction with `referenceId = gameId` |
| `games` CANCELLED, joined to `REFUND` transactions | `game_refunded` per player @ `endedAt` |
| `transactions` of type `FIRST_DEPOSIT_BONUS`, `CASHBACK_BONUS`, `CAMPAIGN_BONUS`, `ADMIN_BONUS_ADJUSTMENT` with `amount > 0` | `bonus_granted` @ `createdAt`, `source` derived from the type (`bonus_grants` carries no source) |
| `analytics_events` | same event name @ `createdAt`, distinct id `userId ?? anonId`; `identify` rows become `$create_alias` (user ← anon) |

Backfilled decision events carry `hours_to_*: null` and `backfilled: true`: `transactions` records when a
row was created, never when it was decided. Decision timing is a live-only metric; the runbook says so.

## Environment and deployment

| var | app | default | note |
|---|---|---|---|
| `NUXT_PUBLIC_POSTHOG_KEY` | web | `''` | empty = inert |
| `NUXT_PUBLIC_POSTHOG_HOST` | web | `/ingest` | proxied |
| `NUXT_PUBLIC_POSTHOG_UI_HOST` | web | `https://eu.posthog.com` | toolbar / replay links |
| `NUXT_PUBLIC_POSTHOG_REPLAY` | web | `true` | `false` turns replay off without a rebuild |
| `NUXT_PUBLIC_POSTHOG_BRAND` | web | `''` → falls back to brand short name | super property |
| `NUXT_POSTHOG_PROXY_TARGET` | web, build-time | `https://eu.i.posthog.com` | only for a US project |
| `NUXT_POSTHOG_ASSETS_PROXY_TARGET` | web, build-time | `https://eu-assets.i.posthog.com` | only for a US project |
| `POSTHOG_KEY` | api | `''` | empty = inert |
| `POSTHOG_HOST` | api | `https://eu.i.posthog.com` | direct, no proxy needed |
| `POSTHOG_BRAND` | api | `''` → falls back to `DEPLOYMENT_CODE` | on every server event |

Added to root `.env.example`, `apps/web/.env.example`, `apps/api/.env.example`, and passed
through in `docker-compose.yml`, `docker-compose.prod.yml`, and the four brand compose files.
`apps/web/Dockerfile` gains the two optional proxy build args. `CLAUDE.md` observability section
gets one line pointing at `docs/posthog.md`.

One PostHog project per environment. Both brands share a project and are split by the `brand`
property; a separate project per brand is one env var away if that changes.

## Privacy

- Session replay masks every input and text node marked `[data-ph-mask]`, and blocks receipt images
  (`/uploads/`). The deposit form, withdrawal form, login and register pages get `data-ph-mask` on
  the fields that show phone numbers or account numbers as text.
- No phone, name, account number or receipt URL is ever a property.
- PostHog's IP-based geolocation stays on (city-level, useful for "which region is leaving").

## Error handling

- Client: `$posthog` is `null` when unset; every use is guarded. `posthog-js` itself never throws
  into app code.
- Server: every helper is `try/catch` and returns `void`. A PostHog outage costs events, never a
  request. `captureEvent` is never awaited by a caller.
- Backfill: batches of 100, `await client.shutdown()` at the end, non-zero exit on any batch
  failure. Re-run to finish; the uuids make that safe.

## Testing

Vitest, following existing patterns (pure helpers tested directly, network mocked).

- `apps/web/utils/posthog.test.ts` — `buildPersonProps` omits phone and name, `buildSuperProps`,
  `resolveReplayEnabled` parses `'false'`/`'0'`.
- `apps/web/composables/useAnalytics.test.ts` — `track` calls the injected `capture` when present
  and still queues; no-ops PostHog when `$posthog` is `null`; `identify` hits both sinks; `reset`
  rotates the anon id.
- `apps/api/src/test/posthog.test.ts` — `captureEvent` is a no-op without `POSTHOG_KEY`; forwards
  to the mocked client with `brand`; drops bot users; swallows a throwing client.
- `apps/api/src/test/posthog-backfill.test.ts` — each mapper: correct event name, timestamp,
  deterministic uuid (same input → same uuid, different event → different uuid), bots excluded,
  `hours_to_approve` maths.
- Existing suites stay green per file (the api suite carries known environmental failures; compare
  per file, not by exit code).

## File map

| file | action | responsibility |
|---|---|---|
| `apps/web/package.json` | modify | add `posthog-js` |
| `apps/web/nuxt.config.ts` | modify | `runtimeConfig.public.posthog`, `/ingest` route rules |
| `apps/web/plugins/02.posthog.client.ts` | create | env-gated init, super props, identify-on-hydrate, provide |
| `apps/web/utils/posthog.ts` (+ test) | create | pure helpers |
| `apps/web/composables/useAnalytics.ts` (+ test) | modify | adapter, `identify(user)`, `reset()`, allowlist fix |
| `apps/web/store/auth.ts` | modify | call `identify` / `reset`, drop `sendIdentify` |
| `apps/web/components/DepositModal.vue`, withdrawal + auth pages | modify | `data-ph-mask` on sensitive text |
| `apps/web/Dockerfile` | modify | optional proxy build args |
| `apps/web/.env.example` | modify | new vars |
| `apps/api/package.json` | modify | add `posthog-node`, `uuid`; `posthog:backfill` script |
| `apps/api/src/lib/posthog.ts` (+ test) | create | init, capture, person set, bot cache, shutdown |
| `apps/api/src/index.ts` | modify | init after Sentry, shutdown after queues |
| `apps/api/src/services/auth.service.ts` | modify | `user_registered`, `user_logged_in` |
| `apps/api/src/services/wallet.service.ts` | modify | deposit + withdrawal events |
| `apps/api/src/services/zarecash-checkout.service.ts` | modify | `deposit_submitted` |
| `apps/api/src/services/admin.service.ts` | modify | `deposit_rejected`, `withdrawal_approved` |
| `apps/api/src/services/zarecash.service.ts` | modify | `withdrawal_approved` on settle |
| `apps/api/src/services/game.service.ts` | modify | join / leave / finished / refunded |
| `apps/api/src/lib/game-engine.ts` | modify | `game_finished` no-winner path |
| `apps/api/src/services/event.service.ts` | modify | `games_lobby_view` allowlist |
| `apps/api/src/services/player-crm/campaign.service.ts`, `apps/api/src/services/cashback.service.ts`, `apps/api/src/routes/admin/index.ts` | modify | `bonus_granted` post-commit (deposit-side grants are emitted from `approveDeposit`) |
| `apps/api/src/services/account-status.service.ts` | modify | `account_status_changed` |
| `apps/api/src/routes/game-provider/index.ts` | modify | `provider_game_launched` |
| `apps/api/src/lib/posthog-backfill.ts` (+ test) | create | pure row → event mappers |
| `apps/api/scripts/posthog-backfill.ts` | create | CLI: stream rows, batch, flush |
| `apps/api/.env.example`, root `.env.example` | modify | new vars |
| `docker-compose*.yml` (6 files) | modify | env passthrough |
| `docs/posthog.md` | create | runbook + churn dashboard recipe |
| `CLAUDE.md` | modify | one-line pointer |

## Churn diagnosis — the six insights (runbook content)

Built in the PostHog UI once data lands; the runbook gives exact event and property names.

1. **Lifecycle** on `game_joined`, weekly: new vs returning vs resurrecting vs dormant. This is the
   first chart to look at. It says whether decline is acquisition or retention.
2. **Retention**: `user_registered` → `game_joined`, weekly, 8 weeks. Compare cohorts against the
   admin page's matrix as a sanity check.
3. **Funnel**: `$pageview` → `user_registered` → `deposit_approved` → `game_joined` → second
   `game_joined`, 7-day window, broken down by `brand` and `signup_method`.
4. **Trend**: `deposit_rejected` ÷ `deposit_submitted`, broken down by `method`; median
   `hours_to_approve` and `hours_to_decision`. Slow or failed money is the usual first suspect.
5. **Cohort** "lost and left": performed `game_finished` with `outcome = lost` ≥ 3 times in the last
   7 days and did not perform `game_joined` in the last 7 days. Watch its size over time; open its
   session replays.
6. **Replays**: filter to persons with `deposit_approved` and no `game_joined` in 24 h. Watch ten.

## Key decisions

- **Add, do not replace.** The June pipeline stays and keeps feeding the admin page. Retiring it is
  a later, evidence-based call.
- **PostHog Cloud EU.** No infra; the free tier covers current volume with room.
- **Adapter at `track()`.** Zero call-site churn; one place to reason about both sinks.
- **Server events at the service layer, post-commit.** Money and outcomes are server truth; the
  browser never reports them.
- **Deterministic uuids in the backfill.** Idempotency without a bookkeeping table.
- **Replay on, masked, one env var to turn off.**
- **Autocapture off.** Named events only; volume stays predictable on a screen that redraws
  constantly.
- **One project, `brand` property.** Splitting per brand later is an env change, not code.
