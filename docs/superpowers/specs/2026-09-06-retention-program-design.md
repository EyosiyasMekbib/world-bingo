# Retention Program — Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-09-06
**Builds on:** PostHog analytics (`docs/superpowers/specs/2026-09-06-posthog-product-analytics-design.md`,
runbook `docs/posthog.md`), player CRM (`docs/superpowers/specs/2026-08-12-player-crm-design.md`),
observability (`docs/superpowers/specs/2026-06-26-observability-and-devops-design.md`).

## Goal

Maximize player retention. Three projects, in this order, because each one makes the next
measurable:

1. **Stop forced logouts.** The largest measured leak.
2. **Retention instrumentation and error logging.** Today a crash in the player app is
   invisible and a lost session is unattributed.
3. **In-app re-engagement.** Make a return visit worth something.

## What the live data says

PostHog project 267450, 2026-09-06 15:30–17:00 UTC. 238 sessions, 174 people. First data ever
collected; no history, so this is a snapshot, not a trend.

| Signal | Value |
|---|---|
| Repeat logins by the same person | 131, from 90 identified players |
| Repeat logins within 5 minutes of that person's last activity | 124 of 131 |
| Page they were on before re-logging in | `/auth/login` in 112 cases |
| Heaviest player | 16 logins in 90 minutes, 31 game launches, 3 deposits |
| Sessions that START on the login page | 71 of 238; 56 of those people were already known |
| Casino launches vs bingo joins | 355 vs 1 |
| Keno (game 214) | 74 launches, median session 22 s, 88% under a minute, page reloaded 2.8×/session |
| Deposits | 54 submitted, 37 approved in ~3 min, 18 abandoned on the hosted checkout page |

API metrics since the last restart (about 4.7 hours): **194 refresh attempts — 125 succeeded,
64 returned 401, 4 returned 500.** A third of all refreshes end the session. Also 245 failed
logins against 167 successes, which is the fingerprint of people retyping a password all day.
Rate limiting is not yet a driver (9 total 429s) but stays a risk behind carrier NAT.

Web-app error reporting does not exist: no `vue:error` hook, no `window.onerror`, no
unhandled-rejection handler. GlitchTip is live and the API has 53 `reportError` sites, so the
gap is the browser only.

---

# Project 1 — Stop forced logouts

## Root cause

Access tokens live 15 minutes (`apps/api/src/index.ts:129`). Refresh tokens rotate and the old
row is **deleted** in the same transaction (`apps/api/src/services/auth.service.ts`). The web
store has no single-flight guard, and the lobby issues several authenticated calls at once.
When the access token expires they 401 together, each calls `refresh()` with the same token,
the first wins, and every loser gets `Invalid refresh token` → `logout()`.

Four independent triggers, all ending in a login screen:

1. **Concurrent refresh.** The race above. Explains the 64 × 401.
2. **Concurrent rotation crash.** Two callers reaching `prisma.$transaction([delete, create])`
   with the same row: the loser's `delete` throws `P2025`, surfacing as 500. Explains the 4 × 500.
3. **Transient failure treated as fatal.** `refresh()`'s `catch` clears the session for *any*
   error — dropped mobile connection, 429, 502 — not just an invalid token.
4. **Per-IP rate limit.** `/auth/refresh` allows 20/min/IP and the global limit is 100/min/IP.
   Ethiopian carriers put many players behind one address.

## Design

**Schema.** `RefreshToken` gains `rotatedAt DateTime?` and `replacedByHash String?`. A rotated
row is kept, not deleted, and pruned once older than 5 minutes by the existing cleanup pass.
One live row per device is unchanged; the table gains at most a few short-lived rows.

**Server — `AuthService.refreshToken`.**

- Claim atomically: `updateMany({ where: { tokenHash, rotatedAt: null }, data: { rotatedAt: now, replacedByHash } })`.
- `count === 1` → the caller owns the rotation: create the new row, return the new token.
- `count === 0` and the row's `rotatedAt` is within **60 s** → a concurrent caller from the same
  device. Issue a *separate* fresh token for the same user. Both callers leave with a working
  session, and neither crashes.
- `count === 0` and outside the window → reuse of a retired token. Reject with
  `401 { code: 'refresh_token_invalid' }`.
- Expired → `401 { code: 'refresh_token_expired' }`.
- No path throws `P2025`; the 500s disappear.
- Metric `wb_auth_refresh_total{outcome}` with outcomes `rotated | grace | invalid | expired | error`.

**Server — rate limits.**

- `/auth/refresh`: keyed by the **refresh token hash**, not the IP. A device gets its own budget.
- Global limiter: `keyGenerator` returns `user:<id>` for authenticated requests and falls back
  to the IP for anonymous ones, so one carrier IP no longer shares a single 100/min budget.

**Client — `apps/web/store/auth.ts`.**

