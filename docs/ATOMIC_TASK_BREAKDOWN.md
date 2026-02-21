# World Bingo — Atomic Task Breakdown

> **Generated:** 2026-02-21
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

## Phase 0 — Bug Fixes & Hardening of Existing Code

> These fix issues discovered during the codebase audit that **must** be resolved before new features.

### 0.1 Wallet: Add `SELECT FOR UPDATE` row-level locking ⏱️ 2h 🔧

**Package:** `apps/api` — `wallet.service.ts`
**Problem:** `requestWithdrawal()` uses `tx.wallet.findUnique()` + `tx.wallet.update()` without an explicit row lock. Two concurrent withdrawal requests can both pass the balance check.
**Tasks:**
- [ ] Replace `tx.wallet.findUnique()` with raw `SELECT ... FOR UPDATE` query in `requestWithdrawal()`
- [ ] Do the same in `GameService.joinGame()` — currently decrements without locking
- [ ] Do the same in `WalletService.approveDeposit()` — increment without locking
- [ ] Add `balance_before` and `balance_after` fields to the `Transaction` model in `schema.prisma`
- [ ] Populate `balance_before` / `balance_after` on every transaction creation
- [ ] Write a unit test: two concurrent `requestWithdrawal()` calls with insufficient total balance — only one should succeed
- [ ] Write a unit test: two concurrent `joinGame()` calls from the same user — only one should succeed

### 0.2 Auth: Support login by username OR phone ⏱️ 1h 🔧

**Package:** `apps/api` — `auth.service.ts`
**Problem:** `login()` only looks up by `phone`. The spec says users can log in with username OR phone.
**Tasks:**
- [ ] Update `LoginSchema` in `shared-types/src/api/index.ts` — change `phone` field to `identifier` (string)
- [ ] Update `AuthService.login()` to try `findUnique({ where: { phone } })` then `findUnique({ where: { username } })`, or use `findFirst` with `OR`
- [ ] Update `LoginDto` type consumers (web app store, admin app)
- [ ] Add test: login with username succeeds
- [ ] Add test: login with phone succeeds

### 0.3 Auth: Implement refresh token flow ⏱️ 3h 🔧

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

### 0.4 Game: Fix `GameEntry` schema to support multiple cartelas per user ⏱️ 2h 🔧

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
- [ ] Add payment gateway selector (Telebirr, CBE Birr, etc.)
- [ ] Add file input for receipt screenshot with image preview
- [ ] Submit via `FormData` to `POST /wallet/deposit`
- [ ] Show upload progress indicator
- [ ] Show success state with "Pending verification" message

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

### 1.5.4 Live game play page ⏱️ 5h ❌

**Package:** `apps/web`
- [ ] Create `pages/quick/[gameId]/play.vue`
- [ ] Join socket room `game:{gameId}` on mount
- [ ] Display called ball prominently with bounce animation (use `BingoBall.vue`)
- [ ] Show list of all previously called balls
- [ ] Render player's cartela(s) using `CartelaGrid.vue`
- [ ] Auto-mark called numbers on the cartela grid
- [ ] Detect potential win client-side using `@world-bingo/game-logic` `checkPattern()`
- [ ] Show "BINGO!" button when a win pattern is detected
- [ ] On click, emit `game:claim-bingo` socket event
- [ ] Listen for `game:winner` → show winner overlay (confetti, prize amount)
- [ ] Listen for `game:ended` → redirect to lobby after 10s countdown
- [ ] Listen for `game:cancelled` → show cancellation + refund message
- [ ] Handle multiple cartelas: tab or swipe between cards
- [ ] Show game timer / ball count progress

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

### 2.1 BullMQ Job Queue Integration ⏱️ 6h ❌

**Package:** `apps/api`

#### 2.1.1 Queue infrastructure
- [ ] Create `lib/queue.ts` — initialize BullMQ connection using existing Redis
- [ ] Define queue names: `refund`, `notification`, `withdrawal`, `game-engine`
- [ ] Create `workers/` directory

