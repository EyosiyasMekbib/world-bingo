# Atlas-V provider integration

**Date:** 2026-09-09
**Status:** approved
**Scope:** integrate Atlas-V (game code `penalty`, more may follow) as a new
third-party game provider, full API surface from the Atlas-V API
Documentation PDF (init, account, bet, betwin, result, rollback, freespin
create + result, jackpot). No frontend changes — the existing generic
`/providers/*` lobby/search/launch UI picks it up automatically once seeded.

## Problem

World-bingo already integrates two casino-game aggregators, Palace and
GASea, through a shared `GameProviderGateway` interface + registry
(`gateways/game-provider/index.ts`) plus a per-provider inbound wallet
callback (`routes/palace/callback.ts` + `PalaceWalletService`). Atlas-V is a
third provider with its own protocol: a single launch call (`/init`), and
**one URL per wallet action** instead of Palace's single dispatch-by-command
endpoint, authenticated by a per-request `sha1(body + PRIVATE_KEY +
timestamp)` hash embedded in the JSON body rather than a header signature
or static token.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Outbound shape | New `AtlasVGateway implements GameProviderGateway` | `getGameUrl` calls `/init`; `terminateSession` no-ops (no such endpoint in the spec, same as Palace); `getTransactions`/`getTransactionDetail` throw `NOT_SUPPORTED` (no reporting endpoint documented) |
| Inbound shape | 6 new Fastify routes under `/v1/atlasv/callback/*`, not one dispatch endpoint | Atlas-V's spec gives each action (`/account`, `/bet`, `/betwin`, `/result`, `/rollback`, `/freespin`) its own URL — mirroring Palace's single-command-field dispatch would fight the spec instead of matching it |
| Wallet logic | New `AtlasVWalletService`, structurally a close copy of `PalaceWalletService` | Same `SELECT FOR UPDATE` locking, same `ThirdPartyTransaction` + `Transaction` double-write, same idempotency key `(providerId, transactionId)`, same bonus-vs-real spend-account handling, same rollback-once guard — no reason to invent a different shape |
| Catalog | Static seed row(s) in `prisma/seed.ts` (just `penalty` initially), not synced from a live listing API | Atlas-V's spec has no vendor/game-list endpoint, unlike GASea/Palace |
| Catalog-sync worker | `GameProviderGateway` gains an optional `catalogSyncSupported = true` property; `GameCatalogService.syncAll` skips (logs info, no error) when false | The 6-hourly worker (`workers/game-catalog-sync.worker.ts:34`) loops every `ACTIVE` provider and already tolerates a per-provider failure via `.catch()`, but that would otherwise log a real error forever for a provider that will never have a listing endpoint |
| Signature (outbound) | `sha1(JSON.stringify(bodyWithoutHash) + PRIVATE_KEY + timestamp)`, we control field order | Unambiguous — we build the body ourselves |
| Signature (inbound) | Raw-capture the request text (same `addContentTypeParser` pattern as `routes/zarecash/webhook.ts:24`), `JSON.parse` it, destructure off `hash`, `JSON.stringify` the rest, hash that | The spec's "REQUEST_BODY" is ambiguous once `hash` is itself a body field. This is the standard convention for this class of aggregator API and preserves the sender's exact key order/formatting since it round-trips through the same parser. **Not guaranteed correct until validated against real Atlas-V staging traffic** — see Risks. |
| Signature mismatch handling | Log raw body + expected/received hash when `ATLASV_CALLBACK_DEBUG=true`, same spirit as `GASEA_SIGNATURE_DEBUG` | Fast to diagnose against real traffic without pre-building GASea's elaborate brute-force fallback (that was retrofitted after real production pain; nothing here has been observed yet — YAGNI) |
| Content-Type | Route-scoped `addContentTypeParser('text/javascript', ...)` | Atlas-V's spec mandates `Content-Type: text/javascript` on every request, which Fastify won't parse as JSON by default |
| Response envelope on error | Always HTTP 200, with a best-effort valid-shaped body (`{success:false}` or the last-known balance) | The spec only documents success responses. Palace and GASea both mandate "always 200, provider retries on non-200" — safest default assumption until Atlas-V support says otherwise |
| `/betwin` ledger row | One `ThirdPartyTransaction` row, `type: BET_RESULT`, both `betAmount` and `winAmount` populated, `amount` = net (`winAmount - betAmount`) | The schema already carries both fields for exactly this combined case (schema.prisma:766-768); `/betwin` sends one `transaction_id` for the whole operation, so one idempotency row is correct, not two |
| `/result` (round result) | Looks up the prior `BET` row via `bet_transaction_id`, credits `amount`, requires the prior bet to exist | Mirrors Palace's rollback guard (`palace-wallet.service.ts:467-495`): never credit a win with no matching debit on record |
| player_id / account | Same `accountForLaunch(user.id.replace(/-/g,''))` UUID-hex convention already used for Palace/GASea (`routes/game-provider/account-for-launch.ts`) | The spec says `player_id` is "provided by client" — i.e. **we** choose the value at `/init` time, so reusing the existing convention needs no new mapping table |
| Fraud guards on win-crediting paths | Same env-gated `MAX_WIN_AMOUNT`/`MAX_WIN_MULTIPLE` caps as Palace, but no `REQUIRE_BET_FOR_WIN` equivalent forced on | Atlas-V signs every request body per-call (stronger than Palace's unsigned callbacks), so the caps are defense-in-depth, not the primary protection |
| Hub/spoke | Launch + all 6 callback routes get the same hub-forward-or-local dance as Palace (`decideCallbackRoute`), factored into one shared helper instead of copy-pasted 6 times | Palace only needed this once (one endpoint); Atlas-V needs it 6 times, so a shared helper avoids real duplication |
| Freespin admin trigger | One new route, `POST /admin/game-providers/atlasv/freespins` (`routes/admin/atlasv.ts`, new file, same split-file convention as `admin/analytics.ts`/`admin/crm.ts`) | Calls `AtlasVGateway.createFreeSpins()`. No new admin Vue page in this pass — callable via Swagger/curl only |
| Freespin admin trigger + hub/spoke | Hub/standalone only for v1 | Keeps v1 scoped; spoke-forwarding for this one action can follow if needed |
| Frontend | No changes | Confirmed: `/providers/*` lobby, search, and `/play/[providerCode]/[gameCode]` launch+iframe (`apps/web/pages/play/[providerCode]/[gameCode].vue:52-59,105-113`) are 100% generic on `providerCode`/`gameCode`; no CSP/domain allow-list exists anywhere (`apps/api` Helmet CSP only covers the API's own JSON responses, not the Nuxt app); no provider-name branching in `apps/web`/`apps/admin` source |

## Data model

No schema migration. Reuses as-is:
`GameProvider`, `GameVendor`, `ProviderGame`, `ProviderUserAccount`,
`ThirdPartyTransaction`, `ThirdPartyTxType`, `ThirdPartyTxStatus`
(schema.prisma:643-780).

One new optional field on the gateway interface (TypeScript only, not DB):

```ts
// game-provider.interface.ts
export interface GameProviderGateway {
  readonly providerCode: string
  readonly catalogSyncSupported?: boolean // default true when omitted
  // ...existing methods unchanged
}
```

Seed additions (`prisma/seed.ts`, same upsert pattern as GASea/Palace at
lines 160-191):
- `GameProvider` row, `code: 'atlasv'`, `apiBaseUrl: ATLASV_SERVER_URL`,
  `currency: ATLASV_DEFAULT_CURRENCY ?? 'ETB'`
- One `GameVendor` row (Atlas-V has no vendor concept upstream; a single
  synthetic vendor row is required because `ProviderGame.vendorId` is a
  required FK) — `code: 'atlasv-default'`
- One `ProviderGame` row, `gameCode: 'penalty'`, `categoryCode: 'ARCADE'`
  (adjust once we know how Atlas-V wants it categorized in the lobby)

## Endpoint map

Outbound (world-bingo → Atlas-V), in `AtlasVGateway`:

| Gateway method | Atlas-V endpoint | Notes |
|---|---|---|
| `getGameUrl(params)` | `POST {ATLASV_SERVER_URL}/init` | `player_id` = `params.username` (already the UUID-hex account); returns `{ gameUrl: data.url, token: '' }` — no separate session token in this spec |
| `createFreeSpins(playerId, endDate, count)` (Atlas-V-specific, not part of the shared interface) | `POST {ATLASV_GAME_SERVER_URL}/freespin` | Called only from the new admin route |
| `terminateSession` | — | no-op |
| `getTransactions`/`getTransactionDetail` | — | throw, not called anywhere that isn't already `.catch()`-guarded |

Inbound (Atlas-V → world-bingo), in `routes/atlasv/callback.ts`,
dispatching to `AtlasVWalletService`:

| Route | Atlas-V doc section | Wallet service method | Response |
|---|---|---|---|
| `POST /v1/atlasv/callback/account` | GET USER DATA | `getAccount` | `{ player_id, balance }` |
| `POST /v1/atlasv/callback/bet` | BET | `processBet` | `{ player_id, balance }` |
| `POST /v1/atlasv/callback/betwin` | BET and WIN | `processBetWin` | `{ player_id, balance }` |
| `POST /v1/atlasv/callback/result` | ROUND RESULT | `processResult` | `{ success: true }` |
| `POST /v1/atlasv/callback/rollback` | ROLLBACK | `processRollback` | `{ success: true }` |
| `POST /v1/atlasv/callback/freespin` | FREE SPIN/BET RESULT | `processFreespinResult` | `{ success: true }` |
| `POST /v1/atlasv/callback/jackpot` | JACKPOT | `processJackpot` | `{ success: true }` |

All idempotent on `(providerId, transaction_id)`; a replay returns the
current balance/success instead of re-applying the ledger change, same as
every Palace handler already does.

## Env vars

Added to `apps/api/.env.example` and root `.env.example` (values left
empty until real staging values are supplied):

```
ATLASV_SERVER_URL=          # base URL for /init (casino → game server)
ATLASV_GAME_SERVER_URL=     # base URL for /freespin creation (may be the same host)
ATLASV_PRIVATE_KEY=
ATLASV_CASINO_ID=
ATLASV_PARTNER_ID=1         # 1 for a single casino, unique per casino for aggregators
ATLASV_DEFAULT_CURRENCY=ETB
ATLASV_DEFAULT_LANGUAGE=en
ATLASV_CALLBACK_DEBUG=false
ATLASV_MAX_WIN_AMOUNT=1000000
ATLASV_MAX_WIN_MULTIPLE=20000
```

## Testing

- `atlasv-wallet.service.test.ts` (new): mirrors the shape of existing
  wallet-service tests — bet debits, betwin nets correctly, result credits
  only against a real prior bet, rollback refunds exactly once, replay
  returns cached balance, insufficient-balance path, bonus-vs-real spend
  split.
- `atlasv-signature` unit tests: sign → verify round-trip, tampered body
  rejected, missing/stale timestamp rejected.
- Route-level test hitting `/v1/atlasv/callback/bet` with a real computed
  hash end-to-end.

## Risks / open items

1. **Inbound hash canonicalization is a documented assumption, not a
   confirmed fact.** The PDF doesn't specify how `hash` is computed once
   it's a body field. First real staging callback may fail signature
   verification — the debug-log path exists specifically to make that a
   fast fix rather than a mystery.
2. **`ATLASV_SERVER_URL` vs `ATLASV_GAME_SERVER_URL`** — the spec's example
   uses two different placeholder hostnames (`ATLAS_SERVER` for `/init`,
   `GAME_SERVER` for freespin creation and all wallet-callback URLs the
   *client* must expose). Modeled as two separate env vars; if the real
   staging values turn out to be the same host, one can just be set to
   the same value as the other.
3. **Failure response envelope is inferred**, not documented — no error
   code table like Palace's `result` codes. Will very likely need
   adjustment once we see how Atlas-V's staging environment actually
   behaves on a rejected request.
