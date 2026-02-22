# World Bingo Platform — Project Bible

> **Objective:** Recreate the online Bingo system at https://online-bingo-client-230041233104.us-central1.run.app/  
> **Target:** Production-ready, supporting 10,000+ concurrent users

---

## Quick Navigation

| Document | Purpose |
|---|---|
| [`TECHSTACK.md`](./TECHSTACK.md) | Full monorepo tech stack with package versions and rationale |
| [`BINGO_SYSTEM_DOCUMENTATION.md`](./BINGO_SYSTEM_DOCUMENTATION.md) | Full feature spec, data models, API spec, game logic |
| [`BINGO_SYSTEM_DESIGN.md`](./BINGO_SYSTEM_DESIGN.md) | Architecture diagrams, concurrency, scaling, fault tolerance |
| [`BINGO_DESIGN_SPEC.md`](./BINGO_DESIGN_SPEC.md) | UI/UX design tokens, screen specs, animations |

---

## What We're Building

An **Ethiopian real-money Bingo platform** with:

- 🎮 Real-time multiplayer Bingo (75-ball, WebSocket-based)
- 💰 Wallet system with manual deposit (photo receipt) and withdrawal
- 🃏 "Cartela" (Bingo card) selection and multi-card gameplay
- 🏆 Server-authoritative winner detection (no cheating possible)
- 📱 Mobile-first dark theme UI
- 👨‍💼 Admin panel for payment verification and game management

---

## Tech Stack Decision

| Layer | Choice | Why |
|---|---|---|
| **Monorepo** | **Turborepo + pnpm workspaces** | Incremental builds, shared packages, fast installs |
| **Player Frontend** | **Nuxt 3** (Nitro) | SSR/CSR hybrid; Vue 3 ecosystem; auto-imports; PWA-ready |
| **Admin Dashboard** | **Nuxt 3 + Nuxt UI** | Shares component library with player app |
| **State** | **Pinia** | Official Vue state manager; replaces Vuex |
| **Backend API** | **Node.js 22 + Fastify v5** | 2× faster than Express; JSON Schema first; TypeScript native |
| **WebSocket** | **Socket.io v4** | Rooms, Redis adapter for horizontal scaling, auto-reconnect |
| **Database** | **PostgreSQL 16** | ACID for all money operations |
| **Cache / Pub-Sub** | **Redis 7** | Game state, sessions, BullMQ queues, Redlock |
| **ORM** | **Prisma 5** | Type-safe queries; migration engine |
| **Job Queue** | **BullMQ** | Async refunds, notifications, withdrawals |
| **Deployment** | **Google Cloud Run** | Auto-scales to zero, per-request billing |
| **Storage** | **Google Cloud Storage** | Receipt images |
| **Language** | **TypeScript 5** | Across the entire monorepo |

---

## Monorepo Structure

```
world-bingo/
├── apps/
│   ├── web/              # Nuxt 3 — Player-facing frontend
│   ├── admin/            # Nuxt 3 — Admin dashboard
│   └── api/              # Fastify + Socket.io server
│       └── prisma/       # Database schema + migrations
├── packages/
│   ├── shared-types/     # TypeScript types + Zod schemas shared across apps
│   ├── game-logic/       # Pure TS: board checking, prize calc, pattern detection
│   └── ui/               # Shared Vue 3 component library (web + admin)
├── infrastructure/
│   ├── docker-compose.yml
│   └── nginx/nginx.conf
├── docs/
│   ├── TECHSTACK.md
│   ├── BINGO_PROJECT_BIBLE.md
│   ├── BINGO_SYSTEM_DOCUMENTATION.md
│   ├── BINGO_SYSTEM_DESIGN.md
│   └── BINGO_DESIGN_SPEC.md
├── turbo.json            # Turborepo pipeline config
└── package.json          # pnpm workspace root
```

---

## Development Phases

### Phase 1 — MVP (6 weeks)
Core game loop that makes money from day one.

