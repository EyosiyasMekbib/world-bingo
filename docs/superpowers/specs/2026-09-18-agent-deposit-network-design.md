# Agent deposit network

Status: approved 2026-09-18. Branch `feat/agent-deposit-network`.

## Problem

Players who hold cash and no mobile money cannot deposit. The existing paths are
ZareCash and a manual receipt flow, both of which assume a bank or wallet
account. An agent network turns shopkeepers into deposit points: they take the
cash, we credit the player.

## Shape of the deal

An agent pre-pays the operator in cash and receives **float**, plus a
**commission bonus** on top which is their margin. They sell that float on by
crediting players who hand cash across a counter. Cash never touches the
platform. The only thing that crosses is a six-digit code.

This is deliberately prepaid, not a credit line. The operator is never exposed
to an agent absconding: float is money already received.

## Decisions

| Question | Decision |
|---|---|
| How agents get float | Prepaid. An admin credits it directly after taking cash out of band. No agent-side top-up request flow. |
| Agent margin | Commission float added on top of the cash at top-up time. Global default rate in settings, overridable per top-up. No per-deposit commission subsystem. |
| Who initiates a deposit | The player. They pick the amount and get a code; the agent fulfils it. Removes wrong-account risk entirely. |
| Who may fulfil a code | Any agent. First to confirm wins. No agent directory, no geo, no binding. |
| v1 scope | Deposit fulfilment only. No cash-out, no agent-led player registration. |
| Bonus eligibility | Identical to a gateway deposit. Full first-deposit, daily and weekly bonus eligibility, PostHog events, metrics. |
| Agent identity | `UserRole.AGENT` on `User`, plus an `Agent` profile row. Reuses JWT auth, refresh tokens, `AccountStatus` suspension and audit. |
| Controls | Per-deposit min and max, plus instant suspend. No daily volume cap, no velocity alerting in v1. |
| Reversals | None automatic. An admin debits the agent float and adjusts the player wallet as two deliberate actions. |
| Agent app | New `apps/agent`: Nuxt 3, `@nuxt/ui`, desktop-first, English only, no PWA, port 3003. One deployment per brand. |
| Admin permissions | ADMIN and SUPER_ADMIN both create agents and issue float. Every action audit-logged. |

## Data model

- `Agent` — `userId` unique, `shopName`, `float` Decimal(12,2). A raw
  `CHECK (float >= 0)` in the migration backstops the application-level
  `SELECT FOR UPDATE`, matching the `wallets` pattern.
- `AgentLedger` — append-only, one row per float movement.
  `TOP_UP | COMMISSION | FULFILLMENT | ADJUSTMENT`, signed amount, with
  `balanceBefore` and `balanceAfter` snapshots.
- `AgentDepositRequest` — `code`, `userId`, `amount`, status
  `PENDING | FULFILLED | EXPIRED | CANCELLED`, `expiresAt`, and the `agentId`
  and `transactionId` it settled into.

Two partial unique indexes carry the concurrency rules, since Prisma's DSL
cannot express a `WHERE` on an index:

```sql
CREATE UNIQUE INDEX ... ON agent_deposit_requests(code)   WHERE status = 'PENDING';
CREATE UNIQUE INDEX ... ON agent_deposit_requests("userId") WHERE status = 'PENDING';
```

One live code globally per code value; one live code per player.

Settings live as `SiteSetting` rows: `agent_commission_rate` (percent),
`agent_deposit_min`, `agent_deposit_max`, `agent_code_ttl_seconds`.

## The fulfilment transaction

The whole feature rests on one commit. `WalletService.approveDeposit` is split
into `creditApprovedDepositInTx(tx, ...)` plus `runPostApprovalEffects(result)`,
so the agent float debit can share the deposit's transaction rather than racing
it. `approveDeposit` keeps its exact existing behaviour as the composition of
the two.

Inside one `prisma.$transaction`:

1. Lock the request `FOR UPDATE`; refuse unless PENDING and unexpired.
2. Lock the agent `FOR UPDATE`; refuse when `float < amount`.
3. Debit float, write the `FULFILLMENT` ledger row.
4. Create the `Transaction`: `DEPOSIT`, `PENDING_REVIEW`, `gateway: 'agent'`.
5. `creditApprovedDepositInTx(tx, transaction.id, { reviewerId: agentUserId })`.
6. Mark the request FULFILLED.

Then `runPostApprovalEffects` after commit, so an agent deposit fires the same
bonuses, notifications and events as any other.

Two traps, both load-bearing:

- **`senderName` and `senderAccount` stay null.** `PayerIdentityService` keys
  shared-payer detection on `senderAccount`. Stamping the agent there would make
  every player after the first at that shop look like a shared payer and
  silently strip their first-deposit incentives.
- **`reviewedById` is the agent's user id.** That makes the existing
  separation-of-duties check refuse an agent fulfilling a code for their own
  player account.

## Known risk, accepted

Full bonus eligibility plus no bank trail means an agent cycling float through
accounts they control is the one real abuse vector. The countermeasures chosen
are per-deposit limits and instant suspension, not a daily cap. If this shows up
in the numbers, a per-agent daily volume cap and a velocity view are the next
step, and the ledger already carries the data to detect it.

## Surfaces

- `apps/agent`: login, counter screen (code entry, confirm, success, refusal
  states), float ledger.
- `apps/admin`: `pages/agents/index.vue` (list, create, suspend) and
  `pages/agents/[id].vue` (issue or debit float, ledger).
- `apps/web`: an Agent option on the deposit page, then the live code with a
  countdown.

## Tests that matter

Float never goes below zero. Two agents racing one code: exactly one wins and
the float moves once. Expired, cancelled and already-fulfilled codes refused.
Suspended agent refused. Amount outside limits refused. Commission maths with
and without override. An agent cannot fulfil their own code. And the regression
that two players depositing at the same agent both keep first-deposit
eligibility.