- **Single-flight.** A module-level `refreshPromise`; every caller awaits the same promise.
  Shared by `apiFetch`, the socket `auth` callback (`composables/useSocket.ts`) and
  `middleware/auth.global.ts`.
- **Clear the session only on a definitive code** (`refresh_token_invalid` /
  `refresh_token_expired`). Network errors, 429 and 5xx leave the session intact and rethrow the
  original error so the caller can retry or show its own state.
- **Proactive refresh.** Decode the access token's `exp` once; refresh when under 2 minutes
  remain, before the request burst that currently triggers the race. `useSocket` already does
  this with its own margin and switches to the shared helper.
- **Retry once.** After a successful refresh, `apiFetch` replays the original request (it does
  today; the behaviour is preserved and made explicit).

**Events** (feeding project 2): `session_expired { reason }` when the client actually clears a
session, and `session_refresh_failed { status, transient: true }` when it survives one.

**Out of scope.** What the persisted auth cookie contains, and its size (~2.4 KB, inside the
4 KB limit). Moving tokens out of the cookie is a separate decision — see
`docs/superpowers/specs/2026-09-06-posthog-product-analytics-design.md` and the proxy note.

## Tests

- API: two concurrent refreshes with the same token both succeed and return different tokens;
  reuse after 60 s returns `refresh_token_invalid`; an expired token returns
  `refresh_token_expired`; no 500 on a concurrent claim.
- Web: `refresh()` called five times concurrently issues one network request; a 502 or a network
  error leaves `accessToken`/`user` untouched; a `refresh_token_invalid` clears them and emits
  `session_expired`; proactive refresh fires under the 2-minute margin.

---

# Project 2 — Retention instrumentation and error logging

## 2a. Web error capture (the gap)

New `apps/web/plugins/03.errors.client.ts`:

- `nuxtApp.hook('vue:error')`, `window.addEventListener('unhandledrejection')`, and
  `window.onerror`.
- Each report goes to **Sentry/GlitchTip** (existing DSN) **and** to PostHog as `$exception`,
  so the error is linked to the session replay and watchable.
- `posthog-js` gets `capture_exceptions: true` for what the SDK catches natively.
- Messages truncated to 300 chars; stack frames keep file and line, never values.
- Fully inert when both DSN and PostHog key are empty.

## 2b. API error visibility

- The global error handler reports any unhandled 5xx through `reportError` with the **route
  template** and request id (never bodies or params).
- New metric `wb_http_errors_total{route,status_class}`, so a spike is visible in Grafana
  without log search.
- `/auth/refresh` outcomes covered by `wb_auth_refresh_total` from project 1.

## 2c. Retention events

| Event | Source | Properties | Answers |
|---|---|---|---|
| `session_expired` | web | `reason` | Is the logout bleed fixed |
| `session_refresh_failed` | web | `status`, `transient` | Refresh trouble that did *not* log out |
| `api_error` | web | `route`, `status`, `transient` | Which endpoint fails players client-side |
| `socket_disconnected` | web | `reason` | Live-game reliability |
| `socket_reconnected` | web | `attempts`, `downtime_secs` | How long players sit disconnected |
| `provider_launch_failed` | api | `provider_code`, `game_code`, `reason` | Casino launches that never opened |
| `game_cancelled_for_player` | api | `reason`, `waited_secs`, `template_id` | Why bingo never starts for a joiner |
| `insufficient_funds` | api | `context`, `shortfall_bucket` | Played until broke — the classic churn driver |
| `deposit_checkout_abandoned` | web | `method`, `seconds_on_page` | The 18 of 54 who never returned from ZareCash |
| `$exception` | web | SDK shape | Crashes, with replay attached |
| `$web_vitals` | web (SDK) | LCP/CLS/INP/FCP | Slow loads on Android mobile data |

Server-side additions to existing emitters:

- `withdrawal_paid { hours_to_pay }` — payout speed is a trust signal.
- `wallet_balance_after_play { bucket }` on `game_finished` / `provider_session_ended` —
  makes "played until broke" queryable without a join.
- `first_play_after_deposit_secs` on the first play following an approved deposit.

Also fixed here: **`provider_game_launched` currently fires even when the launch URL is
invalid** (`routes/game-provider/index.ts`). It gains `ok: boolean`, and a failed launch emits
`provider_launch_failed` instead. Without this the casino funnel counts launches that never
opened.

## 2d. Super-property ordering fix

18% of browser events arrive with no `brand`, `locale` or `is_pwa`. `posthog.init` fires the
first `$pageview` synchronously on a full page load, before `register()` runs. Move
`register()` and the boot-time `identify()` into `posthog.init`'s `loaded` callback, which
posthog-js runs *before* that first pageview. Also guard the identify with
`get_distinct_id() !== user.id`, which removes a redundant `$set` on every load.

