# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
pnpm install              # Install all dependencies
pnpm dev                  # Run all apps in parallel (requires infra running)
pnpm infra:up             # Start PostgreSQL, Redis via Docker Compose
pnpm infra:down           # Stop infrastructure
```

### Per-app dev (from repo root, or inside app dir)
```bash
pnpm --filter @world-bingo/api dev      # API on :8080
pnpm --filter @world-bingo/web dev      # Player app on :3002
pnpm --filter @world-bingo/admin dev    # Admin on :3001
pnpm --filter @world-bingo/agent dev    # Agent cashier on :3003
```

### Database (run from apps/api/)
```bash
pnpm db:migrate           # Run Prisma migrations
pnpm db:seed              # Seed initial data
pnpm db:studio            # Open Prisma Studio
```

### Quality
```bash
pnpm build                # Build all (packages must build before apps)
pnpm typecheck            # TypeScript check across all packages
pnpm lint                 # ESLint across all
pnpm format               # Prettier (singleQuote, no semi, trailingComma: all)
pnpm test                 # Vitest unit tests
pnpm test:e2e             # Playwright E2E tests
```

### Single-package test
```bash
pnpm --filter @world-bingo/game-logic test
```

## Architecture

**Turborepo + pnpm monorepo** with three apps and three shared packages.

### Apps
| App | Package | Port | Purpose |
|-----|---------|------|---------|
| `apps/api` | `@world-bingo/api` | 8080 | Fastify v5 REST + Socket.io backend |
| `apps/web` | `@world-bingo/web` | 3002 | Nuxt 3 player-facing PWA |
| `apps/admin` | `@world-bingo/admin` | 3001 | Nuxt 3 admin dashboard |
| `apps/agent` | `@world-bingo/agent` | 3003 | Nuxt 3 cash-agent cashier app (English only, no PWA) |

### Packages
| Package | Purpose |
|---------|---------|
| `packages/shared-types` | Zod schemas + TypeScript types for API contracts and Socket.io events |
| `packages/game-logic` | Pure TS: bingo card generation, ball drawing, pattern detection, prize calculation |
| `packages/ui` | Shared Vue 3 components and composables (used by both Nuxt apps) |

### API (`apps/api`)
- **Fastify v5** with plugins: JWT auth, rate-limit (100 req/min), Helmet, CORS, Swagger at `/docs`
- **Socket.io v4** with Redis adapter for horizontal scaling
- **BullMQ** workers (3): `game-countdown`, `game-scheduler`, `game-engine` — auto-started on server boot
- ZareCash queues run alongside them: deposit/withdrawal submission, webhook event
  processing, and a sweep queue carrying three recurring passes — the nightly
  `/v1/events` reconciliation, a 15-minute stranded-event requeue, and an hourly
  `sweep-checkout-sessions` pass that links or retires hosted-checkout sessions
- **Prisma 5** with PostgreSQL; all wallet mutations use `SELECT FOR UPDATE` to prevent race conditions
- **Redlock** for distributed leader election (prevents duplicate game-engine processing)
- **Redis** stores live game state; DB is source of truth for completed games
- Routes under `src/routes/`, business logic in `src/services/`, core libs in `src/lib/`
- On startup: recovers stuck games in WAITING/LOCKING/STARTING states from DB

### Frontend (`apps/web`, `apps/admin`)
- Both use **Nuxt 3** with route rules that proxy `/api/**` and `/socket.io/**` to the API (configured in `nuxt.config.ts`)
- **Pinia** for state management; web uses `pinia-plugin-persistedstate`
- **i18n**: English + Amharic (`am`), browser detection, cookie persistence
- Web app is a **PWA** (via `@vite-pwa/nuxt`) with amber theme (`#f59e0b`)
- Admin uses `@nuxt/ui` component library + `chart.js`/`vue-chartjs` for analytics

### Data Model Key Concepts
- **Cartela**: Bingo card (3×9 grid, 15 numbers, stored as JSON in DB)
- **GameEntry**: Links User + Game + Cartela; atomic reservation via Redis `HSETNX`
- **Transaction**: Full audit trail with `balanceBefore`/`balanceAfter` on every wallet change
- **Game statuses**: `WAITING → STARTING → LOCKING → IN_PROGRESS → PAYOUT → COMPLETED` (or `REFUNDING → CANCELLED`)
- **GameTemplate**: Blueprints for auto-spawned games
- **Agent**: A shop holding PREPAID float. The operator takes cash from the agent up
  front and credits float plus a commission bonus (the agent's margin, which they sell
  on). Agents then credit players who hand over cash at a counter. `agents.float`
  carries a raw `CHECK (>= 0)` like `wallets`.
- **AgentDepositRequest**: A player-generated 6-digit code, valid 15 minutes. Any agent
  may fulfil it and the first to confirm wins. Two PARTIAL unique indexes (one PENDING
  row per `code`, one per `userId`) enforce that under concurrency; they live in the
  migration SQL because Prisma's DSL cannot express a `WHERE` on an index.
- **AgentLedger**: Append-only float movements (`TOP_UP`, `COMMISSION`, `FULFILLMENT`,
  `ADJUSTMENT`) with `balanceBefore`/`balanceAfter`, the same audit shape as `Transaction`.

### Critical Business Rules
1. Wallet balance never goes below zero — enforced at DB level with `SELECT FOR UPDATE`
2. A cartela can only be held by one player per game — Redis `HSETNX` ensures atomicity
3. Game engine is server-authoritative; clients cannot manipulate ball calls or win validation
4. Refunds are automatic when a game is cancelled (BullMQ job)
5. House edge is configurable per game; accumulated in `AdminWallet`
6. An agent's float is prepaid and never goes below zero, enforced the same way as
   wallets (`SELECT FOR UPDATE` plus a DB `CHECK`)
7. An agent fulfilment debits the float and credits the player in ONE commit:
   `WalletService.approveDeposit` is split into `creditApprovedDepositInTx` plus
   `runPostApprovalEffects` so both callers share one transaction and one set of
   post-commit effects. Agent deposits are therefore fully bonus-eligible
8. Agent-created deposits leave `senderName`/`senderAccount` NULL. `PayerIdentityService`
   keys shared-payer detection on `senderAccount`, so stamping the agent there would
   strip first-deposit incentives from every player after the first at that shop
9. There is no automatic reversal of an agent deposit. Corrections are an admin float
   debit plus a wallet adjustment, done deliberately

### Local Service URLs
- API docs (Swagger): http://localhost:8080/docs
- BullMQ dashboard: http://localhost:8080/admin/queues
- Prometheus metrics: http://localhost:8080/metrics

### Observability
A **central shared stack** (`docker-compose.observability.yml`, on the external `dokploy-network`)
collects signals from every brand. Both brands PUSH into it; pull-based metric exporters live
per-brand. Tools:
- **GlitchTip** — error tracking (Sentry-compatible). API + both Nuxt apps report via the Sentry SDK.
- **Loki** — log aggregation; the API ships pino logs when `LOKI_URL` is set.
- **Tempo** — distributed traces via OpenTelemetry (OTLP) when `OTEL_ENABLED=true`.
- **Prometheus + Grafana** — metrics scrape + dashboards (`wb-domain`, `wb-infra`); per-brand.
- **Alertmanager** — alert routing; notification channel is an intentional TODO placeholder (no notifier wired).
- **Uptime Kuma** — external uptime checks.
- **PostHog** — product analytics (browser events, session replay, server-side money/game events). Env-gated by `POSTHOG_KEY` / `NUXT_PUBLIC_POSTHOG_KEY`; see `docs/posthog.md`.

Everything is **env-gated and a no-op when unset**: empty `SENTRY_DSN`, empty `LOKI_URL`, and
`OTEL_ENABLED=false` mean the app boots and runs exactly as before. All **central service names are
prefixed `wb-`** (e.g. `wb-loki`, `wb-tempo`, `wb-glitchtip`) because they share `dokploy-network`
with unrelated stacks — a bare alias like `api` once cross-served. Per-brand exporters are suffixed
`-arada` / `-betbawa`. Env vars live in the root `.env.example` (infra + GlitchTip + backend) and
`apps/api/.env.example` (api-consumed `SENTRY_*`/`OTEL_*`/`LOKI_*`). See `docs/observability.md` for the runbook.

### Environment Setup
Copy `.env.example` → `.env` at repo root and `apps/api/.env.example` → `apps/api/.env`. The `JWT_SECRET` must be a 64-byte hex string and must match between API and admin app (`NUXT_JWT_SECRET`).

For shared-provider multi-deployment setups, one deployment is elected the **hub** (owns the provider token + the single callback URL) and the others are **spokes** that forward provider calls through it. Set `DEPLOYMENT_ROLE`/`DEPLOYMENT_CODE` plus the hub/spoke vars — see `apps/api/.env.example`. Default `standalone` preserves single-deployment behaviour.
