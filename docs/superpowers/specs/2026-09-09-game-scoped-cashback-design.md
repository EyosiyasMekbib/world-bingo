# Game-scoped cashback

**Date:** 2026-09-09
**Status:** approved
**Scope:** let a cashback promotion target specific games instead of a
player's site-wide net loss. Everything else about cashback (threshold,
refund type/value, frequency window, grant/ledger/expiry via `BonusGrant`,
the hourly checker worker) is unchanged and reused as-is.

## Problem

`CashbackPromotion` (schema.prisma:451) and `CashbackService.checkAndDisburse`
(cashback.service.ts:118) already compute net loss (`GAME_ENTRY` minus
`PRIZE_WIN`) per player per window and disburse a `BonusGrant` when it clears
`lossThreshold`. But the loss sum is global — every bingo game and every
third-party provider game the player touched in the window, combined. There
is no way to say "cashback only for losses on Quick 10 ETB" or "only for
losses on this slot title."

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope unit | Bingo `GameTemplate` id, and/or third-party `ProviderGame` (provider+gameCode) | These are the two units admins already manage elsewhere (game-templates page, provider games page). No new concept to invent. |
| Storage | Two array columns on `CashbackPromotion`: `templateIds String[]`, `providerGameKeys String[]` | Avoids a join table for a filter that's read once an hour and written rarely. Native Postgres arrays, same pattern as `Game.calledBalls`. |
| `providerGameKeys` format | `"<providerId>:<gameCode>"` | `gameCode` alone is only unique *within* a provider (schema.prisma:698 comment); a second provider could reuse a code for a different game. |
| Empty-scope meaning | Both arrays empty = unscoped = today's site-wide behavior | Zero migration risk for the existing promotions (there are none yet, but the semantics stay backward compatible) and admins keep the option of a site-wide promotion. |
| Query strategy | Unscoped promotions keep the exact existing `groupBy` code path; scoped promotions take a new raw-SQL branch | The 6 existing tests in `cashback.service.test.ts` exercise the unscoped path and must not change behavior. Only the new branch is new surface area. |
| Combining bingo + provider losses | Summed together per user before applying `lossThreshold` | A promotion can scope to a mix of both; "losses across the games you picked" is one number, matching how the threshold already reads in the admin UI ("Lose X ETB → get Y back"). |
| Bot filtering | Same `username LIKE 'bot_t%'` exclusion, applied uniformly | Provider games aren't bot-played today, but there's no reason to special-case it — same filter, same call site. |
| Admin picker | Checkbox list of game templates (`GET /admin/game-templates`, exists) + a provider-game search reusing `GET /admin/providers/:code/games` (exists), scoped to the primary provider | Both endpoints already exist and already page/search. No new list endpoints needed. |

## Data model

```prisma
model CashbackPromotion {
  // ...existing fields unchanged...
  templateIds       String[] @default([])
  providerGameKeys  String[] @default([])
}
```

Additive, nullable-by-default-empty-array migration. No backfill needed —
no rows exist yet.

## Service logic

`CashbackService.checkAndDisburse(promotionId, periodStart, periodEnd)`:

1. Load the promotion. If `templateIds` and `providerGameKeys` are both
   empty → unchanged: today's two `prisma.transaction.groupBy` calls
   (`GAME_ENTRY` sum, `PRIZE_WIN` sum), same as cashback.service.ts:127-146.
2. Otherwise → one raw SQL query, `UNION ALL` of two arms, each optional
   depending on which array is non-empty:
   - **Bingo arm:** `transactions t JOIN games g ON g.id = t."referenceId"`,
     `WHERE g."templateId" = ANY(templateIds) AND t.type IN (GAME_ENTRY,
     PRIZE_WIN) AND t.status = APPROVED AND t."createdAt" BETWEEN
     periodStart AND periodEnd`, net = `SUM(GAME_ENTRY) - SUM(PRIZE_WIN)`
     per `userId`.
   - **Provider arm:** `third_party_transactions`, filtered by a
     `(providerId, gameCode)` VALUES-list join built from
     `providerGameKeys`, `WHERE status = COMPLETED AND "createdAt" BETWEEN
     ...`, net = `-SUM(amount)` per `userId` (`amount` is already net
     credit/debit, matching the sign convention used in
     analytics.service.ts:400).
   - Outer query sums both arms per user, filters bots, and yields the same
     `{ userId, netLoss }` shape the existing per-entry loop already
     consumes — so `checkAndDisburse`'s disbursement loop (idempotency
     check, `BonusService.grant`, `Transaction`/`CashbackDisbursement`
     rows, notification, PostHog event) is untouched.
3. `getCurrentPeriod`, threshold comparison, refund math, disbursement,
   idempotency (`@@unique([promotionId, userId, periodStart])`) — all
   unchanged.

## Admin UI

`apps/admin/pages/cashback/index.vue`:

- Create modal gains a "Games" section: a checkbox list of active
  `GameTemplate`s, and a searchable checkbox list of `ProviderGame`s for the
  primary provider.
- Leaving both empty creates a site-wide promotion, same as today.
- `describePromo()` grows a game-list clause, e.g. "Lose 500 ETB on Quick 10
  ETB, Quick 20 ETB → get 10% back · weekly" (falls back to today's text
  when unscoped).
- `CashbackService.listPromotions()` resolves `templateIds` /
  `providerGameKeys` into display names (`title` / `gameName`) so the admin
  UI doesn't do a second round-trip.

## Out of scope

- Editing a promotion's game scope after creation (matches the existing
  rule for `BonusRule.segmentId` — create a new promotion instead).
- Any change to `BonusGrant`, `BonusService`, the hourly worker's schedule,
  or the player-facing `CashbackBanner.vue` (still just reports "you have a
  cashback bonus," not which games earned it).

## Testing

- New `cashback.service.test.ts` cases: template-scoped promotion only
  counts losses on games from that template; provider-scoped promotion only
  counts losses on that provider game; a promotion scoped to both sums
  correctly; a loss on an out-of-scope game does not count; unscoped
  behavior is byte-identical to today (regression guard).
