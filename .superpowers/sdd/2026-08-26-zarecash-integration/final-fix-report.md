# Final-review fix report — commit `ed82bd4`

`fix(zarecash): address final whole-branch review — 3 critical, 5 important`,
branch `feat/zarecash-integration`. Reconstructed from `git show ed82bd4
--stat` and a full read of the diff and the current state of every changed
file — not from the commit message alone.

```
24 files changed, 2001 insertions(+), 222 deletions(-)
```

Source changed: `apps/api/src/services/zarecash.service.ts`,
`apps/api/src/services/wallet.service.ts`, `apps/api/src/services/admin.service.ts`,
`apps/api/src/workers/zarecash-sweep.worker.ts`,
`apps/api/src/workers/zarecash-withdrawal.worker.ts`,
`apps/api/src/gateways/payment/zarecash/client.ts`, `apps/api/src/index.ts`,
`apps/api/src/lib/queue.ts`, `apps/api/src/lib/sentry.ts`,
`apps/api/prisma/schema.prisma` + a new migration, `.env.example` /
`apps/api/.env.example`. Ten test files changed or added.

This report predates it in the review sequence in `progress.md`, which
records the finding list under **"FINAL WHOLE-BRANCH REVIEW
(a33ca35..c71c414): NOT READY TO MERGE"** — the review that produced this
commit's fixes.

---

## CRITICAL 1 — the reconciliation sweep walked backwards through history

**The bug.** `GET /v1/events` orders `createdAt DESC` and returns
`nextCursor` as the id of the *last* row of the page — i.e. the *oldest*
one. The old `sweepEvents` persisted that cursor in `SiteSetting` and resumed
from it next run, still descending — so every run scanned strictly *older*
events than the previous one. After run one, anything created since the
previous sweep was never scanned at all; once the walk reached the start of
history the cursor froze on an ancient page and every subsequent run logged
`scanned=100 replayed=0`, looking perfectly healthy while reconciling
nothing.

**What the code now does.** `ZareCashService.sweepEvents()`
(`apps/api/src/services/zarecash.service.ts:157-204`) no longer persists a
cursor between runs. Every run starts from the newest page (`cursor:
undefined` on the first call) and pages *forward* — older — within that
single run via `replayPage()` (`zarecash.service.ts:212-270`), stopping as
soon as it reaches a page every event on which is already recorded **and**
already processed (`caughtUp`). On a healthy day that's page one. A run is
bounded to `SWEEP_MAX_PAGES = 20` pages of `SWEEP_PAGE_SIZE = 100`
(`zarecash.service.ts:27-28`) — 2,000 events — after which it stops loudly
(`truncated: true`, a `console.error` and `reportWarning('...page
budget...', { phase: 'zarecash-sweep-truncated', ... })`,
`zarecash.service.ts:188-203`) rather than silently truncating. The dead
`zarecash_events_cursor` `SiteSetting` row is deleted by the migration
(`apps/api/prisma/migrations/20260826140000_zarecash_gateway_routing_marker/migration.sql`,
second half) so it can't keep misleading anyone who queries it.

**Tests.** `apps/api/src/test/zarecash-sweep.test.ts` was substantially
rewritten. It adds an `upstream()` helper that is a faithful stand-in for
`paymentmgmtv2`'s actual `GET /v1/events` semantics (descending order,
`nextCursor` = oldest row of the page) — the file's own comment notes every
earlier version of this suite mocked `listEvents` as a flat value and never
modelled the ordering, "which is exactly why the backwards-walking sweep
shipped looking healthy." The direct regression test is **"scans an event
created AFTER the previous run — the reconciliation sweep is not a backwards
walk"**: it runs a real `SiteSetting`-backed cursor round-trip across two
sweep calls, injects a brand-new event between them, and asserts it gets
picked up. Additional tests cover forward-paging a >100-event backlog in one
run, stopping at the first fully-processed page, and stopping loudly at the
page budget. `apps/api/src/test/zarecash-sweep-worker.test.ts` (new) covers
that both scheduled jobs are actually wired up with the right cron patterns.

---

## CRITICAL 2 — the admin double-pay guard keyed on `gatewayRef`

