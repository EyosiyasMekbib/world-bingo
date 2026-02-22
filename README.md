# 🎱 World Bingo

> An Ethiopian real-money multiplayer Bingo platform built for **10,000+ concurrent users**.

---

## ✨ Features

- 🎮 **Real-time Bingo** — WebSocket-based 75-ball gameplay with server-authoritative winner detection
- 💰 **Wallet System** — Manual deposit via TeleBirr photo receipt and withdrawal
- 🃏 **Cartela Selection** — Up to 70 bingo cards per game with atomic reservation (no double-booking)
- 🏆 **Cheat-proof** — All ball calls and winner validations happen server-side
- 📱 **Mobile-first** — Dark-themed PWA optimised for Ethiopian mobile users
- 👨‍💼 **Admin Panel** — Dedicated dashboard for payment verification and game management
- 🌐 **Amharic + English** — Full i18n support

---

## 🗂 Monorepo Structure

```
world-bingo/
├── apps/
│   ├── web/              # Nuxt 3 — Player-facing frontend
│   ├── admin/            # Nuxt 3 — Admin dashboard
│   └── api/              # Fastify v5 + Socket.io — REST + WebSocket server
│       └── prisma/       # PostgreSQL schema & migrations
├── packages/
│   ├── shared-types/     # TypeScript interfaces + Zod schemas (used by all apps)
│   ├── game-logic/       # Pure TS: board generation, pattern detection, prize calc
│   └── ui/               # Shared Vue 3 component library
├── infrastructure/
│   ├── docker-compose.yml
│   ├── nginx/            # Reverse proxy (WebSocket sticky sessions)
│   ├── prometheus/       # Metrics config
│   └── grafana/          # Dashboards
├── docs/                 # Architecture, design specs, task breakdowns
├── turbo.json
└── package.json
```

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| **Monorepo** | Turborepo + pnpm workspaces |
| **Player Frontend** | Nuxt 3, Pinia, Socket.io client, Motion One |
| **Admin Dashboard** | Nuxt 3, Nuxt UI, Chart.js |
| **Backend API** | Node.js 22, Fastify v5, Socket.io v4 |
| **Database** | PostgreSQL 16 (ACID for all money ops) |
| **Cache / Pub-Sub** | Redis 7 (game state, sessions, BullMQ, Redlock) |
| **ORM** | Prisma 5 |
| **Job Queue** | BullMQ (refunds, notifications, withdrawals) |
| **Auth** | JWT (`@fastify/jwt`) with Redis blacklist |
| **Validation** | Zod (shared schemas across frontend + backend) |
| **Storage** | Google Cloud Storage (receipt images) |
| **Deployment** | Google Cloud Run (auto-scales to zero) |
| **CI/CD** | GitHub Actions → Docker → Cloud Run |
| **Monitoring** | Prometheus + Grafana, Sentry, Pino logs |
| **Language** | TypeScript 5 throughout the entire monorepo |

---

## 🚀 Getting Started

### Prerequisites