#### 2.1.2 Refund worker
- [ ] Create `workers/refund.worker.ts`
- [ ] Job data: `{ gameId: string }`
- [ ] Worker calls `RefundService.refundGame(gameId)`
- [ ] Add retry logic (3 attempts, exponential backoff)
- [ ] Replace direct `RefundService.refundGame()` calls with `refundQueue.add()`

#### 2.1.3 Notification worker
- [ ] Create `workers/notification.worker.ts`
- [ ] Job data: `{ userId, type, title, body, metadata }`
- [ ] Worker calls `NotificationService.create()` + socket emit
- [ ] Decouple notification creation from request handlers

#### 2.1.4 Game engine worker
- [ ] Create `workers/game-engine.worker.ts`
- [ ] Move `runGameLoop()` logic into the worker
- [ ] Job data: `{ gameId: string }`
- [ ] Worker acquires Redlock, calls balls, persists to Redis
- [ ] On game end, enqueue a `persist-game-result` job

#### 2.1.5 BullMQ dashboard
- [ ] Install `@bull-board/fastify`
- [ ] Mount at `/admin/queues` behind admin auth
- [ ] Register all queues with the board

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

### 2.4 Database Optimization ⏱️ 3h ❌

**Package:** `apps/api` — `prisma/schema.prisma`
- [ ] Add database indexes:
  - `Transaction`: index on `(userId, createdAt)`, `(type, status)`, `(referenceId)`
  - `GameEntry`: index on `(gameId)`, `(userId)`
  - `Game`: index on `(status)`, `(createdAt)`
  - `Notification`: index on `(userId, isRead)`
- [ ] Generate and apply migration for indexes
- [ ] Add connection pooling configuration (PgBouncer or Prisma connection pool settings)
- [ ] Evaluate and add read replica support for read-heavy queries (stats, history)

### 2.5 Rate Limiting & Security Hardening ⏱️ 2h 🔧

**Package:** `apps/api`
- [ ] Configure route-specific rate limits:
  - `/auth/login`: 5 requests per minute per IP
  - `/auth/register`: 3 requests per minute per IP
  - `/wallet/deposit`: 10 requests per minute per user
  - `/games/:id/join`: 5 requests per minute per user
- [ ] Add Redis-backed rate limiting store (replace in-memory default)
- [ ] Add request validation: sanitize all string inputs
- [ ] Add CORS restrictions for production domains
- [ ] Add Helmet-equivalent security headers via `@fastify/helmet`
- [ ] Add request logging with sensitive field redaction (passwords, tokens)

---

## Phase 3 — Payment Automation

### 3.1 Chapa Payment Gateway ⏱️ 5h ❌

**Package:** `apps/api`, `apps/web`

#### 3.1.1 Chapa SDK integration
- [ ] Create `lib/payment/chapa.ts`
- [ ] Implement `initializePayment(amount, email, txRef)` → returns checkout URL
- [ ] Implement `verifyPayment(txRef)` → returns payment status
- [ ] Add env vars: `CHAPA_SECRET_KEY`, `CHAPA_PUBLIC_KEY`, `CHAPA_WEBHOOK_SECRET`

#### 3.1.2 Webhook handler
- [ ] Add `POST /webhooks/chapa` route (no auth — verify via HMAC signature)
- [ ] On `success` event: auto-approve deposit, credit wallet, create notification
- [ ] On `failed` event: update transaction status to REJECTED, notify user
- [ ] Make webhook handler idempotent (check if already processed by `txRef`)

#### 3.1.3 Frontend: Chapa checkout
- [ ] Add "Pay with Chapa" option in `DepositModal.vue`
- [ ] Redirect to Chapa checkout URL
- [ ] Handle return URL — show deposit status page
- [ ] Fallback to manual receipt upload if Chapa is unavailable