## 2e. Dashboards and alerts

Two saved insights beyond the six already in `docs/posthog.md`:

- **Session health** — `session_expired` per 100 sessions, `api_error` rate by route, socket
  downtime, `$exception` count. This is the tile to watch after project 1 ships.
- **First session** — for people whose first-ever event is in the window: registered → deposit
  opened → approved → played, with drop-off.

Alerts (Alertmanager, existing placeholder route): refresh failure ratio above 5% over 15 min;
`$exception` volume above baseline; provider launch failure ratio above 2%.

## Privacy

Unchanged rules. No phone, username, names, account numbers, tokens, receipt URLs or note text
in any event, person property, error report or breadcrumb. `shortfall_bucket` and
`wallet_balance_after_play` are buckets, never exact balances.

---

# Project 3 — In-app re-engagement

**The constraint, stated plainly:** in-app only means a churning player is reachable **only when
they choose to open the app**. None of this pulls anyone back. It makes the return worth
something and stops the next drop-off. Outbound reach (Telegram, push) stays an open decision;
`TELEGRAM_BOT_TOKEN` is already configured if that changes.

## 3a. Return streak

- New `PlayerStreak { userId, currentDays, longestDays, lastCountedDate, updatedAt }`.
- A day counts on the player's first qualifying action (a play, not a page view). Consecutive
  calendar days in the brand's timezone.
- Reward on days 2, 3, 5, 7, then weekly: a small bonus granted through `BonusService.grant`
  inside the same transaction as the streak update, with `source: 'STREAK'`, so the wallet
  invariant and audit trail hold.
- Amounts come from `SiteSetting` keys so they are tunable without a deploy; all zero by
  default, which makes the feature inert until configured.
- Lobby surface: a compact streak chip showing the current run and what tomorrow is worth.
- Events: `streak_advanced { days, reward }`, `streak_broken { previous_days }`.

## 3b. Standing win-back rule

- A daily BullMQ pass over `PlayerMetrics.daysSinceLastPlay` between 3 and 14, excluding bots,
  staff and suspended accounts.
- For each match: grant a small bonus and file a `CAMPAIGN_MESSAGE` notification, so it is
  waiting in the bell on their next open.
- Reuses the existing segment compiler, campaign approval flow and per-player caps — no new
  money path. Idempotent per player per period via the existing `BonusGrant` unique index.
- Off by default behind a `SiteSetting` flag.
- Events: `winback_granted { days_idle, amount }`, and the return is measured as
  `game_joined` / `provider_game_launched` within 7 days.

## 3c. First-session rescue

The biggest leak after logouts: people who register and never deposit or play. On a returning
visit where the player has no play in their history, a single dismissible prompt points at the
smallest ticket price and the streak reward. Shown at most once per player.

Events: `rescue_prompt_shown`, `rescue_prompt_clicked`, `rescue_prompt_dismissed`.

## What is deliberately not here

- Outbound messaging of any kind.
- Loss-chasing mechanics: no "deposit again to recover" prompt after a loss. This is a gambling
  product; the win-back rule is capped, periodic and off by default for the same reason.
- Any change to house edge, prize maths or bonus wagering rules.

---

## Sequencing and file map

| Project | Key files |
|---|---|
| 1 | `apps/api/prisma/schema.prisma`, `services/auth.service.ts`, `routes/auth/index.ts`, `src/index.ts` (limiter), `apps/web/store/auth.ts`, `composables/useSocket.ts`, `middleware/auth.global.ts` |
| 2 | `apps/web/plugins/03.errors.client.ts` (new), `plugins/02.posthog.client.ts`, `composables/useAnalytics.ts`, `apps/api/src/index.ts`, `lib/metrics.ts`, `routes/game-provider/index.ts`, `services/game.service.ts`, `services/wallet.service.ts`, `docs/posthog.md` |
| 3 | `apps/api/prisma/schema.prisma` (`PlayerStreak`), `services/streak.service.ts` (new), `services/player-crm/winback.service.ts` (new), `workers/`, `apps/web/pages/index.vue`, `components/` |

Project 1 ships alone and is measured for a week before project 3 is judged, because a streak
counter cannot be evaluated while sessions are still being lost.

## Key decisions

- **Grace window over dropping rotation.** Reuse detection is worth keeping in a wallet app; a
  60 s window closes the race without weakening it.
- **Logout only on a definitive server code.** Any other failure is transient until proven
  otherwise. This single rule removes most of the observed bleed.
- **Rate limit by user when authenticated.** Carrier NAT makes per-IP limits a shared-fate
  outage.
- **Errors go to both sinks.** GlitchTip for triage and grouping, PostHog for the replay link.
- **Every re-engagement reward is off by default** and tunable through `SiteSetting`, so the
  money path can be reviewed before a single birr moves.
