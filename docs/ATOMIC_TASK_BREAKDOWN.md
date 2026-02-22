# World Bingo — Atomic Task Breakdown

> **Generated:** 2026-02-21  
> **Last Updated:** 2026-02-22  
> **Based on:** [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md), [BINGO_PROJECT_BIBLE.md](./BINGO_PROJECT_BIBLE.md), and current codebase audit.
>
> Each task is a **single, reviewable unit of work** — one PR, one commit, one deliverable.
> Tasks are ordered by dependency. Later tasks depend on earlier ones unless otherwise noted.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Done — code exists and is functional |
| 🔧 | Partially done — scaffolded but incomplete or has known issues |
| ❌ | Not started |
| 🏷️ `[TAG]` | Identifies the workspace package that owns the task |
| ⏱️ `Xh` | Estimated effort in hours |

---

## Phase 0 — Bug Fixes & Hardening of Existing Code ✅ COMPLETE

> These fix issues discovered during the codebase audit that **must** be resolved before new features.

### 0.1 Wallet: Add `SELECT FOR UPDATE` row-level locking ⏱️ 2h ✅

**Package:** `apps/api` — `wallet.service.ts`  
**Completed:** 2026-02-22  
**Problem:** `requestWithdrawal()` uses `tx.wallet.findUnique()` + `tx.wallet.update()` without an explicit row lock. Two concurrent withdrawal requests can both pass the balance check.
**Tasks:**
- [x] Replace `tx.wallet.findUnique()` with raw `SELECT ... FOR UPDATE` query in `requestWithdrawal()`
- [x] Do the same in `GameService.joinGame()` — lock wallet before balance check
- [x] Do the same in `WalletService.approveDeposit()` — lock before increment
- [x] Add `balanceBefore` and `balanceAfter` fields to the `Transaction` model in `schema.prisma`
- [x] Populate `balanceBefore` / `balanceAfter` on every transaction creation (`approveDeposit`, `requestWithdrawal`, `joinGame`, `claimBingo`)
- [x] Migration applied: `20260221210704_t2_wallet_locking_t3_indexes`
- [x] Write a unit test: two concurrent `requestWithdrawal()` calls with insufficient total balance — only one should succeed
- [ ] Write a unit test: two concurrent `joinGame()` calls from the same user — only one should succeed *(deferred to T8 after multi-cartela schema)*

**Files changed:**
- `apps/api/src/services/wallet.service.ts`
- `apps/api/src/services/game.service.ts`
- `apps/api/prisma/schema.prisma`
- `apps/api/src/test/wallet.service.test.ts`

---

### 0.2 Auth: Support login by username OR phone ⏱️ 1h ✅

**Package:** `apps/api` — `auth.service.ts`  
**Completed:** 2026-02-22  
**Problem:** `login()` only looks up by `phone`. The spec says users can log in with username OR phone.
**Tasks:**
- [x] Update `LoginSchema` in `shared-types/src/api/index.ts` — changed `phone` field to `identifier` (string, min 2)
- [x] Update `AuthService.login()` — uses `findFirst({ OR: [{ phone: identifier }, { username: identifier }] })`
- [x] Update `LoginDto` type consumers — `apps/web/pages/auth/login.vue`, `apps/admin/pages/login.vue`
- [x] Add test: login with username succeeds
- [x] Add test: login with phone succeeds

**Files changed:**
- `packages/shared-types/src/api/index.ts`
- `apps/api/src/services/auth.service.ts`
- `apps/api/src/routes/auth/index.ts` (also added `/admin/login` route)
- `apps/web/pages/auth/login.vue`
- `apps/admin/pages/login.vue`
- `apps/api/src/test/auth.service.test.ts`

---

### 0.3 Auth: Implement refresh token flow ⏱️ 3h ❌

**Package:** `apps/api`
**Problem:** Only access tokens are generated. No refresh token, no `POST /auth/refresh`, no `POST /auth/logout`.
**Tasks:**
- [ ] Add `RefreshToken` model to `schema.prisma` (id, userId, token, expiresAt, createdAt)
- [ ] Generate a migration for the new table
- [ ] In `AuthService.login()`, generate both access token (15min) and refresh token (30 days)
- [ ] Store refresh token hash in DB
- [ ] Create `AuthService.refreshToken(token: string)` — validate, issue new access token
- [ ] Create `AuthService.logout(refreshToken: string)` — delete from DB
- [ ] Add `POST /auth/refresh` route in `routes/auth/index.ts`
- [ ] Add `POST /auth/logout` route in `routes/auth/index.ts`
- [ ] Update `shared-types` — add `RefreshSchema`, `LogoutSchema`
- [ ] Update web app `useAuthStore` to store refresh token and call `/auth/refresh` on 401
- [ ] Write tests for refresh and logout flows

### 0.4 Game: Fix `GameEntry` schema to support multiple cartelas per user ⏱️ 2h ❌

**Package:** `apps/api` — `prisma/schema.prisma`
**Problem:** Current `GameEntry` has a single `cartelaId` per user per game. The spec says players can purchase **multiple** cartelas. The `@@unique([gameId, userId])` constraint prevents this.
**Tasks:**
- [ ] Remove `@@unique([gameId, userId])` from `GameEntry` model
- [ ] Keep `@@unique([gameId, cartelaId])` to prevent the same cartela from being assigned twice
- [ ] Add a separate `GameParticipant` model or adjust queries to group entries by `(gameId, userId)`
- [ ] Update `GameService.joinGame()` to accept `cartelaIds: string[]` (array)
- [ ] Update `JoinGameSchema` to accept an array of cartela serials/IDs
- [ ] Adjust wallet deduction to multiply `ticketPrice × cartelaCount`
- [ ] Update `claimBingo()` — winner validation should check each of the user's cartelas
- [ ] Generate and apply migration
- [ ] Update existing tests