**The bug.** The manual-review guard in `AdminService.reviewTransaction`
checked `tx.gatewayRef` to decide whether a withdrawal was gateway-managed.
`gatewayRef` is the *upstream id*, written only after `createWithdrawal`
returns successfully. Between the local debit and that write — the payout
POST in flight, up to `ZARECASH_WITHDRAWAL_ATTEMPTS` (8) attempts at
`ZARECASH_TIMEOUT_MS` each — the row sits `PENDING_REVIEW` with `gatewayRef`
still `null`. A clerk working the review queue in that window sailed straight
through the guard and could reject-and-refund (or hand-approve) a payout
ZareCash was simultaneously settling: refunded locally *and* paid upstream.

**What the code now does.** A new `Transaction.gateway` column
(`apps/api/prisma/schema.prisma:165-171`, migration
`20260826140000_zarecash_gateway_routing_marker`) records the **routing
decision**, not the upstream id. `WalletService.requestWithdrawal` resolves
`routeToZareCash` *before* opening the wallet transaction and writes
`gateway: 'zarecash'` inside the same `$transaction` that debits the wallet
(`apps/api/src/services/wallet.service.ts:330,394`) — so the guard is armed
before the payout job is even enqueued, with no window. If the subsequent
enqueue fails, the marker is released back to `null` so the row falls back
to the ordinary manual-review path rather than being stuck behind a guard no
worker will ever clear (`wallet.service.ts:413-461`).
`WalletService.initiateDeposit` does the equivalent for deposits
(`wallet.service.ts:57-71`), though deposits never needed the guard —
`WalletService.approveDeposit` is idempotent and safe to call regardless.

`AdminService`'s new `isGatewayManaged()` helper
(`apps/api/src/services/admin.service.ts:25-28`) keys on `tx.gateway ===
'zarecash' || tx.gatewayRef !== null`, scoped to `PENDING_REVIEW` only —
`gatewayRef` is still honoured so rows predating the column stay protected.
It replaces the raw `tx.gatewayRef` / `existing.gatewayRef` checks in both
the approve path (`admin.service.ts:287`) and the reject path
(`admin.service.ts:340`).

**Tests.** `apps/api/src/test/admin.service.test.ts` adds a describe block,
**"WITHDRAWAL — ZareCash-routed, submit still in flight (gateway set,
gatewayRef null)"**, that puts a row in exactly the vulnerable state
(`gateway: 'zarecash', gatewayRef: null`) and asserts both the reject and the
approve manual paths are refused, with an explicit balance assertion noting
that under the old gatewayRef-keyed guard this would have re-credited the
wallet. A third test confirms a payout that later failed permanently and was
refunded (`gateway` still `'zarecash'`, `status: REJECTED`) is correctly
treated as settled, not "still managed." `apps/api/src/test/zarecash-withdrawal-routing-marker.test.ts`
(new, real DB) directly proves the producer side: `gateway` lands
`'zarecash'` with `gatewayRef` still `NULL` immediately after
`requestWithdrawal` commits — the precise in-flight state the whole fix is
about — plus the marker-release-on-enqueue-failure path.
`apps/api/src/test/deposit-initiate-enqueue.test.ts` covers the deposit half.

---

## CRITICAL 3 — nothing retried an event stranded at `processedAt = null`

**The bug.** The webhook route returns `200` *before* processing
(`apps/api/src/routes/zarecash/webhook.ts:32-68`), so ZareCash never
redelivers a webhook we've already recorded. The BullMQ event-processing job
gets the queue's default 3 attempts (`apps/api/src/lib/queue.ts:93-101`, no
override on `ZARECASH_EVENT`) and then the job is gone. With the
reconciliation sweep itself broken (Critical 1) and nothing else revisiting
`processedAt = null` rows, an event that failed all 3 attempts was stranded
permanently. For `withdrawal.rejected` specifically, that meant a player
debited for a payout ZareCash refused, with no refund and — because
Critical 2's guard was also live — no admin remedy either.

