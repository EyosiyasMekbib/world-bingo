# Observability & DevOps — Design Spec

- **Date:** 2026-06-26
- **Status:** Approved (design); implementation pending
- **Author:** Eyosiyas Mekbib (with Claude)
- **Related:** Palace provider integration debugging (walletless-user fix `fix(palace): uniform null-wallet handling`)

## 1. Context & Motivation

Debugging the Palace provider integration was slow and error-prone for three structural reasons, surfaced during a systematic debugging session:

1. **Dark boundaries.** Eight critical boundaries had no logging — `resolveUser`, wallet balance reads, the Palace gateway request/response, game launch, the hub→spoke forward (success path), and callback dispatch. Failures could not be traced.
2. **Silent error swallowing.** Errors vanished at multiple layers: the lobby `launchGame()` has no catch (a failed launch shows the user nothing), `.no-img` CSS is undefined, spoke-forward failures are fabricated into `1001`, and a duplicate-bet insert is `/* ignore */`-d. Real failures looked random.
3. **No request thread.** A single bet crosses deployment boundaries (hub callback → spoke forward → wallet service → DB) with nothing tying those log lines together.

The result: real failures × hidden × un-loggable = an integration that "feels so buggy."

### Current stack (starting point — not zero)

| Area | State |
|------|-------|
| Logging | Pino (JSON in prod, `pino-pretty` in dev) → stdout → Docker/Dokploy log capture. No aggregation or search. |
| Metrics | `prom-client` + `/metrics`; custom counters: `httpRequestsTotal`, `wsConnectionsActive`, `gamesActive`, `walletTransactionsTotal`. Prometheus + Grafana already provisioned (`infrastructure/grafana/`). |
| Error tracking | None. |
| Tracing | None. |
| Platform | Dokploy (self-hosted PaaS + Traefik) on a VPS. Per-brand compose: `aradabingo` (hub), `betbawa` (spoke), plus `prod`. |
| CI | GitHub Actions (`ci.yml`): lint/typecheck → game-logic tests → API tests (PG+Redis services) → builds Docker images on `main` with `push: false`. No deploy step (Dokploy watches the repo). |
| Secrets | Env vars set by hand in Dokploy. |

## 2. Goals & Non-Goals

### Goals
- Make the provider integration (and the app generally) **diagnosable**: every failure is captured, searchable, and traceable end-to-end across hub/spoke.
- Reuse the existing self-hosted Prometheus + Grafana rather than introducing a parallel stack.
- Keep gambling PII (phone, account, wallet amounts) on owned infrastructure.
- Produce a prioritized DevOps roadmap, fixing two production landmines found in the compose files.

### Non-Goals (YAGNI)
- **No OpenTelemetry distributed tracing yet.** Correlation IDs in structured logs deliver ~80% of the trace value at ~10% of the cost. Revisit only if outgrown.
- **No Kubernetes / no platform migration.** Stay on Dokploy and improve it.
- **No SaaS observability** as the default (cost + PII residency). Error tracking MAY move to Sentry SaaS later via a one-line DSN change if self-hosting proves high-maintenance.

## 3. Cross-Cutting Decisions

- **Hosting: self-hosted.** Loki (logs) + GlitchTip (errors) run as containers beside the existing Grafana/Prometheus on the Dokploy VPS. Justification: matches the existing self-hosted metrics half, keeps PII in, no new bills, single Grafana pane for logs + metrics.
- **Correlation ID:** generated at the edge as `x-request-id` (Fastify `genReqId`), propagated through the hub→spoke forward header, into the wallet service, and onto every log line as `reqId`. One bet = one searchable ID across deployments.
- **Log schema (standardized):** `{ reqId, component, provider, account(masked), command, resultCode, palaceCode, latencyMs }`.
- **PII redaction:** Pino `redact` paths mask phone/account/amounts; Sentry/GlitchTip `beforeSend` strips the same. PII is controlled even on owned infra.

## 4. Track A — Observability (to build)

Sequenced foundation-first: each phase ships independently and makes the next more useful.

### Phase 1 — Structured logging + correlation IDs (foundation)
**What:** request-scoped correlation ID + structured logs at the eight dark boundaries, with a shared log schema and PII redaction.

- **Components**
  - `lib/logger.ts` helper: child-logger factory (`logger.child({ component })`) + redaction config + the standard field set.
  - Edge `reqId`: configure Fastify `genReqId` to honor an inbound `x-request-id` or mint one.
  - Propagation: the hub→spoke forward (`routes/palace/callback.ts`, `gateways/hub/remote-game-provider.gateway.ts`) sends `x-request-id`; the spoke sink (`routes/hub/spoke-callback.ts`) and internal provider (`routes/hub/internal-provider.ts`) read and reuse it.
  - Boundary logs (one structured line each, success + failure): `resolveUser` (account → userId/null), wallet read (balance), `PalaceGateway.request` (path, `palaceCode`, latency), `getGameUrl` launch (gameCode → gameUrl/error), spoke-forward (status + latency), `PalaceWalletService.dispatch` (command → resultCode).
- **Files:** `apps/api/src/lib/logger.ts` (new), `apps/api/src/index.ts` (Fastify logger + `genReqId`), `services/palace-wallet.service.ts`, `gateways/game-provider/palace.gateway.ts`, `routes/palace/callback.ts`, `routes/game-provider/index.ts`, `gateways/hub/remote-game-provider.gateway.ts`, `routes/hub/spoke-callback.ts`, `routes/hub/internal-provider.ts`.
- **Interface:** components depend only on the `lib/logger.ts` factory and the Fastify request log; no component reads another's internals.
- **Done when:** a bet callback produces a single `reqId`-tagged trail from edge → resolve → wallet read → DB, with account masked.

