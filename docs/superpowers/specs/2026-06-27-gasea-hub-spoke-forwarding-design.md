# GASea hub/spoke wallet-callback forwarding — Design

- **Date:** 2026-06-27
- **Status:** Approved (pre-implementation)
- **Author:** EyosiyasMekbib (with Claude Code)
- **Related:** Palace hub/spoke forwarding (the reference pattern); `docs/observability.md`; deployment topology (arada=hub `h00`, betbawa=spoke `btb`)

## Problem

GASea (the aggregator seamless-wallet provider) does not settle bets/wins on either brand in the hub/spoke topology:

- **arada (hub, `h00`):** game launch namespaces the GASea username to `h00<uuid-hex>` (35 chars), but the wallet-callback path (`ThirdPartyWalletService.resolveUser`) only recognises a **bare 32-hex** username. A namespaced username fails the `/^[0-9a-f]{32}$/` test and falls through to a literal `username` column lookup → `SC_USER_NOT_EXISTS`. So even the hub's own GASea callbacks fail. (Confirmed broken in production.)
- **betbawa (spoke, `btb`):** GASea uses a single merchant callback URL owned by the hub, so betbawa's callbacks arrive at arada carrying a `btb` prefix. arada neither de-namespaces nor forwards them → they resolve to `SC_USER_NOT_EXISTS` against arada's DB.

This is the exact bug Palace already fixed: Palace strips the prefix in `getUserCode` (local de-namespace) **and** forwards spoke-prefixed callbacks via `routes/palace/callback.ts` + `decideCallbackRoute`. GASea never received either fix.

## Goal

Make GASea wallet callbacks settle correctly for hub-local users **and** spoke users, mirroring the proven Palace forwarding, while reusing the existing provider-agnostic hub/spoke primitives.

## Non-goals

