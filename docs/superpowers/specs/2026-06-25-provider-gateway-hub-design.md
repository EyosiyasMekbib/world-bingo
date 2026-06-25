# Provider Gateway Hub — Design

**Date:** 2026-06-25
**Status:** Approved (design), pending implementation plan
**Scope:** Let multiple independent deployments of World Bingo share a single upstream
provider account (game providers like Palace/Gasea first, payment providers and any
future provider next) by routing all provider traffic through one elected deployment.

## Problem

We run **multiple deployments**, some co-located, some on different servers. Each
deployment has its **own database and its own `user` table**. We want them to share a
single upstream provider account.

Upstream providers (Palace today) impose constraints that break naive multi-deployment use:

- The provider account exposes **one API token** and **one registered callback URL**.
- The provider identifies a player by an identifier **it echoes back on every callback**
  (Palace: `username`). Each deployment resolves that identifier against its **own** DB.
- Usernames / `user_code`s can **collide across deployments** (assume collisions possible —
  deployments manage username space independently).

So a callback arriving at one URL cannot, by itself, be attributed to the correct
deployment, and identifiers are not globally unique.

## Approach: elected hub, provider-agnostic routing

One existing deployment is elected the **hub**. It owns the provider credentials and the
single callback URL, and routes provider traffic for all other deployments (**spokes**).
The hub is also a normal deployment serving its own players — it is both router and a
participant. No new standalone service is introduced.

The design is **provider-agnostic**: Palace is the first adapter; payment providers and
future providers plug in via the same machinery.

### Topology & roles

```
                 ┌───────────────────────────────┐
   Provider ◄───►│  HUB  (one existing deployment)│
 (1 account,     │  - owns API token(s)          │
  1 callback URL)│  - owns callback token(s)     │
                 │  - namespaces identities       │
                 │  - routes callbacks to spokes  │
                 │  - also serves its OWN players │
                 └──────┬─────────────┬───────────┘
                        │ internal API (shared secret, HMAC)
            ┌───────────▼──┐      ┌───▼───────────┐
            │  SPOKE dep2   │      │  SPOKE dep3   │  ...
            │  own DB/users │      │  own DB/users │
            └───────────────┘      └───────────────┘
```

- **Provider knows only the hub** — one callback URL, one API token, used only by the hub.
- **Spokes never call the provider directly.** They call the hub's internal provider API.
- **The hub is also a deployment**; its own players take a local shortcut (no HTTP hop).

### The routing key (the unifying principle)

Routing works because **the hub controls the identifier the provider echoes back, and
embeds the deployment code in it.** Which field carries that identity differs per provider:

| Provider type | Field the hub namespaces | Inbound routing |
|---|---|---|
| Game (Palace/Gasea) | `username` → `d03_alice` | parse prefix from callback `username` |
| Payment | the order/merchant **reference** the hub generates → `d03_<orderid>` | parse prefix from callback reference |
| Future provider | whatever field it echoes | same pattern |

Each upstream gets a small **router adapter** implementing two hooks:

- `namespace(outbound)` — inject the deployment code into the routable field.
- `routeOf(callback) → deploymentCode` — extract the deployment code from an inbound callback.

Everything else (credentials, transport, registry, auth, SPOF handling) is shared hub
machinery. This abstraction is justified because more providers are planned.

**Delimiter / charset:** the prefix scheme (e.g. `d03_alice`) must respect each provider's
allowed identifier charset. To be validated per provider during implementation; default to
a fixed, parseable scheme (deployment code + separator) that survives the provider's
username/reference rules.

### Identity namespacing rules

- **The hub injects the prefix**, derived from the **authenticated** caller's deployment
  code — never from caller-supplied data. A spoke cannot spoof another deployment's namespace.
- On callback, the hub parses the prefix, **strips it**, and forwards the bare identifier
  (e.g. `alice`) to the owning spoke's existing callback handler, which resolves it against
  its own DB exactly as today. **Spoke code barely changes.**
- `user_code` collisions vanish because the upstream identifier is globally unique per
  deployment.

### Outbound path (spoke → hub → provider)

1. Hub exposes an **internal provider API**, one namespaced route group per provider,
   mirroring the existing gateway interfaces (`getGameUrl`, `getUserCode`, payment
   `initiateDeposit`, etc.).
2. Spoke's gateway implementation is a **thin remote client** (`remote.gateway.ts`) that
   forwards the call to the hub with a shared-secret auth header identifying the spoke.
3. Hub looks up the caller's deployment code, **injects the namespace**, calls the real
   provider with its credentials, returns the result.
