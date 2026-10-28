# IGCORE Sportsbook (Winner) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Winner players open a Sports page that embeds IGCORE's sportsbook, bets settle through a signed seamless-wallet protocol, and the whole thing is provable on Winner staging with a built-in IGCORE simulator before real credentials exist.

**Architecture:** Outbound `IgcoreClient` (auth + start-session, Redis-cached token) and inbound callback routes (`/v1/igcore/transaction`, `/v1/igcore/transaction-rollback`) verify an HMAC over raw bytes, then hand a parsed body to `IgcoreWalletService`, a close sibling of `AtlasVWalletService` (wallet row `FOR UPDATE`, `ThirdPartyTransaction` + `Transaction` double-write, idempotent on IGCORE `transaction_id`). A staging-only simulator plugin plays IGCORE's side over real HTTP and runs the go-live checklist. Web gets a flag-gated `/sports` page and a Sports item in the Winner shell only.

**Tech Stack:** Fastify 5, Prisma 5 / PostgreSQL, ioredis, vitest; Nuxt 3 (web, admin).

**Spec:** `docs/superpowers/specs/2026-10-28-igcore-sportsbook-design.md`. Protocol: `~/Downloads/IGCORE-Sportsbook-Integration-v3-final.pdf` (re-read it, not summaries).

**Worktree:** `.claude/worktrees/igcore-sportsbook`, branch `feat/igcore-sportsbook` off `origin/deploy/winner`. Already bootstrapped (install, shared-types/game-logic build, prisma generate, nuxt prepare).

## Global Constraints

- Arada must not change: never touch `apps/web/components/shells/arada/**`, `docker-compose.aradabingo*.yml`, `docker-compose.prod.yml`, `docker-compose.yml`. Never push `main`, `deploy/winner` or `staging`.
- Formatting: Prettier (singleQuote, no semi, trailingComma all). `apps/api` uses 4-space indent; web/admin 2-space. Match surrounding code.
- Money: `Decimal` from `@prisma/client/runtime/library`; every wallet change inside `prisma.$transaction` after `SELECT id, "realBalance", "bonusBalance", "spendAccount" FROM wallets WHERE "userId" = $1 FOR UPDATE`.
- Provider row: `code 'igcore'`, `name 'IGCORE Sportsbook'`, **`status 'INACTIVE'`**, `apiBaseUrl` = configured URL or `''`, `currency 'ETB'`, `config { kind: 'sportsbook' }`. Created by idempotent upsert on first use. (Deviation from the spec's `catalogSync:false`: the public provider list, lobby, catalog-sync worker and launch route all filter `status: 'ACTIVE'`, so INACTIVE keeps the row out of all four with no code change. The sportsbook's on/off is the `feature_sportsbook` flag, not provider status.)
- Ledger fields: `transactionId` = IGCORE `transaction_id`; `betId` = `String(info.ticketId)`; `roundId` = ticket **root** id (Task 4); `gameCode` = `'sportsbook'`; `rawRequest` = full parsed body.
- Player id: the bare 32-hex form `user.id.replace(/-/g, '')`. Not `accountForLaunch` (hub/spoke is out of scope; a hub prefix would break resolution).
- Callback answers, exact: success `{"error":null,"transaction_id":"<ThirdPartyTransaction.id>"}` HTTP 200; rejection `{"error":"<CODE>"}` HTTP 200; retry HTTP 500 `{"error":"RETRY"}`; bad signature HTTP 400 `{"error":"INVALID_SIGNATURE"}`; unparseable JSON HTTP 400 `{"error":"INVALID_JSON"}`.
- Rejection codes, exact: `PLAYER_NOT_FOUND`, `ACCOUNT_RESTRICTED`, `CURRENCY_NOT_SUPPORTED`, `INSUFFICIENT_FUNDS`, `FREEBETS_NOT_ENABLED`.
- Log tags, exact: `[igcore-fraud-flag]`, `[igcore-rollback-shortfall]`. Never log secrets or the session URL.
- Env vars (names exact): `IGCORE_API_URL`, `IGCORE_API_VERSION` (`1.0.0`), `IGCORE_USERNAME`, `IGCORE_PASSWORD`, `IGCORE_SECURITY_HASH`, `IGCORE_CURRENCY` (`ETB`), `IGCORE_DEFAULT_LANG` (`en`), `IGCORE_MAX_WIN_AMOUNT` (`1000000`), `IGCORE_MAX_TICKET_PAYOUT` (`1000000`), `IGCORE_CALLBACK_DEBUG` (`false`), `IGCORE_SIMULATOR` (`false`), `IGCORE_SIM_PUBLIC_URL`, `IGCORE_SIM_CALLBACK_URL`.
- Feature flag key: `feature_sportsbook`, default `'false'`.
- Tests: run single files with `pnpm --filter @world-bingo/api exec vitest run <file>`. The api suite has standing environmental failures; judge by the named file, never by suite exit code. DB tests (`*.db.test.ts`) use `import { prisma } from './setup'` and mock `../lib/redis.js` like `palace-wallet-settlement.db.test.ts`.

## Review Focus

