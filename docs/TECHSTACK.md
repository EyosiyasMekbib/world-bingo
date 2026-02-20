# World Bingo — Monorepo Tech Stack

> **Stack decision date:** 2026-02-20  
> **Constraint:** Frontend must be Nuxt.js. Target: 10,000+ concurrent users.

---

## Monorepo Tooling

| Tool | Choice | Why |
|---|---|---|
| **Package Manager** | `pnpm` | Workspace-native, fastest installs, hard-linked `node_modules` saves disk |
| **Monorepo Orchestration** | `Turborepo` | Incremental builds, remote caching, task pipelines across apps |
| **Language** | `TypeScript 5.x` | End-to-end type safety across every package |

---

## Repository Structure

```
world-bingo/
├── apps/
│   ├── web/                  # Nuxt 3 — Player-facing frontend
│   ├── admin/                # Nuxt 3 — Admin dashboard
│   └── api/                  # Fastify + Socket.io — REST + WebSocket server
│       └── prisma/           # Schema + migrations
├── packages/
│   ├── shared-types/         # TypeScript interfaces shared across all apps
│   ├── game-logic/           # Pure TS: board validation, prize calc, pattern detection
│   └── ui/                   # Shared Vue 3 component library (used by web + admin)
├── infrastructure/
│   ├── docker-compose.yml    # Local: PostgreSQL + Redis
│   └── nginx/
│       └── nginx.conf        # Reverse proxy config
├── docs/
│   ├── BINGO_PROJECT_BIBLE.md
│   ├── BINGO_SYSTEM_DESIGN.md
│   ├── BINGO_DESIGN_SPEC.md
│   ├── BINGO_SYSTEM_DOCUMENTATION.md
│   └── TECHSTACK.md          # ← this file
├── turbo.json                # Turborepo pipeline config
└── package.json              # pnpm workspace root
```

---

## Layer-by-Layer Stack

### 1. Frontend — `apps/web` (Player App)

| Concern | Choice | Notes |
|---|---|---|
| **Framework** | **Nuxt 3** (Nitro engine) | SSR for SEO + auth pages; CSR for game screens |
| **Language** | TypeScript | `strict: true` |
| **Styling** | Vanilla CSS + CSS Variables | Design token system from `BINGO_DESIGN_SPEC.md`; no utility-class overhead |
| **State Management** | **Pinia** | Official Vue state manager; DevTools support; replaces Vuex |
| **Real-time (WebSocket)** | **Socket.io v4 client** | Matches the server; auto-reconnect built-in |
| **HTTP Client** | `useFetch` / `$fetch` (Nuxt native) | Composable, SSR-aware; no Axios needed |
| **Animations** | **Motion One** (Vue plugin) | WAAPI-based; replaces heavy GSAP; CSS keyframes for simple effects |
| **Fonts** | Rajdhani + Nunito (Google Fonts) | Per design spec; loaded via `nuxt/fonts` module |
| **Icons** | `nuxt-icon` | Tree-shaken SVG icons; no runtime cost |
| **Form Validation** | **VeeValidate 4 + Zod** | Schema-driven validation; same Zod schemas as API |
| **SEO** | `useHead` / `useSeoMeta` | Nuxt native; per-page meta management |
| **PWA** | `@vite-pwa/nuxt` | Offline support; add-to-home-screen for mobile |
| **Image Optimization** | `@nuxt/image` | Automatic WebP conversion; responsive sizes |

**Rendering strategy per route:**

| Route | Mode | Reason |
|---|---|---|
| `/auth` | SSR | Fast initial HTML; no auth flash |
| `/` (lobby) | CSR (client-only) | WebSocket data; no SEO needed |
| `/quick/[gameId]` | CSR | Real-time game; SSR would go stale immediately |
| `/quick/[gameId]/play` | CSR | Full real-time; socket-driven |
| `/wallet` | SSR | Balance on first paint; SEO irrelevant but fast |

---

### 2. Admin Dashboard — `apps/admin`

