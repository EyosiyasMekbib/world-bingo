# World Bingo — Task Breakdown

Based on the [Project Bible](./BINGO_PROJECT_BIBLE.md) and the current state of the monorepo, here is an assessment of what has been implemented so far and what remains to be done.

## 📊 Current Implementation State

The project uses a Turborepo architecture with `apps` (`api`, `web`, `admin`) and `packages` (`game-logic`, `shared-types`, `ui`). 

### ✅ What is DONE
1. **Core Architecture & Tooling**
   - Turborepo setup with shared `pnpm` workspaces.
   - Database schema and ORM (Prisma) configured for PostgreSQL.
   - Types and schemas (`@world-bingo/shared-types`) are scaffolded.
2. **Game Logic Engine (`packages/game-logic`)**
   - Cartela logic, pattern generation, matching, and validation.
   - Prize and ball generation modules.
   - Unit tests are written and passing.
3. **Player Web App (`apps/web`)**
   - Skeleton structure using Nuxt 3.
   - Shared UI components (`packages/ui`) implemented (e.g., `AppHeader.vue`, `GameRoomCard.vue`, `CartelaGrid.vue`, `BingoBall.vue`).
   - Basic pages for login/registration and quick matching.
4. **Backend API (`apps/api`)**
   - Fastify server setup with base route architecture.
   - `auth`, `game`, and `wallet` routes scaffolded.
   - Core dependencies (Socket.io, BullMQ, Redis implementations defined in package.json).

---

### ⏳ What is IN PROGRESS (Partially Done)
1. **End-to-End WebSocket Flow**
   - Current API route handlers exist, but robust Redis pub-sub integration and socket adapter needs validation for production use.
2. **Wallet Logic**
   - Routes for deposit and withdrawal requests exist, but transactional row-locking mechanisms via `SELECT FOR UPDATE` need security audits and completion.
3. **Player Web App (Nuxt UI)**
   - Wireframing and components are present, but real-time connection state management and dynamic UI updates via WebSocket events need to be wired.

---

### ❌ What NEEDS TO BE DONE (Pending)

#### **Phase 1: MVP Finishers**
- [ ] **Admin Dashboard (`apps/admin`)**: Currently an empty shell. Needs implementation for payment/deposit verification and game management interfaces.
- [ ] **File Uploads**: Implement receipt upload for manual deposits via Google Cloud Storage (or a local mock for now).
- [ ] **Refund System**: Automated handling/jobs to auto-refund users upon game cancellation.

#### **Phase 2: Scale and Infrastructure**
- [ ] **BullMQ Integration**: Implement background workers for handling async refunds and notifications robustly to reduce API bloat.
- [ ] **WebSocket Redis Adapter Testing**: Test and finalize horizontal scaling capabilities for the Socket.io implementation.
- [ ] **Monitoring & Grafana**: Set up Prometheus/Grafana basic stack in Docker configuration.

#### **Phase 3: Payment Automation Integration**
- [ ] Incorporate Chapa API for deposits.
- [ ] Incorporate Telebirr API integration.
- [ ] Establish automated webhooks for deposit success/fail states.

#### **Phase 4: Growth / Expansion**
- [ ] Implement referral program features.
- [ ] Add i18n support for Amharic.
- [ ] Plan and build tournament mode & progressive jackpots.

---

## 🎯 Immediate Next Steps
1. **Build the Admin Dashboard** (`apps/admin`) to allow real manual approval tests.
2. **Wire Web App Sockets**, confirming that actual Cartela data flows seamlessly from the Fastify socket backend to the Pinia stores on the frontend.
3. **Verify Wallet Locking Mechanisms**, ensuring database transactions handle race conditions correctly before real money is simulated.