### 3.2 Telebirr API Integration ⏱️ 5h ❌

**Package:** `apps/api`, `apps/web`

#### 3.2.1 Telebirr SDK integration
- [ ] Create `lib/payment/telebirr.ts`
- [ ] Implement Telebirr H5 payment flow
- [ ] Add env vars: `TELEBIRR_APP_ID`, `TELEBIRR_APP_KEY`, `TELEBIRR_PUBLIC_KEY`

#### 3.2.2 Webhook handler
- [ ] Add `POST /webhooks/telebirr` route
- [ ] Parse Telebirr callback payload
- [ ] Auto-approve/reject based on payment status
- [ ] Idempotency via transaction reference check

#### 3.2.3 Frontend: Telebirr option
- [ ] Add "Pay with Telebirr" option in `DepositModal.vue`
- [ ] Handle Telebirr redirect flow
- [ ] Show payment status on return

### 3.3 Payment Gateway Abstraction ⏱️ 2h ❌

**Package:** `apps/api`
- [ ] Create `lib/payment/index.ts` — `PaymentGateway` interface
  - `initiate(amount, userId, metadata): Promise<{ checkoutUrl, txRef }>`
  - `verify(txRef): Promise<PaymentResult>`
  - `handleWebhook(payload, signature): Promise<WebhookResult>`
- [ ] Implement `ChapaGateway implements PaymentGateway`
- [ ] Implement `TelebirrGateway implements PaymentGateway`
- [ ] Implement `ManualGateway implements PaymentGateway` (current receipt flow)
- [ ] Factory function: `getGateway(name: string): PaymentGateway`

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

### 6.2 Dockerfiles ⏱️ 3h ❌

- [ ] Create `apps/api/Dockerfile` (Node.js 22, multi-stage build)
- [ ] Create `apps/web/Dockerfile` (Nuxt SSR build)
- [ ] Create `apps/admin/Dockerfile` (Nuxt SSR build)
- [ ] Create `.dockerignore` files
- [ ] Test local builds with `docker-compose up`

### 6.3 Environment Configuration ⏱️ 2h ❌

- [ ] Create `.env.example` with all required variables documented
- [ ] Create environment-specific configs: `.env.development`, `.env.staging`, `.env.production`
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
| **Phase 0** | Bug fixes & hardening | ~15h | 🔧 In Progress |
| **Phase 1** | MVP feature completion | ~20h | ❌/🔧 Partial |
| **Phase 1.5** | Web app real-time UI | ~18h | 🔧 Partial |
| **Phase 1.6** | Admin dashboard completion | ~12h | ✅/🔧 Partial |
| **Phase 2** | Scale & infrastructure | ~18h | ❌ Not Started |
| **Phase 3** | Payment automation | ~12h | ❌ Not Started |
| **Phase 4** | Growth & expansion | ~22h | ❌ Not Started |
| **Phase 5** | Testing & quality | ~18h | ❌ Not Started |
| **Phase 6** | Deployment & DevOps | ~11h | ❌ Not Started |
| **Total** | | **~146h** | |

---

## Priority Order (Recommended Sprint Sequence)

1. **Sprint 1 (Week 1–2):** Phase 0 (all) + Phase 1.2 + Phase 1.3
2. **Sprint 2 (Week 2–3):** Phase 1.1 + Phase 1.4 + Phase 1.5.1–1.5.3
3. **Sprint 3 (Week 3–4):** Phase 1.5.4–1.5.6 + Phase 1.6.3–1.6.7
4. **Sprint 4 (Week 4–5):** Phase 2.1 + Phase 2.2 + Phase 5.1
5. **Sprint 5 (Week 5–6):** Phase 2.3–2.5 + Phase 5.2–5.3
6. **Sprint 6 (Week 7–8):** Phase 3 (all) + Phase 6 (all)
7. **Sprint 7 (Week 9+):** Phase 4 (all) + Phase 5.4
