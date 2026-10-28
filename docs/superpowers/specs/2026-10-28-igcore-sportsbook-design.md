# IGCORE sportsbook integration (Winner)

**Date:** 2026-10-28
**Status:** draft, awaiting approval
**Source of truth for the protocol:** `~/Downloads/IGCORE-Sportsbook-Integration-v3-final.pdf`
(document v3, API 1.0.0, 36 pages). Section numbers below (§3.3, §4.11, ...) refer to it.
Re-read the PDF when behaviour is ambiguous; do not trust a summary of it, including this one.

## Intent

Winner gets a sportsbook. IGCORE supplies it as an iframe plus a seamless-wallet
protocol: they call us to debit stakes and credit payouts, we call them to open a
player session. In IGCORE's vocabulary **we are the CLIENT** and **IGCORE is the
OPERATOR**.

IGCORE has not issued credentials yet. They issue them only after we return their
onboarding form (§1.3). So this work has two outputs:

1. A complete integration running on **Winner staging**, proven against every item of
   IGCORE's go-live checklist (§7) using a simulator we build, so that switching to the
   real IGCORE is a change of environment variables plus one test round against them.
2. The filled-in onboarding form, ready for the user to send.

## Goals

1. On Winner staging a logged-in player opens **Sports**, sees the sportsbook inside the
   page, places a bet with whichever balance their real/bonus toggle selects, and is paid
   when it wins.
2. Every rule in §4.11 (client-side processing) and every OPERATOR→CLIENT item in §7 holds,
   proven by automated tests locally and by a checklist run against staging.
3. With the feature switch off, or without `IGCORE_*` env, nothing changes for anyone.

## Non-goals (this pass)

- Freebets (`grant-freebet`, `freebet` callbacks). We will not request the `freebet`
  account option, so IGCORE sends none. If one arrives anyway, reject it (§4.8: a
  rejection fails the placement and the token stays with the player).
- Ticket PDF links (`generate-ticket-link`).
- An admin page of sports tickets. Tickets are visible through the existing
  third-party transaction views and the ledger.
- Hub/spoke forwarding. IGCORE gives each environment its own account and callback URL,
  so Winner staging is a standalone integration.
- Arada. No Arada UI, no Arada compose change, nothing shipped to `main`.
- Production go-live. That follows IGCORE's own checklist run once credentials exist.

## Anti-goals (a failure even if it "works")

- Any behaviour change on Arada, production or staging-visible.
- Money moved twice for one IGCORE `transaction_id`.
- Answering a `result` or `rollback` with HTTP 200 and an error. §4.5 treats that as
  permanently failed and never retries it, so the player silently loses a payout.
- The simulator being reachable on any production deployment. It can mint wallet credits.

## Decisions

Marked **user** where the user decided; everything else is the designer's call and can be
revisited.