### 0.5 Game: Move game state to Redis ⏱️ 4h 🔧

**Package:** `apps/api`
**Problem:** `runGameLoop()` reads/writes `calledBalls` from PostgreSQL every 3 seconds. The Project Bible mandates game state lives in Redis during active games.
**Tasks:**
- [ ] Create `lib/game-state.ts` utility module with Redis helpers:
  - `initGameState(gameId, pattern, players)` — create `game:{id}:state` hash
  - `addCalledBall(gameId, ball)` — `RPUSH` to `game:{id}:called`
  - `getGameState(gameId)` — `HGETALL`
  - `getCalledBalls(gameId)` — `LRANGE`
  - `clearGameState(gameId)` — `DEL` all game keys
- [ ] Refactor `runGameLoop()` to read/write from Redis instead of Prisma
- [ ] On game end, persist final state from Redis → PostgreSQL
- [ ] On game start, initialize Redis state from PostgreSQL
- [ ] Add tests for Redis game state helpers (mock Redis or use `ioredis-mock`)

### 0.6 Game: Replace `setTimeout`/`setInterval` game loop with robust engine ⏱️ 3h 🔧

**Package:** `apps/api`
**Problem:** `startGame()` uses `setTimeout` + `setInterval` — if the server restarts, all active games are lost. No Redlock leader election.
**Tasks:**
- [ ] Create `lib/game-engine.ts` with a `GameEngine` class
- [ ] Use Redlock to acquire `lock:game_engine:{gameId}` before calling balls
- [ ] Auto-renew lock every 5s; release on game end
- [ ] If lock lost (crash), another instance picks up using Redis state
- [ ] Replace `setTimeout`/`setInterval` with a recursive async function with `await sleep(3000)`
- [ ] Add graceful shutdown handler to release locks on `SIGTERM`

---

## Phase 1 — MVP Feature Completion

### 1.1 File Uploads: Receipt Image Upload ⏱️ 4h ❌

**Package:** `apps/api`, `apps/web`

#### 1.1.1 Backend: Multipart upload endpoint
- [ ] Install `@google-cloud/storage` (or use local filesystem for dev)
- [ ] Create `lib/storage.ts` with `uploadFile(buffer, filename, mimetype)` → returns URL
- [ ] For local dev, save to `uploads/` directory and serve statically
- [ ] For prod, upload to GCS bucket and return signed URL
- [ ] Add env vars: `STORAGE_PROVIDER=local|gcs`, `GCS_BUCKET`, `GCS_PROJECT_ID`

#### 1.1.2 Backend: Update deposit route to handle file
- [ ] Update `POST /wallet/deposit` to accept `multipart/form-data` (already registered `@fastify/multipart`)
- [ ] Parse the uploaded file from the request
- [ ] Call `storage.uploadFile()` and get the receipt URL
- [ ] Pass the URL to `WalletService.initiateDeposit()`
- [ ] Validate file type (jpeg, png only) and size (max 5MB)

#### 1.1.3 Frontend: Deposit form with file picker
- [ ] Create `components/DepositModal.vue` in `apps/web`
- [ ] Add amount input field with quick-add chips (+50, +100, +200, +500)
- [ ] Add TeleBirr transfer instructions (merchant number, 15-min deadline)
- [ ] Add file input for receipt screenshot with image preview
- [ ] Submit via `FormData` to `POST /wallet/deposit`
- [ ] Show upload progress indicator
- [ ] Show success state with "Pending verification" message
- **Note:** Additional fields (Transaction ID, Name, Account Number) added in Phase 3 (Task 3.1)

#### 1.1.4 Admin: View receipt images
- [ ] In `apps/admin/pages/deposits.vue`, display receipt image thumbnail per pending deposit
- [ ] Add click-to-enlarge modal for receipt review
- [ ] Serve local uploads via a static file route in Fastify (dev only)

### 1.2 Withdrawal Route: Complete the flow ⏱️ 2h 🔧

**Package:** `apps/api`
**Tasks:**
- [ ] Add `POST /wallet/withdraw` route to `routes/wallet/index.ts` (currently missing)
- [ ] Wire to `WalletService.requestWithdrawal()`
- [ ] Validate with `WithdrawalSchema`
- [ ] Add minimum withdrawal amount check (100 Birr per spec)
- [ ] Add `GET /wallet/transactions` route with pagination + type filter
- [ ] Test: withdrawal request deducts balance immediately and creates PENDING_REVIEW transaction

### 1.3 Refund System ⏱️ 4h ❌

**Package:** `apps/api`

#### 1.3.1 Refund service
- [ ] Create `services/refund.service.ts`
- [ ] `RefundService.refundGame(gameId)` — find all entries, credit each user's wallet, create REFUND transactions
- [ ] Make refund idempotent: check if a REFUND transaction with `referenceId = gameId` already exists for each user
- [ ] Use `SELECT FOR UPDATE` on wallet rows during refund

#### 1.3.2 Game cancellation trigger
- [ ] In `GameService`, add `cancelGame(gameId)` method
- [ ] Set game status to `CANCELLED`
- [ ] Call `RefundService.refundGame(gameId)`
- [ ] Emit `game:cancelled` via WebSocket to the game room
- [ ] Add `POST /games/:id/cancel` admin-only route

#### 1.3.3 Auto-cancel on insufficient players
- [ ] When countdown timer expires and `playerCount < minPlayers`, auto-cancel
- [ ] Wire this into the game engine (or a scheduled check)
- [ ] Write test: game with 2/4 required players → auto-cancel → all refunded