**What the code now does.** A new **stranded-event pass**,
`ZareCashService.requeueStrandedEvents()`
(`apps/api/src/services/zarecash.service.ts:286-319`), queries
`zarecash_events` for `processedAt IS NULL AND receivedAt < now() -
STRANDED_MIN_AGE_MS` (10 minutes, `zarecash.service.ts:50` — old enough that
it isn't just a job still in flight) and re-enqueues each one. It's scheduled
every 15 minutes (`zarecash-sweep.worker.ts:67-76`, job name
`requeue-stranded`, jobId `zarecash-stranded-requeue`) — far more frequent
than the nightly sweep, because a debited player can't wait until 3am.
`processSweepJob` dispatches to it by job name
(`zarecash-sweep.worker.ts:18-34`).

Separately, the withdrawal worker's terminal refund — the very thing this
pass exists to protect — used to have a blanket `catch` that logged and
dropped a genuine refund failure. It's now a named, independently retryable
job: `refundOrTolerateTerminal()` is extracted
(`apps/api/src/workers/zarecash-withdrawal.worker.ts:97-110`), and if the
direct refund attempt inside `handleWithdrawalFailure` throws, it's
re-enqueued as its own `TERMINAL_REFUND_JOB` with the full attempts budget
(`zarecash-withdrawal.worker.ts:217-237`) instead of being swallowed. A
terminal-refund job that itself exhausts retries no longer recurses — it logs
an unambiguous "STILL DEBITED and needs manual intervention" and stops
(`zarecash-withdrawal.worker.ts:132-144`).

**Tests.** `zarecash-sweep.test.ts` adds a `requeueStrandedEvents` describe
block (re-enqueues stranded rows, respects the age cutoff, silent no-op when
nothing's stranded, bounded query). `zarecash-sweep-worker.test.ts` (new)
covers the 15-minute schedule and job-name dispatch.
`zarecash-withdrawal-worker.test.ts` adds: **"re-enqueues the terminal
refund when it fails, instead of swallowing it"** (the direct regression
test, with a comment noting the old behaviour "left the player permanently
debited... with nothing anywhere that would ever try again"), plus tests for
the success path, the already-resolved-row benign case, the terminal-refund
job's own processing, and that an exhausted terminal-refund job does not
recurse.

---

## IMPORTANT 1 — `initiateDeposit`'s enqueue was unguarded

**The bug.** The `Transaction` row is committed (with a unique
`paymentTransactionId`) before the ZareCash submit job is enqueued. If the
enqueue itself threw (a Redis blip), that exception propagated to the route
as a 500 — but the row was already committed. The player's retry with the
same receipt then hit the duplicate-transaction-ID check and got a permanent
`409 Transaction ID already used`, with an orphaned `PENDING_REVIEW` row
behind it and no job that would ever submit it.

**What the code now does.** The `getQueue(...).add(...)` call in
`WalletService.initiateDeposit` is wrapped in try/catch
(`apps/api/src/services/wallet.service.ts:90-99`); on failure it logs,
reports to Sentry (`phase: 'zarecash-deposit-enqueue'`), and still returns
the committed transaction — matching the pattern already used by the
sibling manual-flow path (`DepositVerificationService.enqueue`) and by the
withdrawal enqueue, which had already been hardened this way in an earlier
task.

**Tests.** `apps/api/src/test/deposit-initiate-enqueue.test.ts` adds
**"a failed ZareCash enqueue must not fail the request"**: returns the
transaction instead of throwing when the queue is down, and reports the
failure rather than swallowing it silently.

---

## IMPORTANT 2 — inline terminal states were ignored, and a lost race silently consumed events

Two related gaps under one finding.

**2a — `submitWithdrawal` only handled inline `'rejected'`.** ZareCash can
settle a payout synchronously in the POST response, not only via webhook —
verified against the emitter (`paymentmgmtv2`'s
`WithdrawalsService.create`/`settleSandbox`), which records and enqueues
`withdrawal.approved` *before* the HTTP response even reaches us. The old
code only branched on `res.state === 'rejected'`; an inline `'approved'` or
`'cancelled'` response left the row sitting `PENDING_REVIEW` until (or
unless) the webhook happened to rescue it. `submitWithdrawal`'s switch now
handles all three terminal states explicitly (`zarecash.service.ts:433-453`),
sharing `refundWithdrawalIfPending()` (`zarecash.service.ts:464-477`) and
`settleApprovedWithdrawal()` (`zarecash.service.ts:660-721`) with the webhook
handlers, so the inline path and a racing webhook resolve to the same place
safely.

**2b — a lost `gatewayRef` race silently consumed the event.** A terminal
webhook can arrive before our own `gatewayRef` write lands (the reverse of
2a's race). The old handlers (`onDepositApproved` etc.) just logged "unknown
gatewayRef" and returned — which let `processEvent`'s success path stamp
`processedAt`, permanently discarding an event for a row that would get its
`gatewayRef` a moment later and then sit `PENDING_REVIEW` forever, with
Critical 2's guard refusing both manual admin actions. A new
`UnknownGatewayRefError` (`zarecash.service.ts:52-60`) is thrown by
`requireByGatewayRef()` (`zarecash.service.ts:580-584`, now used by all four
`onDeposit*`/`onWithdrawal*` handlers that need a known row) and specially
handled in `processEvent`'s catch: `processedAt` is left `null` for retry
while the event is younger than `UNKNOWN_REF_GRACE_MS` (24h,
`zarecash.service.ts:42`); past that, it's genuinely unrecognisable rather
than merely early, so it's stamped processed with the error kept and both a
Sentry report and an `AuditLog` alert raised
(`zarecash.service.ts:525-561`).

**Tests.** `apps/api/src/test/zarecash-withdrawal-submit.test.ts` adds
**"submitWithdrawal — inline terminal states"**: settles an inline
`'approved'`, refunds an inline `'cancelled'`, tolerates the webhook winning
the race on `'rejected'`, still propagates a genuine refund failure, leaves
`'risk_hold'` pending. `apps/api/src/test/zarecash-event-processing.test.ts`
adds **"processEvent — terminal event for an unknown gatewayRef"**,
parametrized across five event types, asserting `processedAt` is *not*
stamped and the stranded pass can retry — plus a test for the 24h
grace-window expiry (stamps, alerts) and a control test that an
*unrecognised event type* (not a gatewayRef miss) is still consumed normally.

---

## IMPORTANT 3 — `onWithdrawalApproved` absorbed a genuine double payment as a redelivery

**The bug.** `settleApprovedWithdrawal`'s atomic claim
(`updateMany({ where: { status: PENDING_REVIEW }, ... })`) treated
`claim.count === 0` as "already handled, a redelivery" unconditionally. But
if we'd already refunded the row locally (`status: REJECTED`) and ZareCash
*then* settles it anyway — the scenario the whole refund-on-uncertainty
design accepts as a risk — this path silently returned, and the player was
paid twice with no record anywhere.

**What the code now does.** `settleApprovedWithdrawal`
(`zarecash.service.ts:660-721`) now re-reads the row's current status when
the claim finds nothing: if it's `REJECTED`, that's a genuine double
payment — a `console.error`, a `reportError` with `phase:
'zarecash-double-payment'`, and an `AuditLog` row (`action:
'zarecash.double_payment'`) are all raised. Any other status (`APPROVED`, or
the inline path and the webhook simply racing each other) stays a quiet,
routine "already settled" log — the spec accepts the *risk* of a double
payment as the price of refunding under uncertainty; it does not accept
*silence* about one actually happening.

**Tests.** `zarecash-event-processing.test.ts`, **"processEvent —
withdrawal.approved landing on an already-resolved row"**: "alarms loudly
when the row was REJECTED — that is a real double payment" (asserts
`reportError` and `AuditLog.create` both fire with the right shape), and
"stays quiet when the row was already APPROVED — that is an ordinary
redelivery" (asserts neither fires).

---

## IMPORTANT 4 — the ZareCash boot block could kill the API

**The bug.** Two independent paths could take the whole API down over a
payment provider blip, defeating the earlier "unreachable ZareCash must not
block boot" decision:
1. `ZareCashClient.request()` returned `null as T` for a `2xx` with an empty
   or unparseable body. `assertMode` read `float.mode` off that lie *outside*
   the try/catch wrapping `getFloat()`, so a truncated `200` threw a bare
   `TypeError` — inside `index.ts`'s exit-on-throw block.
2. `scheduleZareCashSweep()`'s `getQueue(...).add(...)` could throw if Redis
   was down at startup, with nothing catching it either.

**What the code now does.** `ZareCashClient.request()` now fails at the
source: a `2xx` whose body is empty or fails to parse throws a
`ZareCashError({ code: 'invalid_response', permanent: false })`
(`apps/api/src/gateways/payment/zarecash/client.ts:80-93`) instead of
returning `null`. `freezePlayer`/`unfreezePlayer` opt out via a new
`expectBody: false` (`client.ts:132-146`) since their response is never
read and an empty body from them is genuinely fine. In `index.ts`, the whole
`assertMode()` + `scheduleZareCashSweep()` block is now wrapped in its own
try/catch (`apps/api/src/index.ts:393-402`): only the newly-exported
`ZareCashModeMismatchError` (`zarecash.service.ts:68-73`) is rethrown to the
outer exit-on-throw block; everything else — including the
now-correctly-thrown `invalid_response` and a Redis-down `queue.add()` — is
logged and `reportError`'d (`phase: 'zarecash-boot'`) with boot continuing
unverified.

**Tests.** `apps/api/src/test/zarecash-client.test.ts` adds **"a 2xx with no
usable body"**: empty body on `getFloat`, a truncated JSON body, an empty
body on a mutating call (`createWithdrawal`), confirms freeze/unfreeze still
tolerate an empty body, and confirms a non-`2xx` still surfaces as its own
error code rather than `invalid_response`. `zarecash-sweep.test.ts` adds
"raises a typed error on mismatch so index.ts can tell it from any other
boot failure" (`ZareCashModeMismatchError` `instanceof` check).

**What I could not verify from the diff:** `index.ts` itself has no test
file in this repo — there is no test that boots the actual server with a
mocked Redis-down `scheduleZareCashSweep` or a truncated-body
`assertMode` and asserts the process does *not* exit. The fix's correctness
here rests on the two things that *are* tested (the client no longer lies
about a bad body; the mismatch error is now a distinguishable type) plus a
direct code read of `index.ts:393-402` confirming the try/catch shape is
what the comment says it is. That's a real but narrow gap — the pattern
(only rethrow the one named type) is simple enough that a read is fairly
convincing, but it is a read, not a test result.

---

## IMPORTANT 5 — the `withdrawal_pending` gate keyed on the final error only

**The bug.** `handleWithdrawalFailure`'s refund gate checked only the error
from the *last* attempt. Seven attempts of `withdrawal_pending` (ZareCash
telling us a payout is genuinely still open) followed by a single
`network_error` on the eighth and final attempt fired the terminal refund
anyway — refunding a payout that was, by ZareCash's own repeated word,
still in flight. Network errors are common during exactly the kind of
provider trouble that produces this state disagreement, so this wasn't an
edge case.

**What the code now does.** `ZareCashWithdrawalJobData` gains a sticky
`sawWithdrawalPending?: boolean` field
(`apps/api/src/workers/zarecash-withdrawal.worker.ts:24-42`).
`processWithdrawalJob` sets it via `job.updateData()` the first time *any*
attempt sees a `withdrawal_pending` `ZareCashError`
(`zarecash-withdrawal.worker.ts:54-89`) — and if persisting the marker
itself fails, that's logged and reported but the *original* failure is still
rethrown unchanged, so BullMQ and the failure handler always see the real
error. `handleWithdrawalFailure`'s refund gate now checks `zc?.code ===
'withdrawal_pending' || data.sawWithdrawalPending`
(`zarecash-withdrawal.worker.ts:181`) — having seen `withdrawal_pending`
even once disqualifies the refund for the rest of that job's life, since a
later `network_error` tells us nothing about whether the in-flight payout
landed.

**Tests.** `zarecash-withdrawal-worker.test.ts` adds the direct regression
case, **"does NOT refund when an earlier attempt saw withdrawal_pending,
even though the FINAL error is a network error"** (seven `withdrawal_pending`
+ one `network_error`, asserts no refund and `stickyMarker: true` on the
Sentry report), plus "sets the sticky marker... the first time", "rethrows
the ORIGINAL failure even when persisting the marker fails", and "does not
touch the job data for an ordinary failure."

---

## Promoted minors

Two items from the deferred-minors backlog were promoted into this commit
alongside the 8 numbered findings (`progress.md`'s "Deferred-minors triage:
FIX T4, T12, T13a, T13b" — T4 maps directly to Important 4's `client.ts`
fix above, per that test file's own comment: "Final-review Important 4 /
deferred minor T4." I could not resolve the T12/T13a/T13b labels to specific
earlier ledger entries from the files in this directory; I'm reporting what
the diff actually contains rather than guessing at the mapping).

- **`ZARECASH_WITHDRAWAL_ATTEMPTS` validation and documentation.** The old
  `Number(process.env.ZARECASH_WITHDRAWAL_ATTEMPTS || '8')` silently produced
  `NaN` for a non-numeric value — and `job.attemptsMade < NaN` is `false`, so
  the "have we exhausted retries?" gate passed on the *first* failure,
  firing the terminal refund after one transient blip. `readWithdrawalAttempts()`
  (`apps/api/src/lib/queue.ts:69-81`) now requires a positive integer,
  warning and falling back to 8 otherwise, with a test seam
  `__readWithdrawalAttemptsForTest()` (`queue.ts:86-88`). `.env.example` and
  `apps/api/.env.example` both gained the explanatory comment block. Tests:
  `apps/api/src/test/zarecash-attempts-config.test.ts` (new) — valid
  integer, default-when-unset, and explicitly **"never yields NaN for a
  non-numeric value — that would refund on the first failure."**
- **`risk_hold` / `float.low` wired to notifications and Sentry.** These
  were `console.warn`-only despite the spec calling for "an admin alert" and
  "admin notification + Sentry warning" respectively. New
  `onWithdrawalRiskHold()` (`zarecash.service.ts:667-688`) and `onFloatLow()`
  (`zarecash.service.ts:690-707`) both call `reportWarning()`
  (`apps/api/src/lib/sentry.ts:49-65`, itself new in this commit) and the new
  `recordAdminAlert()` `AuditLog` helper (`zarecash.service.ts:515-532`).
  Tests: `zarecash-event-processing.test.ts`'s "processEvent — operational
  alerts" block and updates to `zarecash-withdrawal-events.test.ts`.

---

## Test verification performed for this report

Every mock-only test file touched by this commit was run directly and
passes: `zarecash-sweep.test.ts`, `zarecash-sweep-worker.test.ts`,
`zarecash-event-processing.test.ts`, `zarecash-withdrawal-events.test.ts`,
`zarecash-withdrawal-submit.test.ts`, `zarecash-withdrawal-worker.test.ts`,
`zarecash-attempts-config.test.ts`, `zarecash-client.test.ts`,
`deposit-initiate-enqueue.test.ts` — 9 files, 105 tests, all passing. The two
real-DB test files, `admin.service.test.ts` and
`zarecash-withdrawal-routing-marker.test.ts`, were also run against the
local Postgres instance and pass — 2 files, 42 tests. **147 tests total,
all green**, at the commit this report describes.

---

## ⚠ Verification gap — discrimination checks NOT performed for the three Criticals

Every prior task in this branch's ledger (`progress.md`, Tasks 8, 9, 11, 12)
records a **discrimination check** after its fix: revert the fix, re-run the
new regression test, and confirm it actually fails against the pre-fix code
— proof the test would have caught the bug, not just that it passes now.
Example, Task 11: *"Discrimination check: reverting dedup failed exactly 2
tests ('expected replayed +0 to equal 1'; 'Unique constraint failed')."*

**That step was not performed for this commit.** `progress.md`'s entry for
the final whole-branch review lists the three Criticals, the five
Importants, and the deferred-minors triage decision — and then simply stops,
with no `Discrimination check:` line, unlike every other entry in the file.
There is no `task-13-report.md` or equivalent covering it either. The fix
wave was interrupted before that verification step.

**What this means concretely:**

- The regression tests described above for CRITICAL 1 (backwards-walking
  sweep), CRITICAL 2 (gatewayRef-keyed guard), and CRITICAL 3 (stranded
  events) all exist, and I confirmed directly (see above) that they pass
  against the current, fixed code.
- **I have not confirmed that any of them would have failed against the
  code as it stood before this commit.** For a test whose logic is subtle —
  the sweep test in particular constructs a full mock of `paymentmgmtv2`'s
  cursor semantics — it is possible, though I have no specific reason to
  suspect it, for a regression test to pass against both the old and the new
  code (a test that doesn't actually exercise the bug it was written for).
- This is, as far as I can tell from the diff and the ledger, **the one
  unverified step on an otherwise fully-verified branch** — every other task
  in this branch has a recorded discrimination check; these three do not.

**To close this gap**, for each of the three Criticals: `git stash` or
`git checkout` the pre-fix version of the relevant source file (commit
`c71c414`, the parent of `ed82bd4`), leave the new test file as-is, run the
specific new test(s), and confirm they fail with an assertion error that
matches the described bug — then restore the fixed source. I did not do this
as part of writing this report; it should be done before treating this
commit as fully verified.