| Concern | Choice | Notes |
|---|---|---|
| **Framework** | **Nuxt 3** (same as web) | Shares `packages/ui` component library |
| **UI Layer** | **Nuxt UI** (`@nuxt/ui`) | Table, form, modal primitives; saves significant admin UI build time |
| **Charts** | **Chart.js + vue-chartjs** | Revenue, player, deposit charts on dashboard |
| **Data Tables** | Nuxt UI `UTable` | Sortable, paginated; built-in |
| **Auth Guard** | Nuxt middleware (`defineNuxtRouteMiddleware`) | Redirect if not admin role |

> The admin app is a separate Nuxt instance (distinct `apps/admin/`) so it can be deployed independently and locked down behind a VPN or IP allowlist.

---

### 3. Backend API — `apps/api`

| Concern | Choice | Notes |
|---|---|---|
| **Runtime** | **Node.js 22 LTS** | Latest LTS; native `fetch`, improved perf |
| **HTTP Framework** | **Fastify v5** | 2× faster than Express; schema-first with JSON Schema; TypeScript native |
| **WebSocket** | **Socket.io v4** | Room management, Redis adapter for horizontal scale, auto-reconnect |
| **ORM** | **Prisma 5** | Type-safe queries; migration engine; Prisma Accelerate for connection pooling |
| **Validation** | **Zod** | Shared schemas with frontend via `packages/shared-types` |
| **Auth** | **JWT** (`@fastify/jwt`) | Stateless; Redis blacklist for logout |
| **Job Queue** | **BullMQ** | Refunds, withdrawal processing, notifications — backed by Redis Streams |
| **Distributed Lock** | **Redlock** | Game engine leader election; prevents double ball-calling |
| **API Documentation** | **Fastify Swagger** (`@fastify/swagger`) | Auto-generated from JSON Schema; `/docs` endpoint |
| **File Upload** | **@fastify/multipart** | Receipt image upload before forwarding to GCS |
| **Rate Limiting** | **@fastify/rate-limit** | Redis-backed; per-IP and per-user limits |

---

### 4. Data Layer

| Concern | Choice | Notes |
|---|---|---|
| **Primary Database** | **PostgreSQL 16** | ACID transactions for all money operations |
| **Connection Pooler** | **PgBouncer** (transaction mode) | Prevents connection exhaustion at scale |
| **In-Memory Store** | **Redis 7** (Redis Stack) | Game state, session cache, pub/sub, BullMQ queues, Redlock |
| **Object Storage** | **Google Cloud Storage** | Receipt images; lifecycle policy to auto-delete old unverified receipts |
| **Search** (Phase 2) | **pg_trgm extension** | Fuzzy username search; no Elasticsearch overhead |

---

### 5. Shared Packages

#### `packages/shared-types`
Pure TypeScript — no runtime dependencies.

```
shared-types/
├── src/
│   ├── entities/        # User, Wallet, Game, Cartela, Transaction interfaces
│   ├── api/             # Request/response DTOs (Zod schemas + inferred types)
│   ├── socket/          # Socket.io event payloads (typed emit/on maps)
│   └── enums/           # GameStatus, TransactionType, PaymentStatus
└── package.json
```

Consumed by: `apps/web`, `apps/admin`, `apps/api`.

#### `packages/game-logic`
Pure TypeScript — zero dependencies. Framework-agnostic.

```
game-logic/
├── src/
│   ├── cartela.ts          # Generate + validate 5×5 bingo cards
│   ├── patterns.ts         # Line, diagonal, full-card pattern detection
│   ├── prize.ts            # Prize pool calc: (entries × ticketPrice) × (1 - houseEdge)
│   └── ball.ts             # Random ball draw without replacement
└── package.json
```

This package is usable from both the API (server-side validation) and the frontend (optimistic UI pattern detection before sending a claim).

#### `packages/ui`
Vue 3 component library — consumed by both Nuxt apps.

```
ui/
├── src/
│   ├── components/
│   │   ├── GameRoomCard.vue
│   │   ├── CartelaGrid.vue
│   │   ├── BingoBall.vue
│   │   ├── CountdownTimer.vue
│   │   ├── WalletBalance.vue
│   │   └── ...
│   ├── composables/
│   │   ├── useSocket.ts      # Typed Socket.io composable
│   │   ├── useWallet.ts
│   │   └── useGame.ts
│   └── styles/
│       └── tokens.css        # CSS custom properties from BINGO_DESIGN_SPEC.md
└── package.json
```

---