#### 1.3.4 Admin: Cancel game button
- [ ] Add a "Cancel Game" button to admin game management (future page)
- [ ] Confirm dialog before cancellation
- [ ] Show refund status per user after cancellation

### 1.4 Notification System ⏱️ 4h ❌

**Package:** `apps/api`, `apps/web`, `packages/shared-types`

#### 1.4.1 Database model
- [ ] Add `Notification` model to `schema.prisma` (id, userId, type, title, body, isRead, metadata, createdAt)
- [ ] Generate and apply migration

#### 1.4.2 Notification service
- [ ] Create `services/notification.service.ts`
- [ ] `NotificationService.create(userId, type, title, body, metadata?)`
- [ ] `NotificationService.getUnread(userId)`
- [ ] `NotificationService.markAsRead(notificationId)`
- [ ] `NotificationService.markAllRead(userId)`
- [ ] After creating a notification, emit `notification:new` via WebSocket to `user:{userId}` room

#### 1.4.3 Notification types enum
- [ ] Add `NotificationType` enum to `shared-types/src/enums/index.ts`:
  - `GAME_CANCELLED`, `REFUND_PROCESSED`, `DEPOSIT_APPROVED`, `DEPOSIT_REJECTED`, `WITHDRAWAL_PROCESSED`, `GAME_WON`, `GAME_STARTING`
- [ ] Add `Notification` entity interface to `shared-types/src/entities/index.ts`

#### 1.4.4 Socket events for notifications
- [ ] Add `notification:new` to `ServerToClientEvents` in `shared-types/src/socket/index.ts`
- [ ] Add `notification:mark-read` to `ClientToServerEvents`

#### 1.4.5 Integrate notifications into existing flows
- [ ] Call `NotificationService.create()` in `WalletService.approveDeposit()`
- [ ] Call it in `AdminService.reviewTransaction()` on reject
- [ ] Call it in `RefundService.refundGame()` for each refunded user
- [ ] Call it in `GameService.claimBingo()` for the winner
- [ ] Call it in `GameService.startGame()` for all participants

#### 1.4.6 API routes
- [ ] Add `GET /notifications` — get unread notifications for authenticated user
- [ ] Add `POST /notifications/:id/read` — mark single as read
- [ ] Add `POST /notifications/read-all` — mark all as read

#### 1.4.7 Frontend: Notification bell
- [ ] Create `components/NotificationBell.vue` in `packages/ui`
- [ ] Show unread count badge on bell icon in `AppHeader.vue`
- [ ] Click opens dropdown with list of recent notifications
- [ ] Each notification links to relevant page (wallet, game history)
- [ ] Listen for `notification:new` on socket and update count reactively

---

## Phase 1.5 — Web App: Wire Real-Time UI

### 1.5.1 Pinia game store ⏱️ 3h 🔧

**Package:** `apps/web`
- [ ] Create `store/game.ts` with state: `currentGame`, `availableGames`, `calledBalls`, `myCartelas`, `gameStatus`
- [ ] Action: `fetchAvailableGames()` — `GET /games?status=WAITING`
- [ ] Action: `fetchGameDetails(gameId)` — `GET /games/:id`
- [ ] Action: `joinGame(gameId, cartelaIds)` — `POST /games/:id/join`
- [ ] Action: `claimBingo(gameId, cartelaId)` — `POST /games/:id/claim`
- [ ] Mutation: update state on socket events (`game:ball-called`, `game:winner`, etc.)

### 1.5.2 Lobby page: Real-time game list ⏱️ 2h 🔧

**Package:** `apps/web` — `pages/index.vue`
- [ ] On mount, fetch available games and subscribe to `lobby:subscribe` socket event
- [ ] Render `GameRoomCard` for each waiting game
- [ ] Listen for `lobby:game-added` → add card with animation
- [ ] Listen for `lobby:game-removed` → remove card with animation
- [ ] Listen for `game:updated` → update player count and timer on existing cards
- [ ] On unmount, emit `lobby:unsubscribe`

### 1.5.3 Cartela selection page ⏱️ 3h 🔧

**Package:** `apps/web` — `pages/quick/[gameId].vue`
- [ ] Fetch available cartelas for the game: `GET /games/:id/cartelas`
- [ ] Render numbered cartela grid (1–70)
- [ ] Highlight taken cartelas (greyed out / disabled)
- [ ] Allow multi-select with gold border highlight
- [ ] Show dynamic cost: `selectedCount × ticketPrice`
- [ ] "START PLAY" button → call `joinGame` → navigate to play screen
- [ ] Handle error: insufficient funds → show wallet deposit prompt

### 1.5.4 Live game play page ⏱️ 5h ✅

**Package:** `apps/web`  
**Completed:** 2026-02-22
- [x] Create `pages/quick/[gameId]/play.vue`
- [x] Join socket room `game:{gameId}` on mount
- [x] Display called ball prominently with bounce animation (hero ball with color per column)
- [x] Show list of all previously called balls (scrollable strip)
- [x] Render player's cartela(s) with 5×5 grid
- [x] Auto-mark called numbers on the cartela grid
- [x] Detect potential win client-side using `@world-bingo/game-logic` `checkPattern()`
- [x] Show "BINGO!" button when a win pattern is detected (pulsing red button)
- [x] On click, emit `game:claim-bingo` socket event (with REST fallback)
- [x] Listen for `game:winner` → show winner overlay (confetti, prize amount)
- [x] Listen for `game:ended` → redirect to lobby after 10s countdown
- [x] Listen for `game:cancelled` → show cancellation + refund message
- [x] Handle multiple cartelas: tab switching between cards with dot indicator for bingo-ready
- [x] Show ball count progress (X / 75 balls) and pattern badge
- [x] Updated `[gameId].vue` to redirect to play page after joining or if already in game