1. Two identical callbacks racing (same `transaction_id`, parallel) → money moves once, both answer the same `transaction_id`. Test in Task 3.
2. A capped result retried after the cap is raised → applied exactly once, and a later duplicate answers the same id. Test in Task 4.
3. Rollback arriving before its bet, then the bet → no debit ever, bet answered as a duplicate. Test in Task 5.
4. Player flips real/bonus toggle between bet and its rollback → stake returns to the account it came from. Test in Task 5.
5. Body whose bytes differ from `JSON.stringify(JSON.parse(body))` (spaces, `25.0`, unicode) → still verifies, because the hash is over raw bytes. Tests in Task 1 and Task 6.

---

### Task 1: Config and callback signature

**Files:**
- Create: `apps/api/src/gateways/igcore/igcore-config.ts`, `apps/api/src/gateways/igcore/igcore-signature.ts`
- Test: `apps/api/src/test/igcore-signature.test.ts`

**Interfaces:**
- Produces:
  - `interface IgcoreConfig { apiUrl: string; apiVersion: string; username: string; password: string; securityHash: string; currency: string; defaultLang: string; maxWinAmount: number; maxTicketPayout: number; callbackDebug: boolean; simulator: boolean; simPublicUrl: string; simCallbackUrl: string }`
  - `igcoreConfig(): IgcoreConfig` — reads `process.env` on every call (no memo; tests stub env). `simCallbackUrl` default `http://127.0.0.1:${PORT ?? 8080}/v1/igcore`; `simPublicUrl` default `API_BASE_URL ?? ''`.
  - `igcoreConfigured(cfg?: IgcoreConfig): boolean` — true iff `apiUrl`, `username`, `password`, `securityHash` all non-empty.
  - `signIgcoreBody(raw: Buffer | string, secret: string): string` — lowercase hex HMAC-SHA256.
  - `verifyIgcoreSignature(raw: Buffer, header: string | undefined, secret: string): boolean` — false when secret empty, header missing, or lengths differ; else `crypto.timingSafeEqual`.

- [ ] **Step 1: Write the failing test** — `igcore-signature.test.ts`:
  - `signs the spec's way`: `signIgcoreBody('{"transaction_id":"t1","action":"bet","user_id":"89470","currency":"ETB","amount":25}', 'test-secret')` equals `'45b686a5454d69c503e8240e3dbc52ce60550e47292d3ce914d1411278e02b10'`.
  - `verifies raw bytes, not a re-serialisation`: raw `'{ "amount": 25.0, "name": "Ābebe" }'`; header = `signIgcoreBody(raw, s)`; `verifyIgcoreSignature(Buffer.from(raw), header, s)` is true, and `verifyIgcoreSignature(Buffer.from(JSON.stringify(JSON.parse(raw))), header, s)` is false.
  - `rejects`: wrong header, header of different length, `undefined` header, empty secret → all false.
  - `igcoreConfigured`: false with defaults; true after `vi.stubEnv` of the four required vars. `igcoreConfig().apiVersion === '1.0.0'`, `.currency === 'ETB'`, `.maxWinAmount === 1_000_000`.
- [ ] **Step 2: Run** `pnpm --filter @world-bingo/api exec vitest run src/test/igcore-signature.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** both modules as specified.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(api): IGCORE config and callback signature`

---

### Task 2: Outbound IgcoreClient

**Files:**
- Create: `apps/api/src/gateways/igcore/igcore.client.ts`
- Test: `apps/api/src/test/igcore-client.test.ts`

**Interfaces:**
- Consumes: `igcoreConfig()`, `igcoreConfigured()` (Task 1).
- Produces:
  - `class IgcoreApiError extends Error { readonly code: string }` — `code` is IGCORE's `error` string verbatim (e.g. `'invalid params'`, `'currency is not allowed'`, `'Unauthorized'`), or `'NOT_CONFIGURED'`, `'HTTP_<status>'`, `'NETWORK'`, `'BAD_RESPONSE'`.
  - `IgcoreClient.getToken(force?: boolean): Promise<string>`
  - `IgcoreClient.startSession(p: { userId: string; currency: string; lang?: string }): Promise<{ url: string }>`

Behaviour: base `${apiUrl without trailing /}/${apiVersion}`; every request `POST`, `Content-Type: application/json`, 10 s `AbortSignal.timeout`. Token cached in Redis key `igcore:token` with `setex` TTL `max(60, expires_in - 300)`. A body `{"error":"Unauthorized"}` → `redis.del('igcore:token')`, `getToken(true)`, repeat the request once; a second Unauthorized throws. Any other `error` throws `IgcoreApiError(error)`. A success without a string `url` throws `BAD_RESPONSE`.

- [ ] **Step 1: Write the failing test** (mock `../lib/redis.js` with an in-memory `get/setex/del`; `vi.stubGlobal('fetch', ...)`):
  - `caches the token`: two `startSession` calls → exactly one `/1.0.0/auth` fetch; `setex` called with `('igcore:token', 21300, 'tok1')` for `expires_in: 21600`.
  - `re-auths once on Unauthorized`: start-session answers `{"error":"Unauthorized"}` then `{"url":"https://sb/x"}` → returns `{ url: 'https://sb/x' }`, two auth calls total.
  - `gives up after a second Unauthorized`: rejects with `code === 'Unauthorized'`.
  - `surfaces operator errors`: `{"error":"currency is not allowed"}` → rejects with that code.
  - `sends the documented body`: start-session request body equals `{ user_id, currency, lang }` and carries `Authorization: Bearer tok1`.
  - `refuses when unconfigured`: no env → `NOT_CONFIGURED`, no fetch.