4. The hub's **own** players bypass the HTTP hop via a local shortcut.

### Inbound callback path (provider → hub → spoke)

1. Provider hits the hub's **single callback URL**; hub verifies the provider's callback
   token (as `palace-callback.middleware.ts` does today).
2. Hub runs the provider's `routeOf()` to get the deployment code, **strips the prefix**,
   and forwards the de-namespaced callback to the owning spoke's existing callback endpoint
   (internal auth).
3. Spoke runs its current wallet logic against its own DB and returns the provider-format
   response; hub relays it **verbatim** to the provider.
4. If the spoke is unreachable, hub returns a **non-200** so the provider retries — no
   fabricated success, no lost debit/credit.

### Hub↔spoke registry & auth

- **Static registry** on the hub: `deploymentCode → { baseUrl, sharedSecret, enabled }`
  (config table or env-backed JSON). Few deployments, rarely changing — no dynamic service
  discovery (YAGNI).
- Each spoke holds its own `deploymentCode`, `sharedSecret`, and the hub's URL.
- **Mutual, symmetric auth:** spoke→hub calls carry `X-Deployment` + HMAC of the body with
  the shared secret; hub→spoke callbacks carry the same. The hub derives the namespace from
  the **authenticated** `X-Deployment`, never from caller-supplied data.
- Per-deployment secrets: rotating/revoking one spoke does not touch the others.

### Failure modes & SPOF

The hub is an accepted critical path for provider features. Blast-radius containment:

- **Hub down →** only provider features (launch game, deposits/withdrawals) degrade; core
  bingo on every spoke keeps running — spokes do not depend on the hub for their own game engine.
- **Spoke down →** hub returns non-200 to the provider, which retries; no money moves until
  the spoke is back. Existing `thirdPartyTransaction` unique key makes retries idempotent.
- **Hub forwarding fails mid-callback →** non-200, provider retries. Never fabricate a wallet response.
- **Timeouts:** hub→spoke calls use a tight timeout + a couple of bounded retries before
  giving up to the provider.
- **Observability:** hub logs every routed callback with `{ provider, deploymentCode,
  externalTxnId }` so a stuck transaction is traceable to one deployment.

## Code structure

```
apps/api/src/gateways/
  hub/                     ← NEW, only active when DEPLOYMENT_ROLE=hub
    registry.ts            deploymentCode → {baseUrl, secret, enabled}
    hub-auth.ts            HMAC sign/verify (both directions)
    router.ts              generic: namespace() + routeOf() dispatch
    providers/
      palace.router.ts     namespace=username, routeOf=parse username
      payment.router.ts    namespace=orderRef, routeOf=parse orderRef
  game-provider/
    palace.gateway.ts      stays = the hub's real upstream client
    remote.gateway.ts      NEW: spoke client → forwards to hub
  payment/ …               same split (direct gateway vs remote client)
```

- Env switch `DEPLOYMENT_ROLE = hub | spoke` selects which gateway each deployment binds:
  direct-to-provider (hub) or remote-to-hub (spoke).
- The existing per-provider interfaces (`game-provider.interface.ts`,
  `payment-gateway.interface.ts`) are the seam. The remote client implements the same
  interface, so route/service code above it **does not change**.

## Testing

- **Unit:** each router's `namespace()`/`routeOf()` round-trips (prefix injected out, parsed back).
- **Unit:** hub-auth HMAC sign/verify, including rejection of bad secret and wrong `X-Deployment`.
- **Integration:** spoke→hub→stubbed-provider outbound path.
- **Integration:** provider→hub→spoke callback returns the spoke's verbatim wallet response.
- **Integration:** spoke-down → hub returns non-200; replayed callback is idempotent.
- **Regression:** reuse existing `palace-gateway.test.ts` / `palace-wallet.test.ts` against
  the hub's local-shortcut path to prove no change for the hub's own players.

## Decisions captured

- **Which provider:** start with the game provider (Palace/Gasea); design is provider-agnostic
  and must accommodate payment providers and future providers via router adapters.
- **DB topology:** each deployment has its own database / own `user` table.
- **Username uniqueness:** assume collisions possible across deployments → hub must namespace.
- **Where the gateway lives:** elect one existing deployment as the hub (no new standalone service).

## Open questions for implementation

- Exact prefix delimiter/charset per provider (validate against Palace username rules and
  each payment provider's reference rules).
- Registry storage: config table vs env-backed JSON (lean env-backed JSON unless an admin UI
  to manage deployments is wanted).
- Reachability between hub and spokes (private network vs public URL + HMAC) per hosting layout.
