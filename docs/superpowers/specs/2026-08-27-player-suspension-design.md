# Player suspension

**Date:** 2026-08-27
**Status:** approved
**Scope:** manual suspension, done properly. Automatic fraud *detection* is a
separate subsystem and gets its own spec; it will plug into the service defined
here rather than writing account status itself.

## Problem

Containment today is a single boolean, `User.isActive`, and almost nothing about
it works the way the name implies.

It carries no reason, no actor, no timestamp, and no expiry — so nobody can
answer "why is this account frozen, who froze it, and when does it come back"
without asking the person who did it. It blocks exactly one thing, withdrawals
(`wallet.service.ts:295`); a frozen account can still log in, deposit, buy
cartelas and play. And the only way to set it is a CLI script run by hand on the
server (`apps/api/scripts/freeze-player.ts`), whose own header records that
operators previously ran raw `UPDATE users SET "isActive" = false`, which
silently staled the CRM liveness rollup because Prisma's `@updatedAt` never
fired.

There is no admin UI, no API route, and no audit trail.

## What `isActive` actually is

Worth stating before replacing it: it is not a player-fraud flag. It is the
account-enabled flag for **every** account, staff included — clerk creation sets
it (`admin/index.ts:313`) and a staff login path checks it
(`campaign.service.ts:378`). Two of its readers are **raw SQL**
(`player-metrics.service.ts:41,91`), where nothing warns you at compile time if
the column changes.

Any replacement therefore has to cover staff accounts too, and has to treat
those two raw queries as first-class call sites.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Levels | `ACTIVE` / `RESTRICTED` / `SUSPENDED` | Fraud work needs a middle state. A hard lockout on suspicion makes the player unreachable exactly when you need them to explain themselves; `RESTRICTED` holds the money while leaving support chat open. |
| Applies to | Every account, staff included | `isActive` already did. A disabled clerk is `SUSPENDED`, which is what disabling a clerk should mean. `RESTRICTED` is simply never used for staff. |
| Source of truth | `User.accountStatus`, and nothing else | No mirror, no dual write. `isActive` stops being read or written in the same release that introduces `accountStatus`. |
| Dropping `isActive` | One release later | After release 1 the column is dead weight, so the flaw is already gone. Dropping it immediately would probably survive — Dokploy stops the old container before starting the new one, so old code never meets the new schema — but a rollback would meet it, and raw SQL offers no compile-time net. |
| Funds on suspension | Freeze in place | Nothing forfeited, nothing moved. A pending withdrawal stays `PENDING_REVIEW` and becomes un-approvable; it is deliberately NOT auto-refunded, because the payout may already be in flight at ZareCash and re-crediting is the double-pay this codebase works hard to prevent. |
| In-flight games | Play out | The stake is already spent and the engine is server-authoritative. Yanking a player mid-game buys nothing and risks the game state. |
| Permissions | Clerk restricts; admin suspends and reinstates | Containment should not wait for an admin. Lifting anything should. Mirrors the separation of duties already used for transaction review (`reviewedById`). |
| Enforcement point | `authenticate` decorator + one preHandler | Status is checked once, centrally, rather than sprinkled through routes. |
| Upstream mirroring | Existing `ZareCashService.syncPlayerFreeze` | Already built, already best-effort, already tested. The new service becomes its call site. |

## Data model

```prisma
enum AccountStatus {
  ACTIVE
  RESTRICTED
  SUSPENDED
}

model User {
  // ...
  accountStatus AccountStatus @default(ACTIVE)
  // `isActive` remains in the schema for one release, read and written by
  // nothing, and is dropped by a follow-up migration.
}

/// One row per transition. Current status lives on User; how it got there
/// lives here. Never updated, only appended.
model AccountStatusChange {
  id        String        @id @default(cuid())
  userId    String
  from      AccountStatus
  to        AccountStatus
  reason    String
  /// RECEIPT_FRAUD | CHARGEBACK | BONUS_ABUSE | MULTI_ACCOUNT | OTHER
  category  String?
  /// Staff account that made the change, or null when the expiry pass did.
  actorId   String?
  /// When set, the expiry pass returns the account to ACTIVE at this time.
  expiresAt DateTime?
  createdAt DateTime      @default(now())
  user      User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([expiresAt])
  @@map("account_status_changes")
}
```