- [ ] **Step 2: Run** `... vitest run src/test/igcore-client.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `igcore.client.ts`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(api): IGCORE client with cached token`

---

### Task 3: Wallet service — shared helpers, bet, freebet

**Files:**
- Create: `apps/api/src/services/igcore-wallet.service.ts`
- Test: `apps/api/src/test/igcore-wallet.db.test.ts` (real DB; this file grows in Tasks 4–5)

**Interfaces:**
- Consumes: `igcoreConfig()` (Task 1); `BonusService.spend` / `.restore` (`services/bonus.service.ts`); `emitProviderBet` / `emitProviderWin` (`lib/posthog-events.js`); `NotificationService.pushWalletUpdate(userId, real, bonus)`.
- Produces:
  ```ts
  export interface IgcoreCallbackBody {
      transaction_id: string; action: 'bet' | 'result' | 'freebet' | 'rollback'
      user_id: string; currency: string; amount: number
      rollback_transaction_id?: string
      rollback_transaction_action?: 'bet' | 'freebet' | 'result'
      freebet?: Record<string, unknown>
      info?: { ticketId?: number; ticket?: { id?: number; fromId?: number | null }; newTicket?: { id?: number; fromId?: number | null } }
  }
  export type IgcoreOutcome =
      | { kind: 'ok'; transactionId: string; userId: string }
      | { kind: 'reject'; error: string }
      | { kind: 'retry'; reason: string }
  export async function getIgcoreProviderId(): Promise<string>  // memoized upsert, see Global Constraints
  export class IgcoreWalletService {
      static processBet(b: IgcoreCallbackBody): Promise<IgcoreOutcome>
      static processFreebet(b: IgcoreCallbackBody): Promise<IgcoreOutcome>
      static processResult(b: IgcoreCallbackBody): Promise<IgcoreOutcome>    // Task 4
      static processRollback(b: IgcoreCallbackBody): Promise<IgcoreOutcome>  // Task 5
      static dispatch(endpoint: 'transaction' | 'transaction-rollback', b: IgcoreCallbackBody): Promise<IgcoreOutcome>
      static async pushBalance(userId: string): Promise<void>  // read wallet, pushWalletUpdate; swallow errors
  }
  ```
  `dispatch`: `transaction` + `bet|result|freebet` → that handler; `transaction-rollback` + `rollback` → `processRollback`; any other pairing → `{ kind: 'reject', error: 'UNKNOWN_ACTION' }`. Exceptions propagate (the route turns them into 500).

