# Game Retention Insights — Design Spec

**Status:** Approved, ready for implementation.
**Date:** 2026-06-14
**Builds on:** Layer 1 analytics (`docs/superpowers/plans/2026-06-12-admin-analytics-layer1.md`), Layer 2 behavioral events (`docs/superpowers/specs/2026-06-13-admin-analytics-layer2-design.md`).

## Goal

Tell the admin which games (both bingo templates and third-party provider games) increase a new player's likelihood of coming back — and which decrease it. Surface this as a ranked per-game lift table on the existing `/analytics` page, plus a handful of supporting scorecard columns that explain *why*.

Also add lightweight provider-game instrumentation (game view, launch, session close) so future funnels have data for the browse→play path currently invisible.

---

## Problem statement

Two questions:
1. **Which game is a player's first play, and does that game make them return or quit?** This is the primary "driving away vs retaining" signal for new users.
2. **Across the session lifetime, which games are sticky and which are not?** This is the secondary signal for established players.

Provider (third-party/GASea slot) games are currently invisible above the bet level — we know bets happened, but not when a player *viewed*, *launched*, or *quit the session*. Tier 2 adds those data points.

---

## Data model

### Unified "play" abstraction (SQL, not a new table)

Not stored anywhere — computed at query time from two existing sources:

| Family | Source | Play grain | game_key | label |
|--------|--------|------------|----------|-------|
| Bingo | `game_entries JOIN games JOIN game_templates` | 1 row = 1 `GameEntry` | `bingo:<templateId>` | `GameTemplate.title` |
| Provider | `third_party_transactions` where `amount < 0` (bet debit), grouped by `(userId, gameCode, day)` | 1 row = all bets by a user on a game on one calendar day | `provider:<gameCode>` | `ProviderGame.gameName` |

Bot exclusion: `users.passwordHash != 'BOT_ACCOUNT'` applied on every query.

### New `analytics_events` entries (Tier 2)

Extends the existing `analytics_events` table (added in Layer 2). New event names added to the allowlist:

| name | source | key props |
|------|--------|-----------|
| `provider_game_view` | frontend | `gameCode`, `providerCode` |
| `provider_game_launched` | backend (`POST /providers/:code/games/:gameCode/launch`) | `gameCode`, `providerCode`, `balanceBefore` |
| `provider_session_ended` | frontend (visibilitychange + beforeunload) | `gameCode`, `providerCode`, `sessionDurationSecs`, `balanceDelta` |

`balanceBefore` on launch and `balanceDelta` on session end give us the "ran out of money" signal (key churn driver) without trusting frontend for absolute amounts.

---

## Metrics

### Headline: New-Player Return Lift

For each game X (bingo or provider), over a selected date window:

1. **Cohort(X)** = all non-bot users whose first-ever play (across both families) was game X in the window.
2. **return_rate(X)** = % of Cohort(X) who played any game again on a *later calendar day* within 7 days.
3. **baseline** = overall return rate for all new players in the window (regardless of first game).
4. **lift(X) = return_rate(X) − baseline**. Positive = retaining, negative = driving away.

Guard: games with `cohort_size < 10` shown with a "⚠ low sample" badge, not filtered out.

### Scorecard columns (supporting the lift table)

| Column | Definition | Derivation |
|--------|-----------|------------|
| `first_game_cohort` | # new players whose first game was X | Cohort(X) size |
| `return_rate_7d` | % returned within 7 days | return_rate(X) |
| `lift` | return_rate(X) − baseline | see above |
| `next_day_return` | % returned *next calendar day* | Stricter signal |
| `replay_rate` | % who played game X again (stickiness) | Same-game return within window |
| `avg_net_pnl` | Average net ETB won/lost per play | Bingo: prize − ticket. Provider: `sum(winAmount − abs(betAmount))` per session. Negative = player lost |
| `sessions_per_player` | Avg plays by a player who tried this game | Broad stickiness |

### Provider-specific columns (only shown for provider rows)

| Column | Definition |
|--------|-----------|
| `view_to_launch_pct` | % of `provider_game_view` events that led to a `provider_game_launched` (once Tier 2 data accumulates) |
| `launch_to_bet_pct` | % of launched sessions with at least one bet debit |
| `pct_sessions_broke` | % of sessions where player balance dropped to ≤ 0 at exit |

---

## Architecture

```
apps/api                                           apps/admin
────────                                           ──────────
AnalyticsService
  + getGameRetentionScorecard(from, to)     →     useAdminApi.getGameRetentionScorecard()
  + getProviderBrowseFunnel(from, to)       →     useAdminApi.getProviderBrowseFunnel()
  (raw SQL, same conventions as Layer 1)

GET /admin/analytics/game-retention               analytics.vue
GET /admin/analytics/provider-browse-funnel         new "Game Retention" section

EventService.ALLOWED_EVENTS + 3 new names
POST /events  (existing, just updates allowlist)

Provider launch route (existing)
  + fire `provider_game_launched` event
  + attach balanceBefore from wallet

apps/web
  play/[providerCode]/[gameCode].vue
    + track provider_game_view on mount
    + track provider_session_ended on visibilitychange/beforeunload
```