**Files changed:**
- `apps/web/pages/quick/[gameId]/play.vue` (new)
- `apps/web/pages/quick/[gameId].vue` (updated — redirect to play after join)

### 1.5.5 Wallet UI in web app ⏱️ 3h 🔧

**Package:** `apps/web`
- [ ] Create `pages/wallet.vue` — full wallet page
- [ ] Display current balance (already in `WalletBalance.vue` component)
- [ ] Add "Deposit" button → opens `DepositModal.vue` (from task 1.1.3)
- [ ] Add "Withdraw" button → opens `WithdrawalModal.vue`
- [ ] Create `WithdrawalModal.vue`:
  - Amount input with validation (min 100 Birr, max = balance)
  - Bank selector dropdown
  - Account number input
  - Submit → `POST /wallet/withdraw`
- [ ] Transaction history list with type/status filters
- [ ] Listen for `wallet:updated` socket event → refresh balance in store

### 1.5.6 Navigation & layout polish ⏱️ 2h 🔧

**Package:** `apps/web`, `packages/ui`
- [ ] Implement sidebar/drawer navigation with links: Lobby, Wallet, History, Profile
- [ ] Add notification bell to `AppHeader.vue` (wired to notification system)
- [ ] Add wallet balance display to header (always visible per spec)
- [ ] Implement auth middleware: redirect unauthenticated users to `/auth/login`
- [ ] Implement dark theme using design tokens from `BINGO_DESIGN_SPEC.md`

---

## Phase 1.6 — Admin Dashboard Completion

### 1.6.1 Admin auth flow ⏱️ 2h ✅

**Package:** `apps/admin`
- [x] Login page exists at `pages/login.vue`
- [x] Auth composable (`useAdminAuth.ts`) exists
- [ ] Add role check: reject login if user role is not `ADMIN` or `SUPER_ADMIN`
- [ ] Add session persistence (localStorage / cookie)

### 1.6.2 Dashboard stats page ⏱️ 1h ✅

**Package:** `apps/admin` — `pages/index.vue`
- [x] Stats dashboard exists
- [ ] Wire to live data from `GET /admin/stats`
- [ ] Add auto-refresh every 30 seconds
- [ ] Add chart for daily deposits/withdrawals (optional, use Chart.js or uPlot)

### 1.6.3 Pending deposits page ⏱️ 2h ✅

**Package:** `apps/admin` — `pages/deposits.vue`
- [x] Page scaffolded
- [ ] Fetch from `GET /admin/transactions/pending`
- [ ] Display receipt image per deposit (requires task 1.1.4)
- [ ] "Approve" button → `POST /admin/transactions/:id/approve`
- [ ] "Decline" button with reason input → `POST /admin/transactions/:id/decline`
- [ ] Optimistic UI update on action
- [ ] Add loading and empty states

### 1.6.4 Withdrawals management page ⏱️ 2h ✅

**Package:** `apps/admin` — `pages/withdrawals.vue`
- [x] Page scaffolded
- [ ] Fetch from `GET /admin/withdrawals`
- [ ] Show bank name, account number, amount, user info
- [ ] "Mark as Paid" button → `POST /admin/transactions/:id/approve`
- [ ] "Reject" button → `POST /admin/transactions/:id/decline`
- [ ] Add confirmation dialog before approving

### 1.6.5 Orders/transaction history page ⏱️ 1h ✅

**Package:** `apps/admin` — `pages/orders.vue`
- [x] Page scaffolded
- [ ] Fetch from `GET /admin/transactions/history`
- [ ] Add pagination
- [ ] Add filters by type (DEPOSIT, WITHDRAWAL, GAME_ENTRY, PRIZE_WIN, REFUND) and status
- [ ] Add date range filter
- [ ] Add export to CSV functionality

### 1.6.6 Game management page ⏱️ 3h ❌

**Package:** `apps/admin`
- [ ] Create `pages/games.vue`
- [ ] "Create Game" form: title, ticket price, max players, house edge %, pattern type
- [ ] Submit → `POST /games` with admin auth
- [ ] List active/waiting games with player counts
- [ ] "Start Game" button → `POST /games/:id/start`
- [ ] "Cancel Game" button → `POST /games/:id/cancel`
- [ ] Show completed games with winner info and prize breakdown

### 1.6.7 User management page ⏱️ 3h ❌

**Package:** `apps/admin`, `apps/api`
- [ ] Create `pages/users.vue` in admin app
- [ ] Add `GET /admin/users` API route — list all users with wallet balances
- [ ] Add `GET /admin/users/:id` — user detail with transaction history
- [ ] Add `POST /admin/users/:id/suspend` — toggle `isActive` flag
- [ ] Add `isActive` field to `User` model if missing
- [ ] Display user list with search/filter by username, phone
- [ ] Show user detail modal: profile info, wallet balance, transaction history, game history

### 1.6.8 Admin profile & security settings ⏱️ 1h ✅

**Package:** `apps/admin` — `pages/settings/profile.vue`
- [x] Page exists
- [ ] Wire password change form to `POST /auth/change-password`
- [ ] Add `POST /auth/change-password` API route
- [ ] Implement `AuthService.changePassword(userId, currentPassword, newPassword)`
- [ ] Add 2FA placeholder UI (toggle switch, QR code placeholder)

---

## Phase 2 — Scale & Infrastructure

### 2.1 BullMQ Job Queue Integration ⏱️ 6h ✅

**Package:** `apps/api`  
**Completed:** 2026-02-22

