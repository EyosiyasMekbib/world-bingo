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

### Critical Business Rules
1. Wallet balance never goes below zero — enforced at DB level with `SELECT FOR UPDATE`
2. A cartela can only be held by one player per game — Redis `HSETNX` ensures atomicity
3. Game engine is server-authoritative; clients cannot manipulate ball calls or win validation
4. Refunds are automatic when a game is cancelled (BullMQ job)
5. House edge is configurable per game; accumulated in `AdminWallet`

### Local Service URLs
- API docs (Swagger): http://localhost:8080/docs
- BullMQ dashboard: http://localhost:8080/admin/queues
- Prometheus metrics: http://localhost:8080/metrics

### Environment Setup
Copy `.env.example` → `.env` at repo root and `apps/api/.env.example` → `apps/api/.env`. The `JWT_SECRET` must be a 64-byte hex string and must match between API and admin app (`NUXT_JWT_SECRET`).