### Phase 2 — Searchable logs: Loki + Grafana
**What:** ship Pino JSON to Loki; query in the Grafana you already run.

- **Components:** Loki container + a Pino→Loki shipper (`pino-loki` transport or Promtail tailing container stdout) added to the prod/brand compose files; Loki added as a Grafana datasource (`infrastructure/grafana/datasources.yml`).
- **Files:** `docker-compose.prod.yml`, `docker-compose.aradabingo.yml`, `docker-compose.betbawa.yml`, `infrastructure/grafana/datasources.yml`, `infrastructure/loki/` (config).
- **Done when:** `{component="palace-callback"} | resultCode="1001"` and `reqId="..."` return results spanning hub and spoke.

### Phase 3 — Error tracking: GlitchTip (self-hosted, Sentry-compatible)
**What:** actively capture the currently-swallowed failures, server and client.

- **Components**
  - API: `@sentry/node` initialized against GlitchTip DSN; capture launch 502/409, callback `1001`, spoke-forward failures, unhandled errors — tagged with `reqId`. `beforeSend` redacts PII.
  - Web: fix the lobby `launchGame()` silent-swallow — surface a user-facing error **and** report via the browser SDK. (Addresses the "game won't open, no message" symptom.)
  - GlitchTip container + its own Postgres/Redis (or reuse) in the infra compose.
- **Files:** `apps/api/src/index.ts` (+ error hooks), `apps/web/pages/games/index.vue`, `apps/web/store/provider-games.ts`, infra compose.
- **Done when:** a forced launch failure appears in GlitchTip with the `reqId`, and the player sees an error toast.

### Phase 4 — Provider metrics + dashboard + alerts
**What:** provider-specific Prometheus series + a Grafana dashboard + alerts.

- **Metrics:** `provider_launch_total{provider,gameCode,result}`, `provider_callback_total{command,resultCode}`, `provider_call_latency_seconds{provider,op}`, `spoke_forward_latency_seconds`.
- **Dashboard:** launch success-rate per game, callback result-code breakdown, spoke-forward latency, Palace upstream-error rate.
- **Alerts (Grafana):** launch success-rate below threshold; `1001` spike; spoke-forward failure rate.
- **Files:** `apps/api/src/lib/metrics.ts`, instrumentation call-sites, `infrastructure/grafana/dashboards/`.
- **Done when:** the dashboard shows per-game launch success-rate and an alert fires on a synthetic failure burst.

## 5. Track B — DevOps (plan / decisions)

Ordered by risk. Items 1–2 are production landmines found while reading the compose files; they become immediate tickets.

| # | Severity | Finding / decision | Action |
|---|----------|--------------------|--------|
| 1 | 🔴 | `docker-compose.prod.yml:23` hardcodes `RUN_SEED: "true"`, contradicting `DEPLOYMENT.md`. Risks re-seeding on every prod deploy. | Set `RUN_SEED=false` (env-driven default). Quick fix. |
| 2 | 🔴 | `RUN_MIGRATIONS=true` runs `prisma migrate deploy` per API replica on boot. Safe at 1 replica; races if scaled. | Move migrations to a one-shot job / init step decoupled from app replicas. |
| 3 | 🟠 | CI builds images with `push: false`; Dokploy rebuilds from git (non-reproducible, no rollback). | Push tagged images to GHCR on `main`; Dokploy deploys pinned tags → reproducible + rollback. |
| 4 | 🟠 | No staging environment. | `develop` → staging stack to validate provider/cert changes before prod. |
| 5 | 🟠 | No visible automated Postgres backups for a wallet/gambling system. | Daily `pg_dump` + offsite retention; document restore. |
| 6 | 🟡 | Secrets hand-set in Dokploy; hub token + `HUB_SHARED_SECRET` spread across brands. | Document required env per role (hub/spoke); secret-store not compose; rotation runbook. |
| 7 | 🟡 | Hub/spoke deploy coordination (aradabingo hub + betbawa spoke) undocumented. | Document deploy order, callback-URL ownership, shared-secret rotation. |

## 6. Rollout & Sequencing

1. Phase 1 (logging + correlation IDs) — highest leverage, no infra changes. Ship first.
2. DevOps red fixes (1, 2) — can land alongside Phase 1 (small, isolated).
3. Phase 2 (Loki) → Phase 3 (GlitchTip) → Phase 4 (metrics/dashboard/alerts).
4. DevOps amber/yellow items (3–7) — scheduled as individual tickets.

## 7. Success Criteria

- A single failing bet or launch is traceable end-to-end by `reqId` across hub and spoke in Grafana/Loki.
- Every launch/callback failure is captured in GlitchTip (none silently swallowed); the player sees an error on launch failure.
- A Grafana panel shows per-game launch success-rate; an alert fires on a failure burst.
- `RUN_SEED` can never re-seed prod by default; migrations are decoupled from app replicas.

## 8. Testing Approach

- **Phase 1:** unit tests asserting the logger emits the standard schema and redacts PII; a test that `x-request-id` propagates through the spoke forward.
- **Phase 3:** a test that a launch failure invokes the capture path; a web test that `launchGame()` surfaces an error instead of swallowing.
- **Phase 4:** unit tests that instrumentation increments the right metric series with correct labels.
- **DevOps:** CI assertion that prod compose does not set `RUN_SEED=true`.