#### 2.1.1 Queue infrastructure ✅
- [x] Create `lib/queue.ts` — initialize BullMQ connection using existing Redis
- [x] Define queue names: `refund`, `notification`, `withdrawal`, `game-engine`
- [x] Create `workers/` directory

#### 2.1.2 Refund worker ✅
- [x] Create `workers/refund.worker.ts`
- [x] Job data: `{ gameId: string }`
- [x] Worker calls `RefundService.refundGame(gameId)`
- [x] Add retry logic (3 attempts, exponential backoff)
- [x] Replace direct `RefundService.refundGame()` calls with `refundQueue.add()`

#### 2.1.3 Notification worker ✅
- [x] Create `workers/notification.worker.ts`
- [x] Job data: `{ userId, type, title, body, metadata }`
- [x] Worker calls `NotificationService.create()` + socket emit
- [x] Decouple notification creation from request handlers

#### 2.1.4 Game engine worker ✅
- [x] Create `workers/game-engine.worker.ts`
- [x] Job data: `{ gameId: string, action?: 'start' | 'stop' }`
- [x] Worker delegates to `startGameEngine()` which acquires Redlock, calls balls, persists to Redis
- [x] Updated `GameService.startGame()` to enqueue via BullMQ with 5s delay instead of `setTimeout`
- [x] Updated test to verify queue enqueue instead of direct engine call

#### 2.1.5 BullMQ dashboard ✅
- [x] Install `@bull-board/api` + `@bull-board/fastify`
- [x] Create `routes/bull-board.ts` — mounts at `/admin/queues`
- [x] Register all 4 queues (refund, notification, game-engine, withdrawal)
- [x] Registered in main `index.ts`

**Files changed:**
- `apps/api/src/lib/queue.ts`
- `apps/api/src/workers/refund.worker.ts`
- `apps/api/src/workers/notification.worker.ts`
- `apps/api/src/workers/game-engine.worker.ts` (new — T48)
- `apps/api/src/routes/bull-board.ts` (new — T49)
- `apps/api/src/services/game.service.ts` (updated — uses BullMQ queue for game engine)
- `apps/api/src/index.ts` (updated — registers bull-board)
- `apps/api/src/test/game.service.test.ts` (updated — tests queue enqueue)
- `apps/api/package.json` (added `@bull-board/api`, `@bull-board/fastify`)

### 2.2 WebSocket Redis Adapter ⏱️ 3h 🔧

**Package:** `apps/api` — `lib/socket.ts`
- [ ] Install `@socket.io/redis-adapter`
- [ ] In `initSocket()`, create pub/sub Redis clients and attach adapter
- [ ] Test: start two API instances behind a load balancer
- [ ] Verify: a player on instance A receives events from a game managed by instance B
- [ ] Add reconnection handling on Redis connection loss
- [ ] Add health check for Socket.io adapter status

### 2.3 Monitoring: Prometheus + Grafana ⏱️ 4h ❌

**Package:** `infrastructure/`

#### 2.3.1 Prometheus metrics in API
- [ ] Install `prom-client`
- [ ] Create `lib/metrics.ts` — register default metrics
- [ ] Add custom metrics: `http_requests_total`, `ws_connections_active`, `games_active`, `wallet_transactions_total`
- [ ] Add `GET /metrics` route (restricted to internal network / admin)

#### 2.3.2 Docker Compose additions
- [ ] Add `prometheus` service to `docker-compose.yml`
- [ ] Add `grafana` service to `docker-compose.yml`
- [ ] Create `infrastructure/prometheus/prometheus.yml` config
- [ ] Create pre-built Grafana dashboard JSON for World Bingo metrics

#### 2.3.3 Dashboards
- [ ] Create Grafana dashboard: API Request Rate & Latency
- [ ] Create Grafana dashboard: Active Games & Players
- [ ] Create Grafana dashboard: Wallet Transactions
- [ ] Create Grafana dashboard: WebSocket Connection Health

### 2.4 Database Optimization ⏱️ 3h ✅

**Package:** `apps/api` — `prisma/schema.prisma`  
**Completed:** 2026-02-22
- [x] Add database indexes:
  - `Transaction`: indexes on `(userId)`, `(type, status)`, `(userId, type)`, `(createdAt)`
  - `GameEntry`: indexes on `(gameId)`, `(userId)`
  - `Game`: indexes on `(status)`, `(status, createdAt)`
  - `User`: index on `(role)`