| Decision | Choice | Why |
|---|---|---|
| Brand / environment | **user:** Winner staging only | Winner is the brand that wants a sportsbook |
| Balance for stakes | **user:** follow the wallet's `spendAccount` toggle, exactly as casino providers do | Consistency with casino games |
| Where wins land | Real balance, always | Existing house rule for every third-party provider (`palace-wallet.service.ts`, "A win always credits real balance"). Also, §4.7 forbids rejecting a result, so there is no "wrong account" refusal path |
| UI | "Sports" item right after Home in the Winner chrome nav and rail; `/sports` page with the iframe filling the space below the top bar | Agreed in conversation |
| Feature switch | Setting `feature_sportsbook`, default `'false'`, toggled in admin Settings → Features; nav item hidden and `/sports` unavailable while off | Same pattern as `feature_prediction_market` |
| Logged-out visitor | `/sports` shows the existing login prompt | `start-session` requires a `user_id` (§3.3) |
| Player id sent to IGCORE | The existing `accountForLaunch` 32-hex form of the user UUID | Already the convention for Palace/GASea/Atlas-V; fits IGCORE's `user_id` charset (Appendix A); resolved back by the same lookup |
| Currency / languages | ETB; `en` and `am` requested, `en` the default | Winner is ETB-only |
| Account options requested | `info`, `ticketId`, `details`, `rollbackAction`, `sendLose`. Not `freebet`, `links`, `paths`, `username`, `timeout` | `ticketId` links results/rollbacks to the bet; `details` is required for partial cashouts, whose open remainder continues under a NEW ticket id linked back only through `info.newTicket.fromId` (§4.7, §4.10); `rollbackAction` removes guesswork in rollbacks; `sendLose` gives a complete ledger. Options are fixed on the form, and changing them later costs another IGCORE cycle |
| Ticket lineage | A ticket's "root" is itself, or, for a partial-cashout remainder, the root of `info.newTicket.fromId` / `ticket.fromId`. The bet link, the per-ticket payout cap and shortfall netting all key on the root | Otherwise every result on a remainder ticket looks bet-less and the cap resets per remainder |
| Cashback | Sports transactions (`igcore` provider) are excluded from cashback for now | `CashbackService.getNetLossByUser` windows third-party rows by `createdAt`, so a stake placed before period close on a future match would count as a full loss and earn cashback on a ticket that may still win. Casino rounds settle in seconds and never straddle a period. Counting only settled tickets is the later fix |
| Outbound client | `IgcoreClient`: `auth`, `startSession`. Token cached in Redis with TTL `expires_in − 300 s`; on `{"error":"Unauthorized"}` drop the cache, re-auth, retry once (§3.2) | Shared across API replicas; spec says do not auth per request |
| Inbound routes | `POST /v1/igcore/transaction` (bet, result, freebet) and `POST /v1/igcore/transaction-rollback`, registered like Atlas-V's, and added to the rate-limit `allowList` | §4.1 paths; provider callbacks must never be throttled |
| Signature check | HMAC-SHA256 of the **raw request bytes** with `IGCORE_SECURITY_HASH`, lowercase hex, constant-time compare, before JSON parsing (§4.2). Route-scoped content parser with `parseAs: 'buffer'` | Re-serialising parsed JSON breaks the hash; the spec is explicit. Buffer, not string, so the bytes are exactly what was signed |
| Bad signature / unreadable body | HTTP 400, `{"error":"INVALID_SIGNATURE"}` (or `INVALID_JSON`) | For bet/freebet, 400 means "rejected, no rollback" (§4.5); for result/rollback any non-200 is retried, so a misconfigured secret surfaces as IGCORE-side unresolved callbacks rather than lost money |
| Our `transaction_id` in responses | The `ThirdPartyTransaction.id` (UUID) of the row we wrote for that callback | Non-empty, unique, and returned unchanged on duplicates |
| Ledger | One `ThirdPartyTransaction` per callback under a `GameProvider` row with code `igcore`, idempotency key `(providerId, transactionId)` = IGCORE `transaction_id`; `roundId` and `betId` = `String(info.ticketId)`; `gameCode` = `'sportsbook'`; `rawRequest` = full body. Plus the usual `Transaction` row (`TP_BET` / `TP_WIN` / `TP_ROLLBACK`) with `balanceBefore`/`balanceAfter` and, on bets, `bonusBalanceBefore`/`bonusBalanceAfter` | Reuses the existing provider ledger shape (no schema migration). §4.13 asks both sides to keep the full request log |
| Provider row | Created on first use by an idempotent upsert (`code: 'igcore'`, `config: { catalogSync: false, kind: 'sportsbook' }`) rather than by seed | Atlas-V's "provider not seeded" failure (see the Atlas-V playbook) cost a redeploy cycle; an upsert removes it |
| Lobby | No `ProviderGame` rows; the sportsbook is not a lobby game | It is one iframe with its own navigation |
| Win safety caps | Per-callback cap `IGCORE_MAX_WIN_AMOUNT` (default 1,000,000 ETB) and per-ticket (root) cumulative net payout cap `IGCORE_MAX_TICKET_PAYOUT` (default 1,000,000 ETB). Exceeding either records a **held** row under that IGCORE `transaction_id` (status `FAILED`, reason `CAP_EXCEEDED`, nothing credited), answers HTTP 500 and logs `[igcore-fraud-flag]`. A retry that finds a held row re-evaluates it against the current caps: still over → 500 again; now within (cap raised) → apply it and complete the row | IGCORE signs every callback, so caps are a backstop, not the main defence. Release is "raise the cap, ask IGCORE to resend": the row carrying their `transaction_id` guarantees the payout is applied at most once however it is released. No hand-credit path exists for a held payout |
| Simulator | Built into the API, mounted only when `IGCORE_SIMULATOR=true`. That variable is declared only in `docker-compose.betbawa.staging.yml` | Lets the user click through a real bet on staging before IGCORE exists, and runs the §7 checklist in-process. Same precedent as `ALLOW_DEMO_SEED`, which is absent from every production compose file |
| Env vars | Declared in `docker-compose.betbawa.staging.yml`, `docker-compose.betbawa.yml` (empty defaults, so inert) and `apps/api/.env.example`. Arada compose files untouched | Compose forwards only declared vars (Atlas-V's `f949cdb` lesson); Arada must not change |
| Branch | `feat/igcore-sportsbook`, cut from `origin/deploy/winner`, worked in its own worktree | `deploy/winner` is Winner's code line; the main checkout carries unrelated uncommitted work |

## Money rules, per callback

All four run inside one DB transaction holding the player's wallet row
`SELECT ... FOR UPDATE`, exactly like `AtlasVWalletService`. The order in every handler:
verify signature → parse → resolve player → lock wallet → duplicate check on IGCORE
`transaction_id` (a duplicate answers 200 with the stored `transaction_id` and moves
nothing) → apply → write ledger rows → commit → respond → post-commit effects
(balance socket push, analytics) after the response is computed, never before.

A unique-constraint race on `(providerId, transactionId)` (two identical callbacks
racing past the in-transaction check) is caught, the stored row re-read, and answered as a
duplicate.

### `bet` (§4.6, synchronous, 5 s budget)

| Situation | Answer |
|---|---|
| Unknown player | 200 `{"error":"PLAYER_NOT_FOUND"}`, nothing recorded (§7: "no record of the player created") |
| Account not `ACTIVE` | 200 `{"error":"ACCOUNT_RESTRICTED"}` |
| `currency` ≠ ETB | 200 `{"error":"CURRENCY_NOT_SUPPORTED"}` |
| Selected balance < `amount` | 200 `{"error":"INSUFFICIENT_FUNDS"}`, balance unchanged |
| Otherwise | Debit `amount` from the selected account (bonus via `BonusService.spend`, as Atlas-V does), write rows, 200 `{"error":null,"transaction_id":...}` |
| Unexpected failure | Let it 500. §4.5: IGCORE cancels the bet and queues a rollback; the rollback finds nothing applied and records a placeholder |

### `freebet` (§4.8)

Not enabled. Answer 200 `{"error":"FREEBETS_NOT_ENABLED"}` and record nothing.

### `result` (§4.7, queued, retried, must never be refused)

- Unknown player, DB failure, lock timeout, currency mismatch, cap exceeded: HTTP 500
  (retry), never 200 with an error.
- `amount` 0 (a loss under `sendLose`): record it, move nothing, answer success.
- Otherwise credit `amount` to the **real** balance and answer success.
- Link to the bet by the ticket root (see Ticket lineage). A result with no recorded bet for that root is
  still credited (the callback is signed and §4.7 forbids refusal) but logged with
  `[igcore-fraud-flag]` for review.
- Account status does not block a result: it settles a stake already taken. Non-`ACTIVE`
  players still cannot withdraw (same reasoning as `PalaceWalletService.processWin`).

### `rollback` (§4.9, queued, retried)

Look up the original by `rollback_transaction_id`. Its kind comes from
`rollback_transaction_action` when present, else from our stored row's type.

| Original | Effect |
|---|---|
| A `bet` we applied | Restore the stake to the account it came from (bonus portion via `BonusService.restore` using the bet row's `bonusBalanceBefore/After`, as Atlas-V does). Mark the original `ROLLED_BACK` |
| A `result` we applied | Debit its payout from the real balance. If the real balance is short (player already withdrew), debit what is there, record the shortfall on the rollback row, and log `[igcore-rollback-shortfall]` for an admin. Still answer success (§4.11). The wallet's `CHECK (>= 0)` forbids going negative. §4.9: a corrected `result` always follows; it is **netted against the ticket root's outstanding shortfall** first (credit = max(0, payout − shortfall), shortfall reduced accordingly), so a player who withdrew a wrong payout is not paid twice |
| Already rolled back | Duplicate of the earlier rollback effect: move nothing, answer success |
| Not found | Write two rows: the rollback, and a placeholder under `rollback_transaction_id` with status `ROLLED_BACK` and amount 0. Move nothing, answer success. If the original arrives later, the placeholder makes it a duplicate and it is not applied (§4.11 rollback step 4) |

## Player-facing flow

1. Player opens `/sports` (nav item visible only when `feature_sportsbook` is on).
2. Logged out → the existing login prompt.
3. Logged in → web calls `POST /sportsbook/session` (JWT-authenticated). The API checks the
   switch, IGCORE configuration and account status, calls `start-session` with the
   player's id, `ETB` and their language, and returns `{ url }`. Unavailable →
   `503 SPORTSBOOK_UNAVAILABLE` and the page shows a plain "Sports is unavailable right
   now" state with a retry.
4. Page renders `<iframe src=url>` filling the area below the top bar. A new session is
   opened on every visit; the URL is never cached or reused (§3.3).
5. Bets and settlements change the wallet server-side; the header balance updates the
   same way it does during provider casino play. The builder reuses that mechanism.

Arada: the `/sports` route exists in the shared web app but behaves as "unavailable"
because Arada's switch stays off. Arada's shell gets no nav item.

## Simulator (staging only)

Mounted under `/v1/igcore-sim` when `IGCORE_SIMULATOR=true`. Setting
`IGCORE_API_URL` to the simulator's own base makes the real `IgcoreClient` talk to it.

- `POST /1.0.0/auth` and `POST /1.0.0/start-session`, shaped exactly as §3.1 and §3.3,
  including `Unauthorized` and `currency is not allowed` responses.
- `start-session` returns a URL to a small HTML "book" page served by the simulator:
  a few fixed matches with odds, a stake input, and buttons to place a bet, settle as
  win / lose, cash out, roll back a settlement, and simulate a bet the CLIENT answered too
  late (forcing a placement rollback). Each button makes the simulator sign and POST the
  matching callback to our real callback routes over HTTP, so signature checking, routing
  and wallet logic are all exercised as IGCORE would exercise them.
- `POST /checklist` (admin-authenticated) runs every OPERATOR→CLIENT item of §7 against a
  throwaway test player and returns a pass/fail report with balance deltas. It is how
  "proven on staging" is demonstrated.

Never declared in any production compose file. The API logs a warning at startup while it
is on.

## Configuration

| Var | Meaning | Default |
|---|---|---|
| `IGCORE_API_URL` | Operator base URL (without version) | empty → integration off |
| `IGCORE_API_VERSION` | Path prefix | `1.0.0` |
| `IGCORE_USERNAME` / `IGCORE_PASSWORD` | For `/auth` | empty |
| `IGCORE_SECURITY_HASH` | Callback HMAC secret | empty → every callback rejected |
| `IGCORE_CURRENCY` | Currency sent and accepted | `ETB` |
| `IGCORE_DEFAULT_LANG` | Language when the player's isn't supported | `en` |
| `IGCORE_MAX_WIN_AMOUNT` / `IGCORE_MAX_TICKET_PAYOUT` | Caps above; `0` disables | `1000000` |
| `IGCORE_CALLBACK_DEBUG` | Log raw body and expected/received hash on signature failure | `false` |
| `IGCORE_SIMULATOR` | Mount the simulator (staging compose only) | `false` |

Dokploy's env panel is write-only and `compose-saveEnvironment` replaces the whole file
(Atlas-V playbook). The builder hands the user the exact lines to append; nobody writes
the env file programmatically.

## Shipping to staging

Winner staging is live at `staging.betbawa.bet` (API `staging-api.betbawa.bet`). Its build
dates from the shared `staging` branch (2026-09-30), which Arada staging also builds
from. Pushing the feature branch there would carry six Winner-only commits (theme, deposit
floor, round caps) plus the sportsbook onto Arada staging, so it is not done.

- **Branch.** Winner staging's Dokploy compose is pointed at its own branch,
  `staging/winner`, the same way Winner production was moved to `deploy/winner` on
  2026-10-16. The feature branch is pushed there. Nothing goes to `staging`, `main` or
  `deploy/winner`.
- **Brand row.** Winner staging's DB brand row still reads "Betbawa" with `themeId: arada`
  (`GET /brand`), so even a current build renders the Arada shell, which has no Sports
  item. The row is switched to `themeId: winner` from staging admin → Brand so the Winner
  chrome, and its Sports item, show.
- **Isolation.** `GET /brand` on staging and on Winner production return different rows
  ("Betbawa"/arada vs "Winner"/winner), which shows staging reads its own database. The
  builder still confirms `DATABASE_URL`/`REDIS_URL` differ before enabling the simulator,
  since the simulator mints credit.

## Testing

- Vitest, `apps/api/src/test/igcore-*.test.ts`: signature (including a body whose
  re-serialisation differs from the raw bytes), the client's token caching and single
  re-auth, every money rule above, every §7 OPERATOR→CLIENT item, two concurrent bets for
  one player, and route-level status codes via `fastify.inject`.
- Known local hazards (project memory): the local test DB was built with `db push`, so
  CHECK constraints and partial indexes from migration SQL may be missing; the API suite
  carries ~21 environmental failures, so judge results per file, not by exit code.
- On staging: the simulator's `/checklist` report, plus one clicked-through bet, win and
  rollback in the browser with balances checked.

## Onboarding form (draft for IGCORE, staging column)

| Field | Value |
|---|---|
| Server IP(s) we call from | `72.62.234.120` (to be confirmed as the Dokploy host's egress address) |
| Callback URL | `https://staging-api.betbawa.bet/v1/igcore` |
| Website URL | `https://staging.betbawa.bet` |
| Currencies | ETB |
| Languages | en, am |
| Account options | `info`, `ticketId`, `details`, `rollbackAction`, `sendLose` |

Production column, for later: callback `https://api.dash1.games/v1/igcore`, website
`https://winneret.cc`, same currency, languages and options.

## Risks and open items

- **Language codes.** IGCORE may not offer Amharic or may spell it differently; `en` is the
  fallback.
- **Framing.** IGCORE's iframe must allow being framed by our site; the website URL on the
  form is presumably what they allow-list. Check with the first real session.
- **Bonus stakes, real winnings.** Following the toggle means bonus money can produce real
  winnings on sports, where betting both sides of one match is a known abuse. The user
  chose this knowingly; wagering rules are the future mitigation.
- **Analytics reach.** Existing analytics may aggregate all third-party bets by provider,
  so sports bets show up there by default. The builder reports what picks them up.
  (Cashback is excluded explicitly, see Decisions.)
- **Egress IP.** IGCORE allow-lists our calling IP; confirm it from inside the API
  container before sending the form.

## Left to the builder

File layout inside `apps/api` (follow Atlas-V's split: gateway, signature module, wallet
service, routes), exact web component structure, the simulator page's look, test
organisation, and log wording.