- No change to the GASea **launch** path — it already namespaces usernames correctly (`accountForLaunch` on the hub; the hub injects the spoke's code in `internal-provider.ts` for forwarded spoke launches).
- No change to the Palace flow.
- No new provider config model — the existing `DeploymentConfig` (`spokes` map, per-spoke `secret`, `hubSecret`) covers all providers.
- Not solving the latent separator-less 3-char prefix collision (documented as accepted risk; same as Palace).

## Background — what already exists (verified)

- **Launch already carries the deployment code.** `routes/game-provider/index.ts:137-138`: `bareAccount = user.id.replace(/-/g,'')`; `gaseaUsername = accountForLaunch(bareAccount)`. Hub → `h00<32hex>`; spoke → bare, then the hub's `internal-provider.ts:72` does `namespaceAccount(verifiedDep, username)` → `btb<32hex>`. GASea echoes this username back in every wallet callback.
- **GASea callbacks** (`routes/aggregator/wallet.ts`): 7 endpoints — `/balance`, `/bet`, `/bet_result`, `/rollback`, `/adjustment`, `/bet_debit`, `/bet_credit`. Each has a top-level `username` string, each `preHandler: [verifyGaseaSignature]`, each returns **HTTP 200** with a GASea `{traceId, status, data?}` body (non-200 = GASea retries). User is resolved **only** by `username`.
- **`resolveUser`** (`services/third-party-wallet.service.ts:139-167`): 32-hex → reconstruct UUID → `user.findUnique({id})`; else → `user.findUnique({username})`. No prefix strip. **This is the local bug.**
- **Reusable, provider-agnostic helpers:**
  - `gateways/hub/namespace.ts` — `namespaceAccount`, `parseNamespacedAccount` (3-char code, `MAX_ACCOUNT_LENGTH=40`, comment already references GASea's 3–40 username limit).
  - `gateways/hub/route-callback.ts` — `decideCallbackRoute(cfg, rawAccount)` → `{kind:'local'|'forward'|'unknown', account, spoke?}`. Pure; account-string in, route out.
  - `gateways/hub/hub-auth.ts` — `signBody(secret, raw)`, `verifySignature(secret, raw, sig)` (timing-safe), `DEPLOYMENT_HEADER='x-deployment'`, `SIGNATURE_HEADER='x-signature'`.
  - `gateways/hub/deployment-config.ts` — `DeploymentConfig` with `role`, `code`, `spokes: Map<code,{code,baseUrl,secret}>`, `hubUrl`, `hubSecret`.

## Design

### Component 1 — Shared dispatcher `dispatchGaseaWallet(command, body)`

Extract the per-command mapping currently inlined in the 7 route handlers into one function:

```
type GaseaCommand =
  'balance'|'bet'|'bet_result'|'rollback'|'adjustment'|'bet_debit'|'bet_credit'
function dispatchGaseaWallet(command, body): Promise<WalletCallbackResponse>
```

It switches on `command`, builds the typed params from `body`, and calls the matching `ThirdPartyWalletService` method. The username in `body` is assumed **bare** (de-namespaced) at this point. This is a pure refactor — behaviour identical to today for bare usernames. Both the hub-local path and the spoke receiver call it, so the command→method mapping lives in exactly one place.

### Component 2 — Hub routing in the aggregator wallet route

`routes/aggregator/wallet.ts` stays mounted for all roles (as today). Each of the 7 handlers, after `verifyGaseaSignature`, calls a single shared entrypoint:

```
async function handleGaseaCallback(command, body): Promise<WalletCallbackResponse> {
  const cfg = deploymentConfig()
  if (cfg.role !== 'hub') {
    // standalone + spoke: settle locally exactly as today (username already bare on standalone;
    // on a spoke the public route is dormant — GASea calls the hub, not the spoke).
    return dispatchGaseaWallet(command, body)
  }
  const original = body.username
  const route = decideCallbackRoute(cfg, original)   // reused, provider-agnostic
  if (route.kind === 'forward') {
    const res = await forwardToSpoke(route.spoke, command, { ...body, username: route.account })
    return reNamespaceUsername(res, original)
  }
  // 'local' (own h00 → bare) or 'unknown' (raw) → settle locally, then echo original username
  const res = await dispatchGaseaWallet(command, { ...body, username: route.account })
  return reNamespaceUsername(res, original)
}
```

- `route.account` is the **de-namespaced** username for `local` (fixes arada) and the bare username for `forward` (fixes betbawa); for `unknown` it's the raw string (cert/test usernames — same fallback Palace uses).
- `reNamespaceUsername(res, original)` sets `res.data.username = original` when `res.data` exists, so GASea always sees the username it sent.

### Component 3 — `forwardToSpoke(spoke, command, body)`

```
const rawForwardBody = JSON.stringify({ command, body })
const sig = signBody(spoke.secret, rawForwardBody)
POST `${spoke.baseUrl}/v1/hub/gasea-callback`
  headers: { 'content-type': 'application/json',
             [DEPLOYMENT_HEADER]: cfg.code, [SIGNATURE_HEADER]: sig }
  body: rawForwardBody
  signal: AbortController (timeout = PALACE_SPOKE_TIMEOUT_MS, default 5000)
```

- Non-2xx, abort, network error, or non-JSON → return `err(body.traceId, 'SC_INTERNAL_ERROR')` so GASea retries (never a fabricated success).
- Success → return the spoke's parsed JSON verbatim (then Component 2 re-namespaces the echoed username).

### Component 4 — Spoke receiver `/v1/hub/gasea-callback`

New route, mounted **only when `role==='spoke'`** (gated in `index.ts`, beside the Palace `spoke-callback` registration). Mirrors `routes/hub/spoke-callback.ts`:

- Raw-body `application/json` content-type parser captures `__rawBody` (byte-exact) for HMAC.
- Verify: `sig` + `dep` headers present and `verifySignature(cfg.hubSecret, raw, sig)` → else HTTP 401 `{traceId, status:'SC_INVALID_SIGNATURE'}`.
- On pass: `dispatchGaseaWallet(command, body)` (username already bare) → HTTP 200 with the GASea-shaped response.
- Catch → HTTP 200 `{traceId, status:'SC_INTERNAL_ERROR'}` (the hub maps this leg's failures into a GASea retry).

The spoke verifies **only the hub's HMAC**, never GASea's signature — so the spoke is fully shielded from GASea's non-canonical serialization (the fragile multi-variant fallback in `signature.middleware.ts` stays hub-only).

### Component 5 — Local de-namespace (the arada fix)

Achieved entirely by Component 2 passing `route.account` (bare) into `dispatchGaseaWallet`. No change to `resolveUser` itself is required — though optionally `resolveUser` could also strip a known-code prefix defensively. **Decision:** keep the strip in the routing layer only (single responsibility; `resolveUser` stays a pure bare-username resolver), matching how the spoke receiver also feeds it bare usernames.

## Data flow

**Hub-local user (arada `h00`):**
```
GASea → POST /v1/aggregator/wallet/bet (username=h00<hex>, X-Signature=GASea HMAC)
  verifyGaseaSignature ✓
  decideCallbackRoute → {local, account:<hex>}
  dispatchGaseaWallet('bet', {…, username:<hex>}) → settle in arada DB
  reNamespace → data.username = h00<hex>
→ 200 {traceId, status:SC_OK, data:{username:h00<hex>, balance…}}
```

**Spoke user (betbawa `btb`):**
```
GASea → POST arada /v1/aggregator/wallet/bet (username=btb<hex>, X-Signature=GASea HMAC)
  verifyGaseaSignature ✓
  decideCallbackRoute → {forward, account:<hex>, spoke:btb}
  forwardToSpoke → POST betbawa /v1/hub/gasea-callback
       body {command:'bet', body:{…, username:<hex>}}, x-signature=HMAC(btb.secret)
    betbawa: verifySignature(hubSecret) ✓ → dispatchGaseaWallet('bet', {…username:<hex>}) → settle in betbawa DB
    → 200 {traceId, status:SC_OK, data:{username:<hex>, balance…}}
  relay + reNamespace → data.username = btb<hex>
→ 200 {…, data:{username:btb<hex>, balance…}}  (to GASea)
```

## Error & HTTP semantics

- All legs facing GASea return **HTTP 200**; success/failure is in the `status` field. Non-`SC_OK` statuses pass through verbatim from the settling node.
- Forward-leg failure (spoke down, 401, timeout, non-JSON) → `SC_INTERNAL_ERROR` → GASea retries. Never fabricate `SC_OK`.
- Spoke-receiver bad signature → HTTP 401 (hub treats non-200 as failure → `SC_INTERNAL_ERROR` to GASea → retry).

## Security

- Inbound GASea→hub authenticity: existing `verifyGaseaSignature` (`GASEA_API_SECRET`, over GASea raw bytes) — unchanged, runs before routing.
- Hub→spoke authenticity: `signBody(spoke.secret,…)` / `verifySignature(cfg.hubSecret,…)` — same shared-secret pair already used for Palace and the launch leg (`HUB_SHARED_SECRET` on the spoke == that spoke's `secret` in the hub's `HUB_DEPLOYMENTS`).
- The spoke never holds or verifies GASea credentials for callbacks; GASea creds on a spoke are unused (launch is forwarded via `RemoteGameProviderGateway`).

## Testing

Unit (Vitest), no network:
1. `dispatchGaseaWallet` — each of the 7 commands maps to the correct service method with correct params (table test).
2. Routing: `decideCallbackRoute` integration for `local`/`forward`/`unknown` with a `btb` spoke configured.
3. **Regression (arada bug):** an `h00<hex>` callback on a hub resolves the local user and settles (would have returned `SC_USER_NOT_EXISTS` before).
4. Forward leg: re-sign with `spoke.secret`, correct target URL/headers, response relayed, `data.username` re-namespaced to the original.
5. Spoke receiver: valid hub HMAC dispatches; missing/invalid sig → 401; dispatch error → 200 `SC_INTERNAL_ERROR`.
6. Forward failure (mock fetch reject / non-200 / non-JSON / timeout) → `SC_INTERNAL_ERROR`, never `SC_OK`.
7. Username echo: hub-local response echoes the original namespaced username.

## Operational requirements (deploy-time, not code)

1. **GASea dashboard callback URL must be the hub:** `https://api.aradabingo.bet/v1/aggregator/wallet`. If currently set to betbawa, move it to arada (single shared GASea merchant account = one callback URL).
2. **Rate-limit allowlist:** confirm `/v1/hub/*` is exempt from the 100/min limiter (it shares this need with the existing Palace `/v1/hub/spoke-callback`). If not, add `/v1/hub/` to the allowlist so server-to-server forwards aren't throttled mid-session.
3. **Optional hygiene:** remove now-unused `GASEA_API_KEY`/`GASEA_API_SECRET` from betbawa's env (the spoke forwards launches via the hub and never instantiates `GaseaGateway`). Not required for correctness.
4. Both apps redeploy to pick up the new code (and the spoke route mount is gated on `role`, which is read once at boot).

## Accepted risks

- **3-char prefix collision (latent, pre-existing):** namespacing is separator-less, so a bare username whose first 3 chars equal a real spoke code would mis-route. Usernames are 32-hex UUIDs, so this needs the first 3 hex to equal a spoke code (e.g. spoke code `btb` is non-hex → safe; an all-hex spoke code like `abc`/`def`/`b0b` would be at risk). **Mitigation/convention:** allocate spoke `DEPLOYMENT_CODE`s containing at least one non-hex letter (g–z). Same risk Palace already carries; not introduced here.

## Files to touch

- `apps/api/src/routes/aggregator/wallet.ts` — add hub routing layer; route 7 handlers through `handleGaseaCallback`.
- `apps/api/src/services/gasea-wallet-dispatch.ts` *(new)* — `dispatchGaseaWallet(command, body)` shared command→service mapping.
- `apps/api/src/routes/hub/gasea-callback.ts` *(new)* — spoke receiver, hub-HMAC verified.
- `apps/api/src/gateways/hub/gasea-forward.ts` *(new)* — `forwardToSpoke` + `reNamespaceUsername` (hub-side forwarding helpers, beside `route-callback.ts`).
- `apps/api/src/index.ts` — register `gasea-callback` route gated on `role==='spoke'`; (verify rate-limit allowlist covers `/v1/hub/`).
- `apps/api/src/test/gasea-hub-spoke.test.ts` *(new)* — the test plan above.
- Reused unchanged: `gateways/hub/{namespace,route-callback,hub-auth,deployment-config}.ts`.