- [Node.js 22+](https://nodejs.org/)
- [pnpm 9+](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) (for PostgreSQL + Redis)

### 1. Clone & Install

```bash
git clone <repo-url> world-bingo
cd world-bingo
pnpm install
```

### 2. Configure Environment Variables

```bash
# apps/api — copy and fill in values
cp apps/api/.env.example apps/api/.env
```

```env
# apps/api
DATABASE_URL="postgresql://postgres:password@localhost:5432/worldbingo"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="your-secret-here"
GCS_BUCKET_NAME="your-bucket"
GCS_KEY_FILE="path/to/keyfile.json"
PORT=8080
```

```env
# apps/web & apps/admin (nuxt.config.ts runtimeConfig)
NUXT_PUBLIC_API_BASE="http://localhost:8080"
NUXT_PUBLIC_WS_URL="http://localhost:8080"
```

### 3. Start Infrastructure

```bash
# Spin up PostgreSQL + Redis
docker-compose -f infrastructure/docker-compose.yml up -d
```

### 4. Run Migrations & Seed

```bash
pnpm --filter api prisma migrate dev
pnpm --filter api prisma db seed
```

### 5. Start All Apps

```bash
pnpm dev
```

Turborepo runs all dev servers in parallel:

| Service | URL |
|---|---|
| 🎮 Player App | http://localhost:3000 |
| 👨‍💼 Admin Panel | http://localhost:3001 |
| ⚡ API + Swagger | http://localhost:8080 / http://localhost:8080/docs |
| 📋 BullMQ Dashboard | http://localhost:8080/admin/queues |

---

## 🧪 Testing

```bash
# Unit tests (Vitest — all packages + apps)
pnpm test

# E2E tests (Playwright)
pnpm test:e2e

# Type checking
pnpm typecheck

# Lint
pnpm lint
```

---

## 📖 Usage Guide

### Player App (`http://localhost:3000`)

#### 1. Registration & Login
- Navigate to `/auth/register` and create an account with a username and phone number.
- Log in at `/auth/login`. A JWT is stored in memory; a refresh token is kept in an HTTP-only cookie.

#### 2. Depositing Funds
1. From the lobby, click **+ Deposit** in the wallet summary bar.
2. Send the desired amount (minimum 10 ETB) to the TeleBirr merchant number **0901977670** — you have **15 minutes**.
3. Fill in the deposit form:
   - **Amount** — use quick-select chips (50 / 100 / 200 / 500 ETB) or type a custom value
   - **TeleBirr Transaction ID** — e.g. `TLB202601011234`
   - **Your name** as shown on the TeleBirr receipt
   - **Your TeleBirr phone number**
   - **Receipt screenshot** — drag & drop or click to upload (JPG/PNG, max 5 MB)
4. Submit. The deposit shows as **Pending** until an admin approves it.

#### 3. Joining a Game
1. The lobby (`/`) lists all **WAITING** games with their ticket price, player count, and winning pattern.
2. The **Progressive Jackpot** banner shows the current jackpot — win it by completing a **Full House in ≤ 20 balls**.
3. Click **Join Game →** on any card to open the game room.
4. Select one or more **cartelas** (bingo cards) — each reservation is atomic so no two players share a card.
5. Confirm entry; the ticket price is deducted from your wallet immediately.

#### 4. Playing a Game
- The game starts once `min_players` have joined.
- Balls are called server-side every few seconds; your cards are **auto-marked**.
- The currently called ball is shown as a large hero display. The last 10 called balls scroll across the top bar.
- A **BINGO** button appears on any card where a winning pattern is detected client-side.
- Press **BINGO** to send a claim to the server — the server re-validates before awarding the prize.
- If you win, a prize overlay appears; if someone else wins first, their name and prize amount is shown.
- If the game is cancelled (not enough players), your entry fee is **automatically refunded**.

#### 5. Withdrawing Funds
1. Click **Withdraw** in the wallet bar.
2. Enter the amount and your TeleBirr details.
3. Submit the request — an admin processes it manually.

#### 6. Referral Program (`/refer`)
- Your personal referral link and code are shown on the **Refer & Earn** page.
- Copy the link or share directly to WhatsApp.
- Track your total referrals, pending rewards, and total earnings on the same page.

#### 7. Tournaments (`/tournaments`)
- Browse and join scheduled tournament games from the tournaments lobby.
- Individual tournament details are at `/tournaments/[id]`.

---

### Admin Panel (`http://localhost:3001`)

Log in at `/login` with admin credentials.

#### Dashboard (`/`)
Overview stats: active games, total players, deposit/withdrawal volumes, and revenue charts.

#### Deposits (`/deposits`)
| Column | Description |
|---|---|
| User / Phone | Who submitted the request |
| Amount | ETB amount requested |
| Txn ID | TeleBirr transaction ID provided by the player |
| Sender Name / No. | Player-supplied TeleBirr details for cross-checking |
| Receipt | Clickable thumbnail of the uploaded screenshot |
| Actions | **Approve** (credits wallet) or **Decline** (with a reason) |

Decline reasons include: _Transaction ID mismatch_, _Invalid receipt_, _Sender name mismatch_, _Amount mismatch_, etc.

#### Withdrawals (`/withdrawals`)
Review pending withdrawal requests. Approve (triggers payout) or decline with a note.

#### Games (`/games`)
- View all games filterable by status (WAITING, STARTING, IN_PROGRESS, COMPLETED, CANCELLED).
- **Create Game**: set title, ticket price, max/min players, house edge %, and winning pattern.
- Available patterns: `ANY_LINE`, `FULL_HOUSE`, `FOUR_CORNERS`, `T_SHAPE`, `X_SHAPE`, `U_SHAPE`, `DIAMOND`.
- **Start** a waiting game manually or **Cancel** it (triggers automatic player refunds).

#### Users (`/users`)
Browse registered players, view wallet balances, and manage accounts.

#### Orders (`/orders`)
Full transaction log of all wallet activity.

#### Tournaments (`/tournaments`)
Create and manage tournament-mode games.

#### Settings (`/settings`)
Platform configuration (house edge defaults, jackpot thresholds, etc.).

---

## 🏗 Architecture Highlights

### Game State in Redis, Not PostgreSQL
During an active game, called numbers and cartela assignments live in Redis (`HASH` structures). This handles the 3-second write bursts from hundreds of concurrent games. At game end, the final state is persisted to PostgreSQL for auditing.

### Horizontal WebSocket Scaling
All Socket.io server instances share state via the Redis adapter. Server A can broadcast to players connected to Server B through Redis Pub/Sub fan-out with no coordination code required.

### Race-condition-free Wallet
Every balance deduction uses `SELECT FOR UPDATE` (PostgreSQL row-level lock) before checking funds. Two simultaneous join requests with insufficient balance cannot both succeed.

### Atomic Cartela Reservation
Cartela claiming uses Redis `HSETNX` — an atomic set-if-not-exists. Two players cannot claim the same card; no application-level locking needed.

### Redlock Leader Election
Only one worker process ever calls balls for a given game. If that worker crashes, another acquires the Redlock mutex and resumes from Redis state.

---

## 📋 Critical Business Rules

1. **Wallet balance never goes negative** — enforced at the DB layer
2. **Cartela assignments are exclusive per game** — DB unique constraint + Redis `HSETNX`
3. **Called numbers are server-side only** — the client displays; never trusts
4. **Winner validation is server-side** — the client BINGO button is a claim request, not a decision
5. **All refunds are idempotent** — running a refund job twice is a no-op
6. **Every balance change records `balance_before` and `balance_after`** — full audit trail
7. **A game requires `min_players` to start** — never launch below quorum

---

## 🗺 Roadmap

| Phase | Status | Scope |
|---|---|---|
| **Phase 1 — MVP** | ✅ Complete | Auth, wallet, lobby, live game, admin, notifications |
| **Phase 2 — Scale** | 🔄 In Progress | Redis Socket.io adapter, BullMQ workers, multi-pattern wins, SMS, Grafana |
| **Phase 3 — Payments** | 📅 Planned | TeleBirr receipt hardening, admin cross-check, decline reasons |
| **Phase 4 — Growth** | 📅 Planned | Referral program, progressive jackpot, tournament mode |

---

## 📁 Documentation

Detailed docs live in the [`docs/`](./docs) folder:

| File | Contents |
|---|---|
| [`BINGO_PROJECT_BIBLE.md`](./docs/BINGO_PROJECT_BIBLE.md) | Project overview, phases, key engineering decisions |
| [`BINGO_SYSTEM_DOCUMENTATION.md`](./docs/BINGO_SYSTEM_DOCUMENTATION.md) | Full feature spec, data models, API spec |
| [`BINGO_SYSTEM_DESIGN.md`](./docs/BINGO_SYSTEM_DESIGN.md) | Architecture diagrams, concurrency, fault tolerance |
| [`BINGO_DESIGN_SPEC.md`](./docs/BINGO_DESIGN_SPEC.md) | UI/UX design tokens, screen specs, animations |
| [`TECHSTACK.md`](./docs/TECHSTACK.md) | Full tech stack with package versions and rationale |
| [`AZURE_ARCHITECTURE_AND_DEPLOYMENT.md`](./docs/AZURE_ARCHITECTURE_AND_DEPLOYMENT.md) | Architecture deep-dive + full Azure deployment guide |

---

## 🐳 Docker (Production)

Each app has its own `Dockerfile`. To build and run the full stack locally via Docker Compose:

```bash
docker-compose -f infrastructure/docker-compose.yml up --build
```

---

## 🤝 Contributing

1. Fork the repo and create a feature branch (`git checkout -b feat/your-feature`)
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`)
3. Run `pnpm lint && pnpm typecheck && pnpm test` before pushing
4. Open a pull request

---

## 📜 License

Private — All rights reserved.