Bet rules (spec "bet" table): resolve user from 32-hex `user_id` (same lookup + `tp:user:` Redis cache shape as `atlasv-wallet.service.ts`, but key `tp:user:igcore:<id>`); unknown → reject `PLAYER_NOT_FOUND` with no row; not ACTIVE → `ACCOUNT_RESTRICTED`; `currency !== cfg.currency` → `CURRENCY_NOT_SUPPORTED`. Duplicate `transaction_id`: COMPLETED or ROLLED_BACK row → `ok` with its `id`; FAILED row → reject with `rawResponse.error`. Debit exactly as `AtlasVWalletService.processBet` (BONUS via `BonusService.spend`, REAL via `wallet.update`), write `ThirdPartyTransaction` (`type BET`, `betAmount`, `amount = -stake`, `roundId` = root from Task 4's `resolveTicketRoot` — in this task use `String(info?.ticketId ?? b.transaction_id)` and Task 4 swaps it) and `Transaction` (`TP_BET`, `bonusBalanceBefore/After`, `bonusExpiresAtSpend`, `referenceId = transaction_id`, note `IGCORE sports bet: ticket <id>`). Insufficient → write a FAILED BET row with `amount 0`, `rawResponse { error: 'INSUFFICIENT_FUNDS' }`, reject `INSUFFICIENT_FUNDS`. Prisma `P2002` on create (a racing duplicate) → re-read the row and answer as a duplicate. Freebet: reject `FREEBETS_NOT_ENABLED`, no row. After commit: `emitProviderBet` (`providerCode 'igcore'`, `gameCode 'sportsbook'`) and `pushBalance`.

- [ ] **Step 1: Write the failing tests** in `igcore-wallet.db.test.ts` (fixture `createPlayer({ real, bonus?, spendAccount?, status? })` creates user + wallet; bonus via `BonusService.grant(tx, { userId, amount, source: <an existing BonusGrantSource> })`; `pid(user)` = `user.id.replace(/-/g,'')`; `bet(user, txId, amount, ticketId)` builds a body):
  - `bet debits the selected REAL balance once`: real 100 → `processBet` amount 25 → `ok`, real 75, one BET row `amount -25`, one `TP_BET` Transaction.
  - `bet spends bonus when the toggle says BONUS`: bonus 50, spendAccount BONUS, amount 20 → bonus 30, real unchanged, `TP_BET.bonusBalanceAfter` 30.
  - `insufficient funds rejects and leaves the balance`: real 10, amount 25 → `{ kind:'reject', error:'INSUFFICIENT_FUNDS' }`, real 10; repeating the same `transaction_id` rejects the same way.
  - `unknown player rejects without a record`: random 32-hex → `PLAYER_NOT_FOUND`, zero ThirdPartyTransaction rows.
  - `restricted and wrong-currency players are rejected`: `ACCOUNT_RESTRICTED`; `currency 'EUR'` → `CURRENCY_NOT_SUPPORTED`.
  - `duplicate bet answers the same id and moves nothing`: second call → same `transactionId`, real still 75.
  - `concurrent bets for one player serialise`: real 100, `Promise.all` of bets 60 and 60 (different ids) → exactly one `ok`, one `INSUFFICIENT_FUNDS`, real 40.
  - `racing identical bets apply once` (Review Focus 1): `Promise.all` of the same body twice → both `ok` with equal `transactionId`, real 75.
  - `freebet is refused`: `FREEBETS_NOT_ENABLED`, no row.
- [ ] **Step 2: Run** `... vitest run src/test/igcore-wallet.db.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** helpers, `processBet`, `processFreebet`, `dispatch`, `pushBalance`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(api): IGCORE bet handling`

---

### Task 4: Wallet service — result, ticket lineage, caps

**Files:**
- Modify: `apps/api/src/services/igcore-wallet.service.ts`
- Test: `apps/api/src/test/igcore-wallet.db.test.ts`

**Interfaces:**
- Produces (exported for tests): `resolveTicketRoot(tx, providerId: string, b: IgcoreCallbackBody): Promise<string>` — `fromId = info.ticket?.fromId ?? null`. If `fromId`: the `roundId` of any row with `betId = String(fromId)`, else `String(fromId)`. Otherwise the `roundId` of any row with `betId = String(info.ticketId)`, else `String(info.ticketId ?? transaction_id)`. Task 3's bet now uses it.

Result rules (spec "result" section): unknown player, not-our-currency, or any thrown error → `{ kind:'retry' }`. Account status never blocks. Duplicate: COMPLETED/ROLLED_BACK → `ok` same id. A FAILED row whose `rawResponse.held === 'CAP_EXCEEDED'` → re-evaluate under the lock (below) and **update that row** instead of creating one. `amount 0` → record a COMPLETED `BET_RESULT` with amount 0, `ok`. Otherwise:
1. Caps: `amount > cfg.maxWinAmount` (when > 0), or `amount + Σ(COMPLETED BET_RESULT amount on this root) > cfg.maxTicketPayout` (when > 0) → write (or keep) a FAILED `BET_RESULT` row, amount 0, `rawResponse { held: 'CAP_EXCEEDED' }`, log `[igcore-fraud-flag]`, answer `retry`.
2. Shortfall netting: `outstanding = Σ rollback rows' rawResponse.shortfall − Σ result rows' rawResponse.netted` on this root (fetch the root's rows, sum in JS with `Decimal`). `netted = min(amount, outstanding)`, `credit = amount − netted`.
3. Credit `credit` to **real**; `ThirdPartyTransaction` `BET_RESULT` COMPLETED, `winAmount = amount`, `amount = credit`, `rawResponse { netted }` when netted > 0; `Transaction` `TP_WIN` amount `credit` (skip the Transaction row when credit is 0).
4. No BET row on the root → still credit, log `[igcore-fraud-flag]` `result with no recorded bet`.
After commit: `emitProviderWin`, `pushBalance`.

- [ ] **Step 1: Write the failing tests:**
  - `result credits real even for a bonus-funded stake`: BONUS bet 20 on ticket 1 → result 50 → real +50, bonus unchanged.
  - `losing result is recorded and moves nothing`: result amount 0 → `ok`, one BET_RESULT amount 0, balances unchanged.
  - `duplicate result answers the same id`.
  - `unknown player asks for a retry`: `{ kind:'retry' }`, no row.
  - `result for a restricted player still pays`.
  - `per-callback cap holds the payout` with `vi.stubEnv('IGCORE_MAX_WIN_AMOUNT','100')`: result 150 → `retry`, FAILED row `rawResponse.held === 'CAP_EXCEEDED'`, real unchanged; retry with the same body → `retry` again, still one row.
  - `raised cap releases a held payout once` (Review Focus 2): after the above, stub `'1000'` → same body → `ok`, real +150, the same row now COMPLETED; third call → `ok`, same id, no further credit.
  - `per-ticket cap sums across results`: `IGCORE_MAX_TICKET_PAYOUT` 100, results 60 then 60 on one ticket → second is `retry`.
  - `partial-cashout remainder shares the root`: bet on ticket 10; result with `info { ticketId: 10, newTicket: { id: 11, fromId: 10 } }`; later result with `info { ticketId: 11, ticket: { id: 11, fromId: 10 } }` → its row's `roundId === '10'` and no fraud flag.
- [ ] **Step 2: Run** — expect FAIL on the new tests.
- [ ] **Step 3: Implement** `resolveTicketRoot`, `processResult`; switch bet to `resolveTicketRoot`.
- [ ] **Step 4: Run** — expect PASS (Task 3 tests included).
- [ ] **Step 5: Commit** `feat(api): IGCORE results with caps and ticket lineage`

---

### Task 5: Wallet service — rollback

**Files:**
- Modify: `apps/api/src/services/igcore-wallet.service.ts`
- Test: `apps/api/src/test/igcore-wallet.db.test.ts`

Rollback rules (spec "rollback" table). Failures of any kind → `retry`. Duplicate rollback `transaction_id` → `ok` same id. Original = row at `rollback_transaction_id`. Kind = `rollback_transaction_action` if present, else the original's type. Effects:
- BET COMPLETED → restore the stake split by the bet's `TP_BET` `bonusBalanceBefore − bonusBalanceAfter` (bonus part via `BonusService.restore` with `bonusExpiresAtSpend`, the rest to real) — same arithmetic as `AtlasVWalletService.processRollback`, regardless of the wallet's current toggle. Original → ROLLED_BACK. `Transaction` `TP_ROLLBACK` amount = stake.
- BET_RESULT COMPLETED → `debit = min(real, original.amount)`, `shortfall = original.amount − debit`; real −= debit; original → ROLLED_BACK; rollback row `amount = -debit`, `rawResponse { shortfall }` when > 0 plus `[igcore-rollback-shortfall]` log; `Transaction` `TP_ROLLBACK` amount = debit (skip when 0), note `IGCORE sports win reversed: ticket <id>`.
- BET_RESULT FAILED+held → move nothing, mark it ROLLED_BACK (it must never be released later).
- Original FAILED (rejected bet) or already ROLLED_BACK → move nothing.
- Not found → create the rollback row AND a placeholder at `rollback_transaction_id` (`type` BET for `bet`/`freebet`, BET_RESULT for `result`, ROLLBACK when unknown; status ROLLED_BACK; amount 0; `rawResponse { placeholder: true }`).
Every path writes the rollback row (`type ROLLBACK`, COMPLETED, `roundId` = original's `roundId` or root) and answers `ok` with its id.

- [ ] **Step 1: Write the failing tests:**
  - `rollback of a bet returns the stake`: real 100, bet 25, rollback → real 100, bet row ROLLED_BACK; repeat rollback → same id, real 100.
  - `stake goes back to the account it came from` (Review Focus 4): BONUS bet 20, flip wallet to REAL, rollback → bonus restored, real unchanged.
  - `rollback of a result then a corrected result`: bet 25 (real 75), result 62.5 (137.5), rollback → 75, new result 50 → 125.
  - `short rollback records the shortfall and nets the next result`: bet 25, result 62.5, set real to 10 directly (player withdrew), rollback → real 0, rollback row `rawResponse.shortfall` 52.5; corrected result 50 → credit 0, real 0; a further result 10 on the same root → credit 7.5.
  - `unknown original writes two records and moves nothing` (Review Focus 3): rollback for `rollback_transaction_id 'never-seen'` → `ok`, rows for both ids, balance unchanged; then a bet with `transaction_id 'never-seen'` → `ok` with the placeholder's id, balance still unchanged.
  - `rollback of a held result retires it`: held result (cap) → rollback → `ok`; raise cap and resend the result → `ok` with the held row's id and **no** credit.
- [ ] **Step 2: Run** — expect FAIL on the new tests.
- [ ] **Step 3: Implement** `processRollback`.
- [ ] **Step 4: Run** the whole file — expect PASS.
- [ ] **Step 5: Commit** `feat(api): IGCORE rollbacks`

---

### Task 6: Callback routes

**Files:**
- Create: `apps/api/src/routes/igcore/callback.ts`
- Modify: `apps/api/src/index.ts` (mount next to `atlasVCallbackRoutes`; add `if (req.url.startsWith('/v1/igcore')) return true` to the rate-limit `allowList` — the prefix covers `/v1/igcore-sim` too)
- Test: `apps/api/src/test/igcore-callback.test.ts`

**Interfaces:**
- Consumes: `verifyIgcoreSignature`, `igcoreConfig` (Task 1); `IgcoreWalletService.dispatch`, `IgcoreOutcome` (Task 3). Balance pushes and analytics happen inside the service after commit; the route only maps outcomes.
- Produces: `igcoreCallbackRoutes: FastifyPluginAsync`, registered with `{ prefix: '/v1/igcore' }`; routes `POST /transaction`, `POST /transaction-rollback`.

Route-scoped `addContentTypeParser('application/json', { parseAs: 'buffer' }, ...)` that keeps the Buffer (do not parse in the parser). Handler order: verify `X-Security-Hash` over the Buffer (fail → 400 `INVALID_SIGNATURE`; with `callbackDebug` log raw body + expected hash at warn) → `JSON.parse` (fail → 400 `INVALID_JSON`) → `dispatch` → map `ok` → 200 `{error:null, transaction_id}`, `reject` → 200 `{error}`, `retry` or thrown → 500 `{error:'RETRY'}` (log the error). Log every callback (`action`, `transaction_id`, outcome kind, ms) at info.

- [ ] **Step 1: Write the failing test** (mock `../services/igcore-wallet.service.js` `dispatch`; `vi.stubEnv('IGCORE_SECURITY_HASH','s')`; build app like `atlasv-callback.test.ts`):
  - `accepts a signed bet and answers the client id`: dispatch → `{kind:'ok', transactionId:'c-1', userId:'u'}` → 200 `{ error: null, transaction_id: 'c-1' }`.
  - `rejects a wrong hash with 400 and never dispatches`.
  - `verifies the raw bytes` (Review Focus 5): payload `'{"transaction_id":"t", "action":"bet","amount":25.0}'` signed as-is → dispatched.
  - `maps reject to 200 with the error`, `maps retry to 500`, `maps a thrown error to 500`.
  - `rollback endpoint dispatches as transaction-rollback`.
  - `bad JSON with a valid signature → 400 INVALID_JSON`.
- [ ] **Step 2: Run** `... vitest run src/test/igcore-callback.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the plugin and the two `index.ts` edits.
- [ ] **Step 4: Run** — expect PASS. Also `pnpm --filter @world-bingo/api typecheck` — expect no new `error TS` lines (the api typecheck is trustworthy).
- [ ] **Step 5: Commit** `feat(api): IGCORE callback endpoints`

---

### Task 7: Session endpoint and feature flag

**Files:**
- Create: `apps/api/src/routes/sportsbook/index.ts`
- Modify: `apps/api/src/routes/settings/index.ts` (`DEFAULTS.feature_sportsbook: 'false'`), `apps/api/src/index.ts` (register with `{ prefix: '/sportsbook' }`)
- Test: `apps/api/src/test/sportsbook-session.test.ts`

**Interfaces:**
- Consumes: `IgcoreClient.startSession`, `IgcoreApiError` (Task 2); `igcoreConfig`, `igcoreConfigured` (Task 1).
- Produces: `POST /sportsbook/session`, `preValidation: [fastify.authenticate]`, body `{ lang?: string }` → 200 `{ url }`. Flag off (`siteSetting feature_sportsbook !== 'true'`) or unconfigured or `IgcoreApiError` → 503 `{ code: 'SPORTSBOOK_UNAVAILABLE' }`. User not ACTIVE → 403 `{ code: 'ACCOUNT_RESTRICTED' }`. `lang` outside `['en','am']` → `cfg.defaultLang`. If IGCORE answers `invalid params` and `lang !== cfg.defaultLang`, retry once with `cfg.defaultLang`. `userId` = bare 32-hex id, `currency` = `cfg.currency`. Never log the URL.

- [ ] **Step 1: Write the failing test** (mock `IgcoreClient`, `prisma.siteSetting.findUnique`, `prisma.user.findUnique`; decorate a bare app with a stub `authenticate` that sets `req.user = { id: '<uuid>' }`):
  - `returns the session url`, and `startSession` called with `{ userId: '<uuid without dashes>', currency: 'ETB', lang: 'en' }`.
  - `503 when the flag is off`; `503 when unconfigured`; `503 when IGCORE errors`.
  - `403 for a restricted account`.
  - `falls back to the default language`: lang `'am'`, first call rejects `invalid params`, second called with `lang 'en'` → 200.
- [ ] **Step 2: Run** `... vitest run src/test/sportsbook-session.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** route, default, registration.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(api): sportsbook session endpoint behind feature_sportsbook`

---

### Task 8: Exclude sports from cashback

**Files:**
- Modify: `apps/api/src/services/cashback.service.ts` (`provider_rows` CTE in `getNetLossByUser`)
- Test: `apps/api/src/test/cashback.service.test.ts` (extend)

Add `AND tpt."providerId" NOT IN (SELECT id FROM game_providers WHERE code = 'igcore')` to the `provider_rows` WHERE, with a comment naming the reason (stakes are windowed by placement time; sports tickets straddle periods).

- [ ] **Step 1: Write the failing test** following the file's existing provider-loss fixture: an unscoped promotion, one casino provider loss of 100 and one `igcore` BET row of 100 in the window → the player's net loss is 100, not 200.
- [ ] **Step 2: Run** `... vitest run src/test/cashback.service.test.ts` — expect the new test FAIL, existing ones unchanged.
- [ ] **Step 3: Implement** the filter.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `fix(cashback): leave sportsbook stakes out of cashback`

---

### Task 9: Checklist runner and simulator

**Files:**
- Create: `apps/api/src/gateways/igcore/igcore-checklist.ts`, `apps/api/src/routes/igcore-sim/index.ts`, `apps/api/src/routes/igcore-sim/book-page.ts` (exports the HTML string builder)
- Modify: `apps/api/src/index.ts` (register `igcoreSimRoutes` at `/v1/igcore-sim` only when `igcoreConfig().simulator`; `server.log.warn('[igcore-sim] SIMULATOR ENABLED — staging only')`)
- Test: `apps/api/src/test/igcore-checklist.db.test.ts`, `apps/api/src/test/igcore-sim.test.ts`

**Interfaces:**
- Produces:
  - `interface ChecklistDeps { send(endpoint: 'transaction' | 'transaction-rollback', body: object, opts?: { badSignature?: boolean }): Promise<{ status: number; json: any }>; balance(): Promise<{ real: number; bonus: number }>; playerId: string; currency: string }`
  - `interface ChecklistResult { name: string; pass: boolean; detail: string }`
  - `runIgcoreChecklist(deps: ChecklistDeps): Promise<ChecklistResult[]>` — one entry per OPERATOR→CLIENT item of §7, names verbatim from the PDF; the freebet item becomes "freebet placement is refused while freebets are off". Uses unique `transaction_id`s (`crypto.randomUUID()`) and ticket ids per run. Assumes the player starts with real 100, bonus 0, toggle REAL. Each item records elapsed ms; the timing item fails when any bet answered in > 5000 ms or any result/rollback in > 10000 ms. "A result the CLIENT cannot process is answered with a 5xx": send a result for an unknown 32-hex player and require HTTP 500 (never 200); the "processed correctly on retry" half needs a transient fault that cannot be staged at runtime, so its `detail` names the db test `raised cap releases a held payout once` that covers it.
  - `igcoreSimRoutes: FastifyPluginAsync` with:
    - `POST /1.0.0/auth` — matches `cfg.username/password` → `{ token, expires_in: 21600 }` (token in Redis `igcore-sim:token:<t>`, TTL 21600) else `{ error: 'invalid credentials' }`.
    - `POST /1.0.0/start-session` — bad/missing Bearer → `{ error: 'Unauthorized' }`; `currency !== cfg.currency` → `{ error: 'currency is not allowed' }`; else store `igcore-sim:session:<uuid>` = `{ user_id, currency }` (TTL 21600) and answer `{ url: `${cfg.simPublicUrl}/v1/igcore-sim/book?s=<uuid>&lang=<lang>` }`.
    - `GET /book` — HTML from `book-page.ts`; overrides Helmet for this response: `reply.removeHeader('x-frame-options')` and `Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors *`.
    - `POST /book/action` `{ s, op, stake?, odds?, ticketId?, portion? }`, `op` ∈ `bet | settle-win | settle-lose | cashout | rollback-settlement | late-bet`; signs with `signIgcoreBody` and POSTs to `cfg.simCallbackUrl` over real HTTP; tickets kept in Redis `igcore-sim:ticket:<id>` (ids from `INCR igcore-sim:ticket-seq`); returns `{ sent, response }` so the page shows both. `late-bet` sends a bet then its rollback. `cashout` sends a result for `stake*odds*portion` with `info.newTicket { id: <new>, fromId }` and records the remainder ticket.
    - `POST /checklist` (`preValidation: [fastify.requireAdmin]`) — creates user `igcore-check-<timestamp>` with real 100, runs `runIgcoreChecklist` with `send` doing real HTTP to `cfg.simCallbackUrl`, returns `{ passed, failed, results }`.

- [ ] **Step 1: Write the failing tests:**
  - `igcore-checklist.db.test.ts`: register `igcoreCallbackRoutes` on a bare Fastify app; `send` uses `app.inject` with a real signature (or a wrong one when `badSignature`); `balance` reads the DB wallet. Expect every result `pass === true` and `results.length` equal to the number of §7 OPERATOR→CLIENT items (14).
  - `igcore-sim.test.ts` (Redis mocked in memory): auth with wrong password → `invalid credentials`; start-session without token → `Unauthorized`; with token and `USD` → `currency is not allowed`; with token and `ETB` → `url` starting with `cfg.simPublicUrl`; `GET /book` has no `x-frame-options` header and its CSP contains `frame-ancestors *`.
- [ ] **Step 2: Run** both files — expect FAIL.
- [ ] **Step 3: Implement** checklist, simulator, book page (plain HTML + inline JS: three fixed matches with odds, stake input, buttons per op, a log pane of sent/response JSON; no framework).
- [ ] **Step 4: Run** both — expect PASS.
- [ ] **Step 5: Commit** `feat(api): IGCORE simulator and go-live checklist runner`

---

### Task 10: Compose, env and onboarding form

**Files:**
- Modify: `docker-compose.betbawa.yml` (api service, after the `ATLASV_*` block: every `IGCORE_*` var except the three `SIM`/`SIMULATOR` ones, empty defaults except those with defaults in Global Constraints), `docker-compose.betbawa.staging.yml` (same, plus `IGCORE_SIMULATOR: ${IGCORE_SIMULATOR:-false}`, `IGCORE_SIM_PUBLIC_URL: ${IGCORE_SIM_PUBLIC_URL:-https://staging-api.betbawa.bet}`, `IGCORE_SIM_CALLBACK_URL: ${IGCORE_SIM_CALLBACK_URL:-}`), `apps/api/.env.example` (commented block)
- Create: `docs/igcore-onboarding.md` — the spec's onboarding table (staging and production columns, options `info`, `ticketId`, `details`, `rollbackAction`, `sendLose`), plus how to confirm the egress IP (`curl -s https://api.ipify.org` inside the api container) and the env lines to paste in Dokploy for simulator mode and for real IGCORE.
- Test: `apps/api/src/test/compose-guard.test.ts` (extend)

- [ ] **Step 1: Write the failing tests** in `compose-guard.test.ts` using its `serviceBlock` helper:
  - `IGCORE_SIMULATOR never reaches a production compose file`: absent from every `PROD_COMPOSE_FILES` entry.
  - `both Winner compose files forward the IGCORE vars`: `IGCORE_API_URL` and `IGCORE_SECURITY_HASH` inside the `api` service block of `docker-compose.betbawa.yml` and `docker-compose.betbawa.staging.yml`.
  - `Arada compose files carry no IGCORE vars`: `IGCORE_` absent from `docker-compose.aradabingo.yml`, `docker-compose.aradabingo.staging.yml`, `docker-compose.prod.yml`.
- [ ] **Step 2: Run** `... vitest run src/test/compose-guard.test.ts` — expect FAIL.
- [ ] **Step 3: Edit** the two compose files, `.env.example`, write `docs/igcore-onboarding.md`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `chore(deploy): forward IGCORE env on Winner, draft IGCORE onboarding form`

---

### Task 11: Admin toggle

**Files:**
- Modify: `apps/admin/pages/settings/features.vue` (three spots, mirroring `feature_prediction_market`: the defaults object, the load assignment, a new switch block after Prediction Market titled `Sportsbook`, description `Show the Sports tab on Winner and open IGCORE sessions. Needs IGCORE_* configured on the API; otherwise players see "unavailable".`)

- [ ] **Step 1:** Make the edit.
- [ ] **Step 2: Verify** `pnpm --filter @world-bingo/admin exec nuxi typecheck 2>&1 | grep features.vue` — the count of errors in `features.vue` is unchanged from before the edit (5 standing ones; run once before editing to record the baseline).
- [ ] **Step 3: Commit** `feat(admin): Sportsbook switch in Settings → Features`

---

### Task 12: Web Sports page and Winner nav

**Files:**
- Create: `apps/web/pages/sports.vue`
- Modify: `apps/web/composables/useAppShell.ts` (`sportsbookEnabled = computed(() => flags.value.feature_sportsbook === true)`, returned), `apps/web/components/shells/winner/Chrome.vue` (a `wn-tab` `NuxtLink to="/sports"` with label `Sports` right after Home, `v-if="sportsbookEnabled"`, a football SVG in the same stroke style), `apps/web/components/shells/winner/Rail.vue` (a `wn-rail-row` `to="/sports"` labelled `Sports` first in `wn-rail-list`, same `v-if`)
- Test: `apps/web/test/sports-page.test.ts`

Page behaviour: flag off → a plain "Sports is unavailable right now" state. Logged out → `<AuthPromptModal v-model="showAuthPrompt" />` opened on mount. Logged in → `auth.apiFetch<{ url: string }>('/sportsbook/session', { method: 'POST', body: { lang: locale } })` on mount, a loading state, then `<iframe :src="url" class="..." allow="fullscreen" />` filling the viewport below the shell's top bar (`height: calc(100dvh - <top bar height>)`, measure the Winner chrome). Error → the unavailable state with a Retry button that requests a fresh session. Never cache the URL (no store, no `useState`). Session `track('sportsbook_opened')` on success, `track('sportsbook_unavailable', { code })` on error.

- [ ] **Step 1: Write the failing test** (source-grep style, like `play-page.test.ts`):
  - page contains `'/sportsbook/session'`, `<iframe`, `:src="url"`, `AuthPromptModal`, `feature_sportsbook` or `sportsbookEnabled`, and `@click="retry"`.
  - `Chrome.vue` and `Rail.vue` each contain `to="/sports"` on an element with `v-if="sportsbookEnabled"`.
  - no file under `components/shells/arada/` contains `/sports`.
- [ ] **Step 2: Run** `pnpm --filter @world-bingo/web test -- sports-page` — expect FAIL.
- [ ] **Step 3: Implement** page, composable field, nav items.
- [ ] **Step 4: Run** `pnpm --filter @world-bingo/web test` — expect all pass (this gate is trustworthy), and `pnpm --filter @world-bingo/web typecheck 2>&1 | grep -c "error TS"` no higher than before the change.
- [ ] **Step 5: Commit** `feat(web): Sports page and Winner nav entry`

---

### Task 13: Ship to Winner staging and verify

Operational; needs the user for Dokploy env and branch settings (Dokploy env is write-only: never `compose-saveEnvironment`).

- [ ] **Step 1:** Run every `igcore-*`, `sportsbook-session`, `cashback.service` and `compose-guard` test file, plus `pnpm --filter @world-bingo/api typecheck` and `pnpm --filter @world-bingo/web test`. Record results.
- [ ] **Step 2:** Push the branch: `git push origin feat/igcore-sportsbook:refs/heads/staging/winner`.
- [ ] **Step 3:** User (or Dokploy MCP with the user's OK) points the Winner staging compose at branch `staging/winner`, and appends to its env: `IGCORE_SIMULATOR=true`, `IGCORE_API_URL=http://127.0.0.1:8080/v1/igcore-sim`, `IGCORE_USERNAME=sim_user`, `IGCORE_PASSWORD=sim_pass`, `IGCORE_SECURITY_HASH=<64 random hex>`, `IGCORE_SIM_PUBLIC_URL=https://staging-api.betbawa.bet`. Before that, confirm staging's `DATABASE_URL`/`REDIS_URL` are not Winner production's.
- [ ] **Step 4:** After deploy: staging admin → Brand → theme `winner`; Settings → Features → Sportsbook on.
- [ ] **Step 5:** Verify: `curl` `POST https://staging-api.betbawa.bet/v1/igcore-sim/checklist` with an admin token → `failed: 0`. In the browser at `staging.betbawa.bet`, log in as a test player, open Sports, place a bet, settle it as a win, roll it back; check the header balance and `/transactions` after each step. Screenshot.
- [ ] **Step 6:** Hand the user `docs/igcore-onboarding.md` with the confirmed egress IP, and report which existing analytics views now include `igcore` rows (spec "Analytics reach").