- [x] User registration + login (username + phone)
- [x] Wallet with manual deposit/withdrawal
- [x] Lobby with game rooms (10, 20, 50 Birr)
- [x] Cartela selection (1–70 cards per game)
- [x] Live game: WebSocket ball calling, auto-marked cards
- [x] Server-side winner validation
- [x] Auto-refund on game cancellation
- [x] Admin panel: payment verification, game creation
- [x] Notification system (WebSocket push)

### Phase 2 — Scale (4 weeks)
Make it survive real traffic.

- [ ] Redis adapter for Socket.io (multi-instance WS)
- [ ] BullMQ workers (async refunds, notifications)
- [ ] Multiple winning patterns (line, diagonal, full card)
- [ ] SMS notifications (Twilio)
- [ ] Database read replicas
- [ ] Monitoring (Grafana + Prometheus)

### Phase 3 — Manual Payment Flow Hardening (2 weeks)
Polish the manual deposit/withdrawal experience.

- [ ] Add TeleBirr transaction details to deposit form (Transaction ID, Name, Account Number)
- [ ] Admin cross-check: receipt image vs submitted form data
- [ ] 15-minute transfer deadline display & stale request warnings
- [ ] Predefined decline reasons for admin (invalid receipt, ID mismatch, etc.)
- **Note:** No Chapa or Telebirr API integration. All payments are handled manually via TeleBirr merchant transfers.

### Phase 4 — Growth (4 weeks)
Player retention and acquisition.

- [ ] Referral program
- [ ] Amharic language support
- [ ] Progressive jackpot
- [ ] Tournament mode

---

## Key Engineering Decisions

### 1. Game State Lives in Redis, Not PostgreSQL

During an active game:
- Called numbers stored in `game:{id}:state` (Redis Hash)
- Player assignments stored in `game:{id}:cartelas` (Redis Hash)
- Redis Pub/Sub broadcasts events to all WebSocket instances

**Why:** PostgreSQL cannot handle 3-second write bursts from 500 concurrent games efficiently. Redis is 100x faster for this pattern.

At game end → final state is persisted to PostgreSQL for records.

### 2. WebSocket Horizontal Scaling via Redis Adapter

All WebSocket server instances share state through Redis. When Server A needs to broadcast to a game room that has players on Server B, Redis pub/sub handles the fan-out automatically.

### 3. Wallet Operations Use `SELECT FOR UPDATE`

Every balance deduction acquires a row-level lock before checking the balance. This prevents two simultaneous `JOIN GAME` requests from both succeeding with insufficient funds.

### 4. Cartela Claiming Uses `HSETNX` (Atomic Redis Operation)

Two players cannot claim the same cartela. `HSETNX` atomically sets a field only if it doesn't already exist. Returns 0 if already taken — no race condition possible.

### 5. Game Engine Uses Redlock for Leader Election

Only one worker process calls balls for a given game. If that worker crashes, another one acquires the lock and resumes (with state loaded from Redis).

---

## Environment Setup

```bash
# Prerequisites: Docker, Node.js 22, pnpm

# Clone and set up
git clone <repo> world-bingo
cd world-bingo
pnpm install

# Start local infrastructure (PostgreSQL + Redis)
docker-compose up -d

# Apply migrations + seed cartelas
pnpm --filter api prisma migrate dev
pnpm --filter api prisma db seed

# Start everything (Turborepo runs all dev servers in parallel)
pnpm dev
```

### Local URLs
- Player App (Nuxt): http://localhost:3000
- Admin Panel (Nuxt): http://localhost:3001
- API + Swagger: http://localhost:8080 / http://localhost:8080/docs
- BullMQ Dashboard: http://localhost:8080/admin/queues

---

## Critical Business Rules (Never Break These)

1. **A player's wallet balance NEVER goes negative.** Guard at DB level.
2. **Cartela assignments are exclusive per game.** Enforce with DB unique constraint AND Redis HSETNX.
3. **Called numbers are server-side only.** Client displays; never trusts.
4. **Winner validation runs server-side before prize is awarded.** Client BINGO button is just a claim — server decides.
5. **All refunds must be idempotent.** If a refund job runs twice, the second must be a no-op.
6. **Every balance change records balance_before and balance_after.** This is the audit trail.
7. **A game needs `min_players` to start.** Never start below quorum.