### 6. Infrastructure & DevOps

| Concern | Choice | Notes |
|---|---|---|
| **Containerization** | **Docker** + **Docker Compose** | Local dev: one command spins up PG + Redis |
| **Reverse Proxy** | **Nginx** | WebSocket sticky sessions (`ip_hash`); REST load balancing (`least_conn`) |
| **Cloud Platform** | **Google Cloud Run** | Auto-scales to zero; per-request billing; handles burst traffic |
| **CI/CD** | **GitHub Actions** | Build → test → Docker push → Cloud Run deploy |
| **Secrets** | **Google Secret Manager** | DATABASE_URL, REDIS_URL, JWT_SECRET, GCS credentials |
| **Monitoring** | **Prometheus + Grafana** | Custom game metrics: active games, WS connections, prize pool volume |
| **Error Tracking** | **Sentry** | Both Nuxt apps + Fastify; source maps uploaded in CI |
| **Logs** | **Google Cloud Logging** | Structured JSON logs from Fastify via `pino` |

---

### 7. Development Tooling

| Tool | Choice |
|---|---|
| **Linter** | ESLint (flat config) + `@nuxt/eslint` |
| **Formatter** | Prettier |
| **Git Hooks** | Husky + lint-staged |
| **Testing (Unit)** | Vitest — shared across all packages and apps |
| **Testing (E2E)** | Playwright — against running Nuxt dev server |
| **Type Checking** | `vue-tsc` (Nuxt apps) + `tsc` (api, packages) |
| **Commit Standard** | Conventional Commits (`feat:`, `fix:`, `chore:`) |

---

## Environment Variables

```bash
# apps/api
DATABASE_URL="postgresql://..."
REDIS_URL="redis://..."
JWT_SECRET="..."
GCS_BUCKET_NAME="..."
GCS_KEY_FILE="..."
PORT=8080

# apps/web + apps/admin (runtime config via nuxt.config.ts)
NUXT_PUBLIC_API_BASE="http://localhost:8080"
NUXT_PUBLIC_WS_URL="http://localhost:8080"
```

---

## Local Development

```bash
# Prerequisites: Docker, Node.js 22, pnpm

# 1. Install all dependencies
pnpm install

# 2. Start PostgreSQL + Redis
docker-compose up -d

# 3. Run DB migrations + seed cartelas
pnpm --filter api prisma migrate dev
pnpm --filter api prisma db seed

# 4. Start everything (Turborepo runs all dev servers in parallel)
pnpm dev
```

**Local URLs:**

| Service | URL |
|---|---|
| Player App (Nuxt) | http://localhost:3000 |
| Admin Panel (Nuxt) | http://localhost:3001 |
| API + Swagger | http://localhost:8080 / http://localhost:8080/docs |
| BullMQ Dashboard | http://localhost:8080/admin/queues |

---

## Key Package Versions (Pinned)

```json
{
  "nuxt": "^3.15.0",
  "vue": "^3.5.0",
  "pinia": "^2.3.0",
  "socket.io-client": "^4.8.0",
  "fastify": "^5.2.0",
  "socket.io": "^4.8.0",
  "@prisma/client": "^5.22.0",
  "bullmq": "^5.0.0",
  "redlock": "^5.0.0",
  "zod": "^3.24.0",
  "typescript": "^5.7.0",
  "turborepo": "^2.3.0",
  "pnpm": "^9.15.0"
}
```

---

## Why Nuxt over Next.js for This Project

| Concern | Nuxt 3 Advantage |
|---|---|
| **SSR + CSR hybrid** | `routeRules` lets game routes be fully CSR while auth/wallet routes are SSR — no extra config |
| **Auto-imports** | Composables, components, utils auto-imported; zero boilerplate |
| **`useFetch` + `useAsyncData`** | SSR-aware data fetching with automatic deduplication |
| **Nitro server** | Built-in edge-ready server; can co-locate lightweight API routes within the Nuxt app if needed |
| **Vue 3 ecosystem** | Pinia, VueUse, Motion One all integrate natively |
| **`@nuxt/ui`** | Saves weeks of admin UI work with production-ready headless components |
| **PWA module** | One-line PWA setup via `@vite-pwa/nuxt`; critical for mobile-first Ethiopian market |