Migration backfills `accountStatus = CASE WHEN "isActive" THEN 'ACTIVE' ELSE 'SUSPENDED' END`.

## Components

### `AccountStatusService`

`apps/api/src/services/account-status.service.ts` — the only writer of
`accountStatus` in the codebase.

```ts
restrict(userId, { reason, category?, expiresAt?, actorId }): Promise<AccountStatusChange>
suspend(userId,  { reason, category?, expiresAt?, actorId }): Promise<AccountStatusChange>
reinstate(userId, { reason, actorId }): Promise<AccountStatusChange>
history(userId): Promise<AccountStatusChange[]>
```

Each transition is one `$transaction`: read the current status, write the new
one on `User`, append the `AccountStatusChange`, write an `AuditLog` row. A
transition to the status the account already holds is a no-op that returns the
existing row rather than appending a duplicate.

Post-commit, outside the transaction: invalidate the Redis status cache, notify
the player, and mirror to ZareCash via `syncPlayerFreeze` — best-effort and
logged, because a failed upstream sync must never leave the local account
un-contained. That ordering matters: the local freeze is what protects our own
balance.

### Enforcement

Two layers, both central.

**`authenticate`** (`index.ts:237`) resolves the caller's status and refuses
`SUSPENDED` with `401 { error, code: 'account_suspended' }`. `RESTRICTED` passes
through — that is the point of the middle state.

**`requireActiveAccount`**, a preHandler applied to the money and play routes:
`POST /wallet/deposit`, `/wallet/deposit/checkout`, `/wallet/deposit/checkout/claim`,
`/wallet/withdraw`, and game entry. It refuses anything other than `ACTIVE` with
`403 { error, code: 'account_restricted' }`.

`WalletService.requestWithdrawal` keeps its own status check inside the wallet
lock. That is deliberate duplication: it is the last line before money moves,
and it must not depend on a caller having remembered a preHandler.

**Status caching.** A per-request database read on every authenticated call is
the wrong cost, and JWT-lifetime staleness is the wrong risk when the account is
suspected of fraud. Status is cached in Redis for 30 seconds under
`acct:status:<userId>` and deleted on every transition, so containment takes
effect within 30 seconds at worst and usually immediately.

### Expiry

An hourly BullMQ pass on the existing sweep-style pattern returns to `ACTIVE`
every account whose most recent change carries an `expiresAt` in the past,
appending a change row with `actorId = null`. Bounded per run.

### Admin surface

`POST /admin/players/:id/restrict`, `/suspend`, `/reinstate`, and
`GET /admin/players/:id/status-history`. Role enforced server-side: `restrict`
accepts CLERK or ADMIN, the other two are ADMIN-only. Hiding a button is not a
permission model.

`apps/admin/pages/players/[id].vue` gains a status badge, the three actions
behind a reason/category/expiry form, and the history rendered as a timeline.

### Player-facing

Distinct copy for a refused login versus a blocked action, in `en` and `am`.
`RESTRICTED` keeps support chat reachable; that is what the state is for.

## Call sites moving off `isActive`

| Site | Change |
|---|---|
| `wallet.service.ts:295` | withdrawal block reads `accountStatus !== ACTIVE` |
| `campaign.service.ts:251` | targeting filters `accountStatus: ACTIVE` |
| `campaign.service.ts:378` | staff check reads `accountStatus` |
| `player-metrics.service.ts:41,91` | raw SQL, hand-edited |
| `admin/index.ts` clerk create + user lists | write and return `accountStatus` |
| `freeze-player.ts`, `freeze-player-args.ts` | becomes a wrapper over `AccountStatusService` |

`PlayerMetrics.isActive` is a different, derived column on a different table. It
stays, and sources from `accountStatus`.

## Testing

- transition matrix, including the no-op re-transition and that history appends
- permission matrix enforced server-side, not in the UI
- each enforcement point: login refusal, preHandler refusal, withdrawal refusal
- cache invalidation: a suspension takes effect on the next request
- expiry pass returns exactly the due accounts and no others
- a failed ZareCash sync leaves the local suspension in place

## Out of scope

- Automatic fraud detection. Its own spec; it will call this service.
- Balance forfeiture. Money-destroying operations need a policy decision and
  probably a second approver.
- Device fingerprinting and multi-account linking. Detection signals, not
  containment mechanics.