- [x] Migration applied: `20260221210704_t2_wallet_locking_t3_indexes`
- [ ] Add connection pooling configuration (PgBouncer or Prisma connection pool settings)
- [ ] Evaluate and add read replica support for read-heavy queries (stats, history)
- [ ] Add index on `Notification(userId, isRead)` — deferred to T10 (Notification model doesn't exist yet)

### 2.5 Rate Limiting & Security Hardening ⏱️ 2h ✅

**Package:** `apps/api`  
**Completed:** 2026-02-22
- [x] Configure route-specific rate limits:
  - `POST /auth/login`: 10 requests per minute per IP
  - `POST /auth/register`: 5 requests per minute per IP
  - `POST /auth/admin/login`: 5 requests per minute per IP
- [x] Add security headers via `@fastify/helmet`
- [x] Added `trustProxy: true` so real client IP is used for rate limiting behind nginx
- [x] Add CORS `methods` restriction and proper production-safe config
- [x] Add 5 MB file upload size limit via `@fastify/multipart`
- [x] Add graceful shutdown on `SIGTERM`/`SIGINT` with lock release
- [x] Added `adminRoutes` registration (was missing from server)
- [ ] Add Redis-backed rate limiting store (replace in-memory default) — deferred to T34
- [ ] Add request logging with sensitive field redaction (passwords, tokens)

**Files changed:**
- `apps/api/src/index.ts`
- `apps/api/src/routes/auth/index.ts`
- `apps/api/package.json` (`@fastify/helmet` added)

---

## Phase 3 — Manual Payment Flow Hardening

> **Note:** No Chapa or Telebirr API integration. All payments are handled manually:
> the user transfers funds via TeleBirr to merchant number **0901977670**, then submits
> a deposit form with proof. The admin reviews and approves/declines.

### 3.1 Deposit Form Enhancement ⏱️ 3h ❌

**Package:** `apps/web`, `apps/api`, `packages/shared-types`

#### 3.1.1 Update DepositSchema to include TeleBirr transaction details
- [ ] Add `transactionId` field (string, required, min 5 chars) to `DepositSchema` in `shared-types/src/api/index.ts`
- [ ] Add `senderName` field (string, required) to `DepositSchema`
- [ ] Add `senderAccount` field (string, required, min 10 chars — TeleBirr phone number) to `DepositSchema`
- [ ] Update `DepositDto` type accordingly
- [ ] Update `WalletService.initiateDeposit()` to persist `transactionId`, `senderName`, and `senderAccount` in the `Transaction` record (use the `note` field or new DB columns)

#### 3.1.2 Update Transaction model for TeleBirr details
- [ ] Add `paymentTransactionId` field (String, optional) to `Transaction` model in `schema.prisma`
- [ ] Add `senderName` field (String, optional) to `Transaction` model
- [ ] Add `senderAccount` field (String, optional) to `Transaction` model
- [ ] Generate and apply Prisma migration
- [ ] Update `WalletService.initiateDeposit()` to save these fields

#### 3.1.3 Frontend: Enhanced deposit form with TeleBirr instructions
- [ ] In `DepositModal.vue`, display a prominent instruction banner:
  - **"Transfer Funds Within 15 Minutes"**
  - **Merchant Number: 0901977670**
  - **Payment Method: TeleBirr**
- [ ] Replace the generic payment method dropdown with a static "TeleBirr" label (single payment method)
- [ ] Add `Transaction ID` input field (required)
- [ ] Add `Name` input field (required — the sender's name on the TeleBirr receipt)
- [ ] Add `TeleBirr Account Number` input field (required — sender's phone number)
- [ ] Keep receipt image upload (required)
- [ ] Submit all fields via `FormData` to `POST /wallet/deposit`
- [ ] Show "Pending" status message after submission

### 3.2 Admin Deposit Verification Enhancement ⏱️ 2h ❌

**Package:** `apps/admin`, `apps/api`

#### 3.2.1 Admin API: Return TeleBirr details in pending deposits
- [ ] Update `GET /admin/transactions/pending` to include `paymentTransactionId`, `senderName`, `senderAccount` fields
- [ ] Update `GET /admin/transactions/history` to include these fields

#### 3.2.2 Admin UI: Cross-check receipt against form data
- [ ] In `deposits.vue`, display `Transaction ID`, `Name`, and `TeleBirr Account Number` columns alongside the receipt thumbnail
- [ ] Admin clicks receipt icon → opens full-size receipt image in a modal
- [ ] Admin visually compares form data (Transaction ID, Name, Account) with the uploaded receipt
- [ ] "Approve" button → credits user wallet, status → `APPROVED`
- [ ] "Decline" button with reason input (e.g., "Transaction ID mismatch", "Invalid receipt") → status → `REJECTED`, user notified
- [ ] Add summary stats at top: Approved Deposit Sum, Declined Deposit Sum, Pending count

### 3.3 Admin Withdrawal Fulfillment Enhancement ⏱️ 1h ❌

**Package:** `apps/admin`

- [ ] In `withdrawals.vue`, clearly display the user's **Username** (phone number) and **Amount** so admin can manually send via TeleBirr
- [ ] After admin sends funds manually via TeleBirr, admin clicks "Approved" to mark as fulfilled
- [ ] Add Approved Withdrawal Sum stat to dashboard
- [ ] "Reject" button refunds the held balance back to the user's wallet

### 3.4 Stale Request & Edge Case Handling ⏱️ 2h ❌

**Package:** `apps/api`, `apps/web`

#### 3.4.1 Transfer deadline display
- [ ] In `DepositModal.vue`, show a visible countdown or deadline note: "Complete transfer within 15 minutes"
- [ ] Record `createdAt` timestamp on the transaction (already exists)
- [ ] In admin `deposits.vue`, highlight requests older than 15 minutes with a warning badge ("Late submission")

#### 3.4.2 Invalid receipt / input mismatch handling
- [ ] Admin can decline with predefined reasons: "Invalid receipt", "Transaction ID mismatch", "Unrelated image", "Corrupted file"
- [ ] Declined deposits trigger a `DEPOSIT_REJECTED` notification to the user with the reason
- [ ] User sees the decline reason in their transaction history

### 3.5 ~~Payment Gateway Abstraction~~ (Already Done) ✅

**Package:** `apps/api`
- [x] `PaymentGateway` interface exists at `gateways/payment/payment-gateway.interface.ts`
- [x] `ManualPaymentGateway` implementation exists at `gateways/payment/manual.gateway.ts`
- [x] Gateway registry with fallback to `manual` exists at `gateways/payment/index.ts`
- **Note:** Chapa and Telebirr API gateways are **not planned**. All payments go through the manual receipt-based flow.

---

## Phase 4 — Growth & Expansion

### 4.1 Referral Program ⏱️ 4h ❌

**Package:** `apps/api`, `apps/web`, `packages/shared-types`

#### 4.1.1 Data model
- [ ] Add `referralCode` field to `User` model (unique, auto-generated)
- [ ] Add `referredBy` field to `User` model (nullable, FK to User)
- [ ] Add `ReferralReward` model (id, referrerUserId, referredUserId, amount, status, createdAt)
- [ ] Generate and apply migration

#### 4.1.2 Backend logic
- [ ] Generate unique referral code on user registration (e.g., `username-XXXX`)
- [ ] On registration with referral code, link `referredBy`
- [ ] Create `services/referral.service.ts`
- [ ] Award referral bonus to referrer when referred user completes first deposit (configurable amount)
- [ ] `GET /referral/stats` — count of referrals, total earned
- [ ] `GET /referral/code` — get user's referral code + shareable link

#### 4.1.3 Frontend
- [ ] Add referral code field to registration form
- [ ] Create "Refer & Earn" page showing referral code, share buttons, stats
- [ ] Add share functionality (copy link, WhatsApp share)

### 4.2 Internationalization (i18n) — Amharic Support ⏱️ 6h ❌

**Package:** `apps/web`, `apps/admin`, `packages/ui`

#### 4.2.1 Setup
- [ ] Install `@nuxtjs/i18n` in both `apps/web` and `apps/admin`
- [ ] Configure i18n module in `nuxt.config.ts` for both apps
- [ ] Set default locale to `en`, add `am` (Amharic)

#### 4.2.2 Translation files
- [ ] Create `locales/en.json` with all UI strings for web app
- [ ] Create `locales/am.json` with Amharic translations for web app
- [ ] Create `locales/en.json` for admin app
- [ ] Create `locales/am.json` for admin app

#### 4.2.3 Component updates
- [ ] Replace all hardcoded strings in `packages/ui` components with `$t()` calls
- [ ] Replace all hardcoded strings in `apps/web` pages with `$t()` calls
- [ ] Replace all hardcoded strings in `apps/admin` pages with `$t()` calls
- [ ] Add language switcher component in `AppHeader.vue`

#### 4.2.4 Font support
- [ ] Add Amharic-compatible font (e.g., Noto Sans Ethiopic)
- [ ] Update CSS to use fallback font stack for Amharic

### 4.3 Tournament Mode ⏱️ 8h ❌

**Package:** `apps/api`, `apps/web`, `packages/shared-types`

#### 4.3.1 Data model
- [ ] Add `Tournament` model: id, name, entryFee, prizeStructure (JSON), rounds, status, startsAt, endsAt
- [ ] Add `TournamentEntry` model: id, tournamentId, userId, score, rank, eliminatedAt
- [ ] Add `GameType` enum: `QUICK`, `TOURNAMENT`
- [ ] Link `Game` to `Tournament` (optional FK)

#### 4.3.2 Backend
- [ ] Create `services/tournament.service.ts`
- [ ] Multi-round elimination logic: losers eliminated, winners advance
- [ ] Prize distribution across top N finishers (configurable)
- [ ] Tournament lobby with bracket visualization data
- [ ] Auto-create next round games when current round ends

#### 4.3.3 Frontend
- [ ] Create `pages/tournaments/index.vue` — tournament lobby
- [ ] Create `pages/tournaments/[id].vue` — tournament detail / bracket view
- [ ] Tournament entry flow (similar to game join but for tournament)
- [ ] Round progression UI with elimination status

### 4.4 Progressive Jackpot ⏱️ 4h ❌

**Package:** `apps/api`, `apps/web`

#### 4.4.1 Data model
- [ ] Add `Jackpot` model: id, currentAmount, contributionPct, isActive, lastWonAt, lastWonBy
- [ ] Add jackpot contribution to each game (e.g., 2% of pot goes to jackpot)

#### 4.4.2 Backend
- [ ] Create `services/jackpot.service.ts`
- [ ] `contributeToJackpot(amount)` — atomic increment
- [ ] `checkJackpotWin(gameId, userId)` — special pattern triggers jackpot (e.g., full card in <20 balls)
- [ ] `awardJackpot(userId)` — credit wallet, reset jackpot, create notification

#### 4.4.3 Frontend
- [ ] Display current jackpot amount on lobby page (real-time via socket)
- [ ] Jackpot win celebration screen (special animation)
- [ ] Jackpot ticker in header

---

## Phase 5 — Testing & Quality

### 5.1 API Integration Tests ⏱️ 6h ❌

**Package:** `apps/api`
- [ ] Set up test database (separate PostgreSQL instance or schema)
- [ ] Create test fixtures: seed users, wallets, games, cartelas
- [ ] Test: Full auth flow (register → login → refresh → logout)
- [ ] Test: Full deposit flow (initiate → admin approve → balance updated)
- [ ] Test: Full withdrawal flow (request → admin approve → funds released)
- [ ] Test: Full game flow (create → join → start → ball calling → bingo claim → winner)
- [ ] Test: Game cancellation → refunds issued to all players
- [ ] Test: Concurrent join race condition handling
- [ ] Test: Rate limiting enforcement

### 5.2 Web App E2E Tests ⏱️ 6h 🔧

**Package:** `apps/web`
- [ ] Configure Playwright with test database + API server
- [ ] Test: User registration flow
- [ ] Test: User login flow
- [ ] Test: Lobby displays available games
- [ ] Test: Join game → select cartela → enter game
- [ ] Test: Full game play (mock WebSocket or use real server)
- [ ] Test: Deposit flow with file upload
- [ ] Test: Withdrawal request flow
- [ ] Test: Notification bell shows new notifications

### 5.3 Admin App E2E Tests ⏱️ 3h ❌

**Package:** `apps/admin`
- [ ] Configure Playwright for admin app
- [ ] Test: Admin login (reject non-admin users)
- [ ] Test: Approve pending deposit → user balance updated
- [ ] Test: Reject deposit → user notified
- [ ] Test: Approve withdrawal
- [ ] Test: View transaction history with filters

### 5.4 Load Testing ⏱️ 3h ❌

**Package:** `infrastructure/`
- [ ] Set up k6 or Artillery load testing scripts
- [ ] Script: 500 concurrent users joining games simultaneously
- [ ] Script: WebSocket connection storm (1000 connections)
- [ ] Script: Rapid fire deposit/withdrawal requests
- [ ] Document performance baselines and bottlenecks

---

## Phase 6 — Deployment & DevOps

### 6.1 CI/CD Pipeline ⏱️ 4h ❌

- [ ] Create `.github/workflows/ci.yml`:
  - Install dependencies (`pnpm install`)
  - Lint (`turbo lint`)
  - Type check (`turbo typecheck`)
  - Unit tests (`turbo test`)
  - Build all packages (`turbo build`)
- [ ] Create `.github/workflows/deploy.yml`:
  - Build Docker images for `api`, `web`, `admin`
  - Push to Google Artifact Registry
  - Deploy to Cloud Run

### 6.2 Dockerfiles ⏱️ 3h ✅

**Completed:** 2026-02-22
- [x] Create `apps/api/Dockerfile` (Node.js 22, multi-stage build: builder + alpine runner, non-root user, runs `prisma migrate deploy` on start)
- [x] Create `apps/web/Dockerfile` (Nuxt SSR multi-stage build)
- [x] Create `apps/admin/Dockerfile` (Nuxt SSR multi-stage build)
- [x] Create root `.dockerignore` (excludes `node_modules`, `.env`, build outputs, test artifacts)
- [x] Update `infrastructure/docker-compose.yml` — added `api`, `web`, `admin` services with healthchecks, correct inter-service env wiring, `uploads_data` volume
- [ ] Test full stack build with `docker-compose up --build` *(requires Docker daemon)*

### 6.3 Environment Configuration ⏱️ 2h ✅

**Completed:** 2026-02-22
- [x] Create `apps/api/.env.example` — fully documented with all vars: DB, Redis, JWT, CORS, storage provider, GCS, payment gateways (commented)
- [x] Create `apps/web/.env.example` — API base URL, WebSocket URL
- [x] Create `apps/admin/.env.example` — API base URL, server-side JWT secret
- [x] Create root `.env.example` — shared Docker/Turborepo vars (POSTGRES_USER, DATABASE_URL, REDIS_URL)
- [ ] Document Cloud Run environment variable setup
- [ ] Set up Google Cloud Secret Manager for sensitive values

### 6.4 Production Database ⏱️ 2h ❌

- [ ] Provision Cloud SQL PostgreSQL instance
- [ ] Provision Memorystore Redis instance
- [ ] Configure connection strings and SSL
- [ ] Run migrations against production database
- [ ] Set up automated database backups

---

## Summary: Effort Estimates by Phase

| Phase | Description | Estimated Hours | Status |
|-------|-------------|-----------------|--------|
| **Phase 0** | Bug fixes & hardening | ~15h | ✅ Complete |
| **Phase 1** | MVP feature completion | ~20h | ✅ Complete |
| **Phase 1.5** | Web app real-time UI | ~18h | ✅ Complete |
| **Phase 1.6** | Admin dashboard completion | ~12h | ✅ Complete |
| **Phase 2** | Scale & infrastructure | ~18h | ✅ 2.1–2.5 done; 2.3 (monitoring) pending |
| **Phase 3** | Manual payment flow hardening | ~8h | ❌ Not Started |
| **Phase 4** | Growth & expansion | ~22h | ❌ Not Started |
| **Phase 5** | Testing & quality | ~18h | ❌ Not Started |
| **Phase 6** | Deployment & DevOps | ~12h | ✅ 6.1–6.3 done; 6.4 pending |

---

## Progress Log

| Date | Tasks Completed | Notes |
|------|----------------|-------|
| 2026-02-22 | Tier 0: T1–T6 | All Tier 0 tasks complete. Prisma migration applied. |
| 2026-02-22 | Tier 1: T7–T13 | Refresh tokens, multi-cartela, storage, notifications model/enum, admin auth. |
| 2026-02-22 | Tier 2: T14–T23 | Redis game state, refund service, deposit route, notification service, payment abstraction, CI/CD. Tests: 73/73 ✅. |
| 2026-02-22 | Tier 3: T24–T34 | Game engine (Redlock), cancel/auto-cancel, Pinia store, deposit form, admin pages. Tests: 91/91 ✅. |
| 2026-02-22 | Tier 4: T36–T44 | Lobby, cartela selection, wallet UI, notification bell, nav polish, admin game/user pages, BullMQ setup. |
| 2026-02-22 | Tier 5: T45–T49 | Live game play page, game engine worker (BullMQ), BullMQ dashboard. Tests: 142/142 ✅. **MVP feature-complete.** |

---

## Priority Order (Recommended Sprint Sequence)

1. **Sprint 1 (Week 1–2):** Phase 0 (all) + Phase 1.2 + Phase 1.3
2. **Sprint 2 (Week 2–3):** Phase 1.1 + Phase 1.4 + Phase 1.5.1–1.5.3
3. **Sprint 3 (Week 3–4):** Phase 1.5.4–1.5.6 + Phase 1.6.3–1.6.7
4. **Sprint 4 (Week 4–5):** Phase 2.1 + Phase 2.2 + Phase 5.1
5. **Sprint 5 (Week 5–6):** Phase 2.3–2.5 + Phase 5.2–5.3
6. **Sprint 6 (Week 7–8):** Phase 3 (all) + Phase 6 (all)
7. **Sprint 7 (Week 9+):** Phase 4 (all) + Phase 5.4
