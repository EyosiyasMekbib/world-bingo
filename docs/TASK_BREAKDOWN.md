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
- [x] Admin Dashboard
    - [x] Global Stats Dashboard (Approved Deposits, Profit, Users, etc.)
    - [x] Pending Deposits Review (Receipt viewing, Approve/Decline)
    - [x] Withdrawal Management (Manual fulfillment flow)
    - [x] Orders History (Deposit/Withdrawal logs)
    - [x] Manager Profile & Security Settings (Password change, 2FA placeholder)
- [x] **File Uploads**: Implement receipt upload for manual deposits via local storage (GCS for prod).
- [x] **Refund System**: Automated handling/jobs to auto-refund users upon game cancellation.
- [x] **Live Game Play Page**: Full real-time bingo play with auto-marking, pattern detection, and BINGO claim.
- [x] **BullMQ Workers**: Background workers for refund, notification, and game engine processing.
- [x] **BullMQ Dashboard**: Visual monitoring at `/admin/queues`.

#### **Phase 2: Scale and Infrastructure**
- [x] **BullMQ Integration**: Implemented background workers for handling async refunds, notifications, and game engine.
- [x] **WebSocket Redis Adapter**: Implemented and tested for horizontal scaling.
- [ ] **Monitoring & Grafana**: Set up Prometheus/Grafana basic stack in Docker configuration.

#### **Phase 3: Manual Payment Flow Hardening**
- [x] Manual deposit flow: User transfers via TeleBirr to merchant (0901977670), then submits form with Amount, Transaction ID, Name, TeleBirr Account Number, and receipt screenshot.
- [x] Admin receipt verification: Admin views uploaded receipt, cross-checks with form data, approves or declines.
- [x] Manual withdrawal fulfillment: Admin sends funds via TeleBirr, marks request as approved.
- [ ] Add Transaction ID and TeleBirr Account Number fields to deposit form and schema.
- [ ] Add 15-minute transfer deadline display and stale request handling.
- [ ] Add input mismatch detection helpers for admin review.

#### **Phase 4: Growth / Expansion**
- [ ] Implement referral program features.
- [ ] Add i18n support for Amharic.
- [ ] Plan and build tournament mode & progressive jackpots.

---

## 🎯 Immediate Next Steps
1. **Manual Payment Flow Hardening** — Add Transaction ID, Name, TeleBirr Account Number fields to deposit form; add 15-min transfer deadline display; admin receipt-vs-form cross-check UX.
2. **API Integration Tests** to validate end-to-end flows with a test database.
3. **Web App E2E Tests** (Playwright) covering auth, game, and wallet flows.
4. **Monitoring** (Prometheus + Grafana) for production observability.