---

## Admin UI

New section on `/analytics` page between the deposit funnel and retention matrix, titled **"Which games retain players?"**

### Sub-section A: Scorecard table

A sortable table. Default sort: `lift` descending (best-retaining game first).

Columns: Game name | Type (Bingo / Provider) | First-game cohort | Return rate 7d | **Lift ↑/↓** | Next-day return | Replay rate | Avg net P&L | Low-sample badge

Color coding:
- Lift > +5% → green row accent
- Lift < −5% → red row accent
- −5% ≤ Lift ≤ +5% → neutral

Date range selector reuses existing range picker; applies to all sub-sections.

### Sub-section B: Provider browse funnel

Only shown once Tier 2 events accumulate. Stages: `viewed` → `launched` → `first bet` → `returned 7d`. Same funnel bar component as deposit funnel.

### Sub-section C: "Balance at exit" histogram

For provider games: pie chart of sessions by exit-balance bucket (`broke`, `< initial`, `> initial`). Shows whether players quitting after losing all money correlates with the low-lift games.

---

## Implementation scope

### Tier 1 (all from existing data, no new instrumentation)

1. `AnalyticsService.getGameRetentionScorecard(from, to)` — raw SQL joining both play families, computing all scorecard columns.
2. `GET /admin/analytics/game-retention` — admin-only endpoint, same auth as other analytics routes.
3. `useAdminApi.getGameRetentionScorecard()` typed method.
4. Analytics page — new "Game Retention" section with sortable table + color coding.

### Tier 2 (new provider instrumentation)

5. Add `provider_game_view`, `provider_game_launched`, `provider_session_ended` to `EventService.ALLOWED_EVENTS`.
6. `apps/api/src/routes/game-provider/index.ts` — fire `provider_game_launched` with `balanceBefore` in the launch handler (after JWT verified).
7. `apps/web/pages/play/[providerCode]/[gameCode].vue` — on mount: `track('provider_game_view', {...})`. On launch success: `track('provider_game_launched', {...})`. On visibilitychange hidden / beforeunload: `track('provider_session_ended', { sessionDurationSecs, balanceDelta })`.
8. `AnalyticsService.getProviderBrowseFunnel(from, to)` — stages from `analytics_events`.
9. `GET /admin/analytics/provider-browse-funnel` endpoint.
10. Analytics page — provider browse funnel sub-section + balance-at-exit pie.

---

## Out of scope

- Push/email nudges based on churn signal (Layer 3)
- Per-player drill-down (click a game to see which players churned)
- Real-time / live updates
- Bingo-specific in-game events (cartela hover, ball-call animations)

---

## Key decisions

- **Session grain = user+game+calendar-day** for provider plays. Simple, deterministic, comparable to one bingo entry.
- **Churn window = 7 days** for the return-rate metric (daily product, 7-day horizon is actionable).
- **balanceDelta on session end** is sent by the frontend (approximate, since balances can change from other sources in parallel) and flagged in the DB as untrustworthy for exact amounts — used only for the "broke" bucket heuristic, not for P&L. Authoritative P&L always comes from `third_party_transactions`.
- **Low-sample guard = 10 new-player cohort**. Games below this still appear but with a warning badge.
- **Tier 2 data accumulates over time** — provider funnel sub-section shows "not enough data yet" until there are at least 50 `provider_game_view` events in the selected window.

## File map

| File | Action |
|------|--------|
| `apps/api/src/services/event.service.ts` | Add 3 new event names to `ALLOWED_EVENTS` |
| `apps/api/src/services/analytics.service.ts` | Add `getGameRetentionScorecard`, `getProviderBrowseFunnel` |
| `apps/api/src/routes/admin/analytics.ts` | Add `GET /game-retention`, `GET /provider-browse-funnel` |
| `apps/api/src/routes/game-provider/index.ts` | Fire `provider_game_launched` in launch handler |
| `apps/admin/composables/useAdminApi.ts` | Add typed client methods for 2 new endpoints |
| `apps/admin/pages/analytics.vue` | New "Game Retention" section with table + provider funnel + balance chart |
| `apps/web/pages/play/[providerCode]/[gameCode].vue` | Track `provider_game_view`, `provider_game_launched`, `provider_session_ended` |
| `apps/api/src/test/game-retention.service.test.ts` | Unit tests for scorecard shaping helpers |
