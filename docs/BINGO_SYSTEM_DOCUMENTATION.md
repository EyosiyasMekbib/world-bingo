# World Bingo — Complete Technical Documentation

> **Reference System:** https://online-bingo-client-230041233104.us-central1.run.app/  
> **Analysis Date:** 2026-02-20  
> **Classification:** System Recreation Specification

---

## Table of Contents

1. [Business Overview](#1-business-overview)
2. [Feature Specification](#2-feature-specification)
3. [Data Models & Schema](#3-data-models--schema)
4. [API Specification](#4-api-specification)
5. [Real-Time Protocol (WebSocket)](#5-real-time-protocol-websocket)
6. [System Architecture](#6-system-architecture)
7. [Infrastructure & Scalability Design](#7-infrastructure--scalability-design)
8. [Game Engine Logic](#8-game-engine-logic)
9. [Payment System Design](#9-payment-system-design)
10. [Security Specification](#10-security-specification)
11. [Frontend Design Specification](#11-frontend-design-specification)
12. [Deployment Specification](#12-deployment-specification)

---

## 1. Business Overview

### 1.1 Product Summary

**World Bingo** is a real-money online Bingo gaming platform targeting the Ethiopian market. Players wager in Ethiopian Birr (ETB), purchase virtual "Cartelas" (Bingo cards), and compete in real-time multiplayer sessions. The platform operates on a house-edge model where the operator retains a percentage of every game's prize pool.

### 1.2 Business Model

| Revenue Stream | Description |
|---|---|
| **House Edge** | Operator retains 10–20% of total ticket sales per game round |
| **Ticket Sales** | Players purchase cartelas at tiered prices (10, 20, 50+ Birr) |
| **Float on Deposits** | Funds held in user wallets earn float revenue |

### 1.3 Target Audience

- Ethiopia-based gamblers
- Mobile-first users (the UI is optimized for smaller viewports)
- Players familiar with traditional Ethiopian Bingo ("Cartela") parlors

### 1.4 Core User Journeys

```
HAPPY PATH:
Register/Login → Deposit Birr → Browse Lobby → Select Game Room →
Choose Cartela(s) → Wait for Quorum → Play Live Bingo → Win Prize → Withdraw

CANCELLATION PATH:
Join Game → Game Cancelled (insufficient players) → Auto-Refund → Return to Lobby

DEPOSIT PATH:
Open Wallet → Select Deposit → Transfer via TeleBirr to Merchant (0901977670) →
Enter Amount, Transaction ID, Name, Account Number → Upload Receipt Screenshot →
Await Admin Verification → Balance Updated
```

---

## 2. Feature Specification

### 2.1 Authentication System

#### User Registration
- **Fields:** Username, Phone Number, Password, Confirm Password
- **Validation:** Unique username and phone, minimum password length
- **Referral Code:** Optional referral code field at sign-up (to be implemented)
- **Session:** JWT-based authentication with Remember Me (30-day token lifespan)

#### Login
- **Methods:** Phone Number OR Username
- **Toggle:** Tab-based UI switcher between Phone/Username login
- **Security:** Rate limiting after 5 failed attempts (15-minute lockout)

#### Session Management
- Access Token (short-lived, 15 minutes)
- Refresh Token (long-lived, 30 days)
- "Remember Me" extends refresh token lifespan

---

### 2.2 Lobby System

The lobby is the main dashboard showing all available game sessions.

#### Lobby Cards (Game Room UI)
Each game room card displays:

| Field | Details |
|---|---|
| **Room Type** | "Quick Bingo" (primary mode) |
| **Ticket Price** | 10 Birr / 20 Birr / 50 Birr |
| **Player Count** | Live count of currently joined players |
| **Countdown Timer** | Seconds until game starts (real-time via WebSocket) |
| **Join Button** | "Join Game" CTA |

#### Polling Behavior
- Lobby fetches available games on mount
- Lobby re-polls every **5 seconds** via HTTP or updates via WebSocket subscription
- New game sessions are automatically surfaced without page refresh

---

### 2.3 Cartela (Bingo Card) System

#### Cartela Selection Screen
- URL: `/quick/[gameId]`
- Displays a **grid of numbered cartelas** (1–70+ available per game)
- Each cartela shows its number (e.g., "1", "2", "3"...)
- **Multi-select:** Players can purchase multiple cartelas per game
- **Selection Indicator:** Selected cartelas get a highlighted border (amber/gold)
- **Cost Display:** Total cost updates dynamically as cartelas are selected
- **CTA:** "START PLAY" button triggers entry and deducts from wallet

#### Cartela Structure (Standard 75-Ball Bingo)
```
     B    I    N    G    O
   [ 5] [17] [32] [46] [61]
   [ 3] [20] [35] [51] [69]
   [ 9] [28] [FREE][53][74]
   [14] [24] [39] [48] [63]
   [ 1] [16] [44] [60] [75]
```
- **B column:** Numbers 1–15
- **I column:** Numbers 16–30
- **N column:** Numbers 31–45 (center is FREE space)
- **G column:** Numbers 46–60
- **O column:** Numbers 61–75

#### Cartela Generation Rules
- Each cartela number-set is pre-generated and stored
- Numbers within each column are randomly selected from the valid range
- No duplicate numbers on a single card
- Cards are identified by their unique cartela ID (1–70+)

---

### 2.4 Live Game Screen

- URL: `/quick/[gameId]/play`

#### Layout
```
┌─────────────────────────────────────────────────┐
│ [← Back]         GAME TITLE            [BINGO!] │
├──────────────┬──────────────────────────────────┤
│              │  B    I    N    G    O            │
│  CALLED      │ [5] [17] [32] [46] [61]          │
│  NUMBERS     │ [3] [20] [35] [51] [69]          │
│  DISPLAY     │ [9] [28] [FREE][53][74]          │
│              │ [14][24] [39] [48] [63]          │
│  Ball: 42    │ [1] [16] [44] [60] [75]          │
├──────────────┴──────────────────────────────────┤
│  Previously called: 5, 17, 32, 3, 20...         │
└─────────────────────────────────────────────────┘
```

#### Game State Machine
```
WAITING → STARTING → ACTIVE → WINNER_DECLARED → ENDED
```

| State | Behavior |
|---|---|
| `WAITING` | Countdown to quorum; minimum 4 players required |
| `STARTING` | 5-second grace period; no new joins |
| `ACTIVE` | Numbers called every ~3–5 seconds; players mark cards |
| `WINNER_DECLARED` | Winner announcement, prize attribution |
| `ENDED` | Redirect to lobby after 10 seconds |

#### Number Calling
- Numbers called server-side (not client-controlled)
- Called ball displayed prominently with animation
- All previously called numbers shown in a scrollable list
- Auto-marking option: called numbers highlighted on player's cartela automatically

#### Winning Patterns (Observed: Line Pattern)
- **Line:** Any complete horizontal row
- Future patterns (to implement): Diagonal, Full Card (Blackout), L-Shape, T-Shape, X

#### BINGO Claim
- "BINGO!" button appears when a winning pattern is detected client-side
- Server validates the claim independently
- False claims can result in warnings (optional rule)

---

### 2.5 Wallet System

#### Wallet Modal Fields
| Section | Details |
|---|---|
| **Balance Display** | Current balance in Birr, real-time updated |
| **Deposit Button** | Opens deposit flow |
| **Withdraw Button** | Opens withdrawal flow |
| **Transaction History** | Tabbed/linked section showing all transactions |

#### Deposit Flow (TeleBirr Manual Transfer)
1. User sees instruction: **"Transfer Funds Within 15 Minutes"** to merchant number **0901977670** via TeleBirr
2. User performs the transfer via the TeleBirr app
3. User returns to web app and fills out the deposit form:
   - **Amount** (Minimum: 25 Birr)
   - **Transaction ID** (from TeleBirr receipt, e.g., DAB2Q8G0FC)
   - **Name** (sender's name as shown on receipt)
   - **TeleBirr Account Number** (sender's phone number)
   - **Receipt Image/Screenshot** (upload)
4. Submit → Enters "Pending" state in admin's Orders History
5. Admin views receipt, cross-checks form data against receipt image
6. Admin approves or declines (with reason if declined)
7. Balance updated upon approval; user notified

#### Withdrawal Flow (TeleBirr Manual Fulfillment)
1. Enter amount (Minimum: 100 Birr; Maximum: current balance)
2. Payment method: TeleBirr
3. Enter TeleBirr account/phone number
4. Submit → Enters "Pending" state, balance deducted immediately
5. Admin processes withdrawal manually
6. Notification sent on completion

---

### 2.6 Transaction History

| Column | Description |
|---|---|
| **Type** | BET / REFUND / DEPOSIT / WITHDRAWAL / WIN |
| **Amount** | Birr amount (positive = credit, negative = debit) |
| **Status** | PENDING / COMPLETED / REJECTED |
| **Timestamp** | Date and time of transaction |
| **Reference** | Game ID or payment reference |

---

### 2.7 Game History

- List of all past games the user participated in
- Columns: Game ID, Cartelas Purchased, Amount Wagered, Result (Win/Loss), Prize Won

---

### 2.8 Notification System

- Bell icon in top-right of header
- Real-time notifications via WebSocket push
- Notification types:
  - Game cancelled + refund processed
  - Deposit approved/rejected
  - Withdrawal processed
  - You won a game
  - Game starting soon

---

### 2.9 Admin Panel (Implied Backend Requirements)

| Feature | Description |
|---|---|
| **Deposit Verification** | Review uploaded receipts, approve/reject deposits |
| **Withdrawal Processing** | Approve withdrawal requests, mark as paid |
| **User Management** | View/suspend/ban users |
| **Game Management** | Create game rooms, set ticket prices, set minimum players |
| **Financial Reports** | Total deposits, withdrawals, house edge earned |
| **Live Game Monitor** | View active games, current player counts |

---

## 3. Data Models & Schema

### 3.1 Users Table
```sql
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(50) UNIQUE NOT NULL,
    phone_number    VARCHAR(20) UNIQUE,
    password_hash   TEXT NOT NULL,
    role            ENUM('player', 'admin') DEFAULT 'player',
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.2 Wallets Table
```sql
CREATE TABLE wallets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID UNIQUE NOT NULL REFERENCES users(id),
    balance     DECIMAL(15, 2) DEFAULT 0.00 NOT NULL,
    currency    VARCHAR(3) DEFAULT 'ETB',
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.3 Transactions Table
```sql
CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    type            ENUM('DEPOSIT', 'WITHDRAWAL', 'BET', 'WIN', 'REFUND') NOT NULL,
    amount          DECIMAL(15,2) NOT NULL,
    balance_before  DECIMAL(15,2) NOT NULL,
    balance_after   DECIMAL(15,2) NOT NULL,
    status          ENUM('PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED') DEFAULT 'PENDING',
    reference_id    UUID,         -- game_id for BET/WIN/REFUND, payment_id for DEPOSIT/WITHDRAWAL
    metadata        JSONB,        -- bank info, receipt URL, etc.
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.4 Payment Requests Table
```sql
CREATE TABLE payment_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    type            ENUM('DEPOSIT', 'WITHDRAWAL') NOT NULL,
    amount          DECIMAL(15,2) NOT NULL,
    payment_method  VARCHAR(50) DEFAULT 'telebirr',  -- 'telebirr' (manual transfer)
    payment_tx_id   VARCHAR(100),         -- TeleBirr transaction ID from receipt
    sender_name     VARCHAR(200),         -- Name on the TeleBirr transfer
    sender_account  VARCHAR(50),          -- TeleBirr phone number of the sender
    receipt_url     TEXT,                 -- S3/GCS URL for deposit receipt screenshot
    account_number  VARCHAR(50),          -- for withdrawals (recipient phone number)
    status          ENUM('PENDING', 'APPROVED', 'REJECTED') DEFAULT 'PENDING',
    processed_by    UUID REFERENCES users(id),
    processed_at    TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.5 Games Table
```sql
CREATE TABLE games (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_type       VARCHAR(50) DEFAULT 'QUICK',
    ticket_price    DECIMAL(10,2) NOT NULL,
    min_players     INT DEFAULT 4,
    max_cartelas    INT DEFAULT 70,
    winning_pattern ENUM('LINE', 'DIAGONAL', 'FULL_CARD', 'L_SHAPE') DEFAULT 'LINE',
    house_edge_pct  DECIMAL(5,2) DEFAULT 10.00,
    status          ENUM('WAITING', 'STARTING', 'ACTIVE', 'WINNER_DECLARED', 'ENDED', 'CANCELLED') DEFAULT 'WAITING',
    starts_at       TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    called_numbers  INT[] DEFAULT '{}',
    winner_user_id  UUID REFERENCES users(id),
    prize_amount    DECIMAL(15,2),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.6 Cartelas Table (Master Card Definitions)
```sql
CREATE TABLE cartelas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_number INT NOT NULL,        -- Display number (1–70)
    b_column    INT[5] NOT NULL,     -- Numbers 1–15
    i_column    INT[5] NOT NULL,     -- Numbers 16–30
    n_column    INT[4] NOT NULL,     -- Numbers 31–45 (4 numbers + FREE center)
    g_column    INT[5] NOT NULL,     -- Numbers 46–60
    o_column    INT[5] NOT NULL      -- Numbers 61–75
);
```

### 3.7 Game Entries Table
```sql
CREATE TABLE game_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id     UUID NOT NULL REFERENCES games(id),
    user_id     UUID NOT NULL REFERENCES users(id),
    cartela_ids UUID[] NOT NULL,     -- Array of owned cartela IDs for this game
    amount_paid DECIMAL(15,2) NOT NULL,
    is_winner   BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(game_id, user_id)
);

CREATE TABLE game_cartela_assignments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id     UUID NOT NULL REFERENCES games(id),
    user_id     UUID NOT NULL REFERENCES users(id),
    cartela_id  UUID NOT NULL REFERENCES cartelas(id),
    UNIQUE(game_id, cartela_id)     -- Each cartela can only be owned by one player per game
);
```

### 3.8 Notifications Table
```sql
CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id),
    type        VARCHAR(50) NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    is_read     BOOLEAN DEFAULT FALSE,
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. API Specification

### Base URL
```
https://api.yourdomain.com/v1
```

### Authentication Header
```
Authorization: Bearer <JWT_ACCESS_TOKEN>
```

---

### 4.1 Auth Endpoints

#### POST /auth/register
```json
// Request
{
  "username": "johndoe",
  "phone_number": "+251911000000",
  "password": "SecurePass123"
}

// Response 201
{
  "user": { "id": "uuid", "username": "johndoe" },
  "tokens": {
    "access_token": "eyJ...",
    "refresh_token": "eyJ...",
    "expires_in": 900
  }
}
```

#### POST /auth/login
```json
// Request
{
  "identifier": "johndoe",  // username OR phone_number
  "password": "SecurePass123",
  "remember_me": true
}

// Response 200
{
  "user": { "id": "uuid", "username": "johndoe", "role": "player" },
  "tokens": { "access_token": "...", "refresh_token": "...", "expires_in": 900 }
}
```

#### POST /auth/refresh
```json
// Request
{ "refresh_token": "eyJ..." }

// Response 200
{ "access_token": "eyJ...", "expires_in": 900 }
```

#### POST /auth/logout
```
204 No Content
```

---

### 4.2 Wallet Endpoints

#### GET /wallet
```json
// Response 200
{
  "id": "uuid",
  "balance": 350.00,
  "currency": "ETB"
}
```

#### GET /wallet/transactions?page=1&limit=20&type=BET
```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "type": "BET",
      "amount": -10.00,
      "status": "COMPLETED",
      "created_at": "2026-02-20T10:00:00Z"
    }
  ],
  "total": 45,
  "page": 1,
  "limit": 20
}
```

#### POST /wallet/deposit
```
Content-Type: multipart/form-data

Fields:
  amount: 100.00
  transactionId: "DAB2Q8G0FC"       // TeleBirr transaction ID from receipt
  senderName: "Abebe Bikila"         // Name as shown on the TeleBirr receipt
  senderAccount: "0912345678"        // Sender's TeleBirr phone number
  receipt: <file>                    // Screenshot of TeleBirr receipt (JPG/PNG, max 5MB)

// Response 201
{
  "payment_request_id": "uuid",
  "status": "PENDING",
  "message": "Deposit request submitted. Awaiting admin verification."
}
```

#### POST /wallet/withdraw
```json
// Request
{
  "amount": 200.00,
  "bank_name": "Commercial Bank of Ethiopia",
  "account_number": "1000123456789"
}

// Response 201
{
  "payment_request_id": "uuid",
  "status": "PENDING",
  "message": "Withdrawal request submitted."
}
```

---

### 4.3 Game Endpoints

#### GET /games?status=WAITING
```json
// Response 200
{
  "data": [
    {
      "id": "uuid",
      "ticket_price": 10.00,
      "player_count": 3,
      "min_players": 4,
      "starts_at": "2026-02-20T10:05:00Z",
      "status": "WAITING",
      "winning_pattern": "LINE"
    }
  ]
}
```

#### GET /games/:gameId
```json
// Response 200
{
  "id": "uuid",
  "ticket_price": 10.00,
  "status": "WAITING",
  "player_count": 3,
  "min_players": 4,
  "starts_at": "...",
  "available_cartelas": [1, 2, 3, ...70],
  "taken_cartelas": [5, 12, 34]
}
```

#### GET /games/:gameId/cartelas
```json
// Response 200
{
  "cartelas": [
    {
      "id": "uuid",
      "card_number": 1,
      "is_available": true,
      "grid": {
        "B": [5, 3, 9, 14, 1],
        "I": [17, 20, 28, 24, 16],
        "N": [32, 35, "FREE", 39, 44],
        "G": [46, 51, 53, 48, 60],
        "O": [61, 69, 74, 63, 75]
      }
    }
  ]
}
```

#### POST /games/:gameId/join
```json
// Request
{ "cartela_ids": ["uuid1", "uuid2"] }

// Response 200
{
  "entry_id": "uuid",
  "amount_charged": 20.00,
  "new_balance": 330.00,
  "cartelas": [/* same as above */]
}
```

#### GET /games/:gameId/state
```json
// Response 200 (during active game)
{
  "status": "ACTIVE",
  "called_numbers": [5, 17, 32, 3],
  "current_ball": 32,
  "player_count": 6,
  "prize_pool": 54.00      // after house edge
}
```

---

### 4.4 Admin Endpoints

All admin endpoints require `role: admin`.

#### GET /admin/payments?status=PENDING
#### PUT /admin/payments/:id/approve
#### PUT /admin/payments/:id/reject
#### GET /admin/users
#### PUT /admin/users/:id/suspend
#### GET /admin/games
#### POST /admin/games (create new game session)
#### GET /admin/reports/financial

---

## 5. Real-Time Protocol (WebSocket)

### Technology: Socket.io

### Connection
```javascript
// Client-side
import { io } from 'socket.io-client';

const socket = io('wss://api.yourdomain.com', {
  auth: { token: '<JWT_ACCESS_TOKEN>' }
});
```

### Namespaces
| Namespace | Purpose |
|---|---|
| `/lobby` | Lobby-wide game availability updates |
| `/game/:gameId` | Game-specific events (per room) |
| `/wallet` | Wallet balance and transaction events |
| `/notifications` | User-specific push notifications |

---

### 5.1 Lobby Events

#### Server → Client

```typescript
// New game available
socket.on('game:new', (game: GameSummary) => { });

// Game updated (player count, status change)
socket.on('game:updated', (game: GameSummary) => { });

// Game removed (started or cancelled)
socket.on('game:removed', (gameId: string) => { });
```

---

### 5.2 Game Room Events

#### Client → Server

```typescript
// Subscribe to a game room
socket.emit('game:subscribe', { game_id: 'uuid' });

// Player claims BINGO
socket.emit('game:claim_bingo', { game_id: 'uuid', cartela_id: 'uuid' });
```

#### Server → Client

```typescript
// Game state changes
socket.on('game:state_change', (data: { status: GameStatus }) => { });

// New number called
socket.on('game:number_called', (data: { number: int, called_numbers: int[] }) => { });

// Winner declared
socket.on('game:winner', (data: { winner_username: string, prize: number }) => { });

// Game cancelled
socket.on('game:cancelled', (data: { game_id: string, reason: string }) => { });

// Timer update (seconds remaining in WAITING state)
socket.on('game:timer', (data: { seconds_remaining: int }) => { });

// Player count update
socket.on('game:player_count', (data: { count: int }) => { });
```

---

### 5.3 Wallet Events

```typescript
// Balance updated (after bet, win, deposit, etc.)
socket.on('wallet:balance_updated', (data: { new_balance: number, transaction: Transaction }) => { });
```

---

### 5.4 Notification Events

```typescript
// Push notification to specific user
socket.on('notification:new', (data: Notification) => { });
```

---

## 6. System Architecture

### 6.1 High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                   │
│  ┌─────────────────────┐         ┌──────────────────────────────────┐  │
│  │   Next.js Frontend   │         │         Admin Dashboard           │  │
│  │  (React + Tailwind)  │         │      (React SPA / Next.js)        │  │
│  └──────────┬──────────┘         └─────────────────┬────────────────┘  │
└─────────────┼───────────────────────────────────────┼───────────────────┘
              │ HTTPS + WSS                            │ HTTPS
              ▼                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         API GATEWAY / LOAD BALANCER                     │
│                    (Nginx / Google Cloud Load Balancer)                  │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│    REST API Server   │ │  WebSocket Server   │ │   Background Worker │
│   (Node.js/Fastify) │ │    (Socket.io)       │ │  (BullMQ + Redis)   │
│   Instances: 2–10   │ │  Instances: 2–10    │ │  Instances: 1–5     │
└──────────┬──────────┘ └──────────┬──────────┘ └──────────┬──────────┘
           │                       │                        │
           └───────────────────────┼────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│     PostgreSQL       │ │       Redis          │ │    Object Storage   │
│  (Primary + Replica) │ │  (Session + PubSub  │ │   (GCS / S3)        │
│                      │ │   + Game State)      │ │ (Receipt Images)    │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘
```

### 6.2 Component Responsibilities

| Component | Technology | Responsibility |
|---|---|---|
| **Frontend** | Next.js 14 (App Router) | Player-facing UI, SSR/SSG |
| **Admin Panel** | Next.js or React SPA | Operator management UI |
| **REST API** | Node.js + Fastify | Business logic, CRUD, auth |
| **WebSocket Server** | Socket.io + Redis Adapter | Real-time game and notification events |
| **Game Engine** | Node.js Worker | Ball calling scheduler, winner validation |
| **Background Worker** | BullMQ + Redis | Refunds, email notifications, report generation |
| **Database** | PostgreSQL 16 | Durable transactional data |
| **Cache / Pub-Sub** | Redis 7 | Active game state, WS pub-sub, sessions |
| **Object Storage** | Google Cloud Storage | Receipt images, media assets |
| **CDN** | Cloudflare | Static assets, global edge caching |

---

## 7. Infrastructure & Scalability Design

### 7.1 Scalability Requirements

| Metric | Target |
|---|---|
| Concurrent WebSocket connections | 10,000+ |
| Active concurrent games | 100+ |
| API requests/sec | 5,000+ |
| Database connections | Pooled (PgBouncer), max 500 |
| P99 API latency | < 200ms |
| P99 WebSocket event latency | < 50ms |

### 7.2 Horizontal Scaling Strategy

#### REST API Servers
- Stateless Node.js instances behind a load balancer
- Horizontal auto-scaling based on CPU/RPS
- Kubernetes HPA or Cloud Run concurrency settings

#### WebSocket Servers (Critical for Scale)
```
Problem: Multiple WebSocket instances cannot share in-memory state.
Solution: Redis Pub/Sub Adapter for Socket.io

When Server A receives a number-call event:
1. Server A publishes to Redis channel: "game:uuid:number_called"
2. Redis broadcasts to ALL Socket.io servers
3. All servers forward the event to their connected clients in that game room
```

**Implementation:**
```typescript
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();

await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));
```

#### Game Engine (Critical Design)
- **Game state is stored in Redis** (not PostgreSQL) during active games
- Redis Hash per game: `game:{gameId}` → `{ status, called_numbers, player_count, ... }`
- Ball calling is handled by a dedicated worker process with Redis-based distributed lock
- Only ONE game engine worker calls balls for a given game (leader election via Redlock)

```
Redis Key Schema:
game:{gameId}:state       → HASH (status, called_numbers JSON, timer)
game:{gameId}:players     → SET (user IDs)
game:{gameId}:cartelas    → HASH (cartela_id → user_id)
lobby:waiting_games       → SORTED SET (game_id → starts_at timestamp)
```

### 7.3 Database Scaling

```
Primary (writes) ──→ Replica 1 (read-heavy queries)
                 └──→ Replica 2 (reporting queries)

Connection Pooling:
  PgBouncer → PostgreSQL
  Pool size per API instance: 10
  Max total connections: 200
```

### 7.4 Caching Strategy

| Data | Cache Layer | TTL |
|---|---|---|
| User session / JWT validation | Redis | 15 minutes |
| Wallet balance (read-through) | Redis | 30 seconds |
| Available cartelas per game | Redis | 1 minute |
| Lobby game list | Redis | 5 seconds |
| Cartela grid definitions | Redis (permanent) | No expiry |

### 7.5 Background Job Queue (BullMQ)

```
Queues:
  refund-queue       → Process refunds when game is cancelled
  notification-queue → Send WS/email/SMS notifications  
  withdrawal-queue   → Process admin-approved withdrawals
  report-queue       → Generate daily financial reports
```

Job retry policy: 3 attempts, exponential backoff (1s, 5s, 25s), dead-letter queue on final failure.

### 7.6 Deployment (Google Cloud Run)

```yaml
# API Service
Cloud Run Service: bingo-api
  CPU: 2 vCPU
  Memory: 2GB
  Min instances: 2
  Max instances: 20
  Concurrency: 80
  
# WebSocket Service
Cloud Run Service: bingo-ws
  CPU: 2 vCPU
  Memory: 2GB
  Min instances: 2
  Max instances: 10
  Concurrency: 1000  # WebSocket connections per instance

# Database
Cloud SQL: PostgreSQL 16
  Machine type: db-n1-standard-4
  Storage: 100GB SSD with auto-grow
  High availability: Regional (with standby)
  
# Cache
Cloud Memorystore: Redis 7
  Tier: Standard (HA)
  Memory: 4GB
```

---

## 8. Game Engine Logic

### 8.1 Game Lifecycle (Server-Side)

```typescript
class BingoGameEngine {

  async startGame(gameId: string): Promise<void> {
    const game = await this.getGameFromRedis(gameId);
    
    if (game.playerCount < game.minPlayers) {
      await this.cancelGame(gameId);
      return;
    }

    await this.setGameStatus(gameId, 'STARTING');
    await this.broadcastToRoom(gameId, 'game:state_change', { status: 'STARTING' });
    
    await sleep(5000); // 5-second grace period
    
    await this.setGameStatus(gameId, 'ACTIVE');
    await this.runNumberCallingLoop(gameId);
  }

  private async runNumberCallingLoop(gameId: string): Promise<void> {
    const called = new Set<number>();
    const allNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
    
    while (called.size < 75) {
      const remaining = allNumbers.filter(n => !called.has(n));
      const nextNumber = remaining[Math.floor(Math.random() * remaining.length)];
      called.add(nextNumber);
      
      await this.storeCalledNumber(gameId, nextNumber);
      await this.broadcastToRoom(gameId, 'game:number_called', {
        number: nextNumber,
        called_numbers: Array.from(called)
      });
      
      await sleep(3500); // 3.5 seconds between calls
    }
    
    // All 75 numbers called without a winner
    await this.endGame(gameId, null);
  }

  async validateBingoClaim(gameId: string, userId: string, cartelaId: string): Promise<boolean> {
    const [game, cartela] = await Promise.all([
      this.getGameFromRedis(gameId),
      this.getCartela(cartelaId)
    ]);
    
    // Verify the user owns this cartela in this game
    const ownership = await this.verifyOwnership(gameId, userId, cartelaId);
    if (!ownership) return false;
    
    // Check winning patterns against called numbers
    const calledSet = new Set(game.calledNumbers);
    return this.checkWinningPattern(cartela, calledSet, game.winningPattern);
  }

  private checkWinningPattern(
    cartela: Cartela, 
    calledNumbers: Set<number>, 
    pattern: WinningPattern
  ): boolean {
    const grid = this.buildGrid(cartela);
    
    if (pattern === 'LINE') {
      // Check all 5 rows for complete match
      for (let row = 0; row < 5; row++) {
        const rowComplete = grid[row].every(cell => 
          cell === 'FREE' || calledNumbers.has(cell)
        );
        if (rowComplete) return true;
      }
    }
    // Add more patterns as needed
    return false;
  }

  async cancelGame(gameId: string): Promise<void> {
    await this.setGameStatus(gameId, 'CANCELLED');
    
    // Enqueue refunds for all players
    const entries = await this.getGameEntries(gameId);
    for (const entry of entries) {
      await refundQueue.add('refund', {
        userId: entry.userId,
        amount: entry.amountPaid,
        gameId: gameId,
        reason: 'Game cancelled - insufficient players'
      });
    }
    
    await this.broadcastToRoom(gameId, 'game:cancelled', {
      game_id: gameId,
      reason: 'Not enough players joined'
    });
  }
}
```

### 8.2 Winner Prize Calculation
```
Total Pool = Ticket Price × Total Cartelas Purchased
House Edge  = Total Pool × House Edge %
Prize Pool  = Total Pool - House Edge

Example (10 Birr game, 6 entries, 2 cartelas each):
  Total Pool = 10 × 12 = 120 Birr
  House Edge = 120 × 0.10 = 12 Birr
  Prize Pool = 108 Birr → Winner receives 108 Birr
```

---

## 9. Payment System Design

### 9.1 Manual Payment Flow (TeleBirr)

> All payments are handled manually via TeleBirr merchant transfers.
> No Chapa or Telebirr API integration is used.

```
DEPOSIT:
1. User navigates to "Payment Methods" / Deposit tab
2. User sees instruction: "Transfer Funds Within 15 Minutes"
   to merchant number 0901977670 via TeleBirr
3. User performs the transfer via the TeleBirr app
4. User returns to web app and fills out the deposit form:
   - Amount (e.g., 200 ETB)
   - Transaction ID (e.g., DAB2Q8G0FC)
   - Name (sender's name on the receipt)
   - TeleBirr Account Number (sender's phone, e.g., +251912345678)
   - Receipt Screenshot (uploaded image)
5. User submits → request appears as "Pending" in admin Orders History

DEPOSIT VERIFICATION (Admin):
1. Admin opens "Deposits" menu, selects a "Pending" entry
2. Admin clicks receipt icon to view the uploaded image
3. Admin cross-checks submitted data (Transaction ID, Name, Account)
   against the official TeleBirr receipt image
4. Admin clicks "Approved" → wallet credited, user notified
   OR Admin clicks "Declined" with reason → user notified

WITHDRAWAL:
1. User enters withdrawal amount (min 100 ETB) + TeleBirr phone number
2. Submit → balance deducted immediately, request enters "Pending" state
3. Admin views pending withdrawals with Username (+251...) and Amount
4. Admin manually sends funds via TeleBirr
5. Admin clicks "Approved" → status updated, user notified
   OR Admin clicks "Rejected" → held balance refunded to user wallet
```

### 9.2 Edge Cases

| Scenario | Handling |
|---|---|
| **Invalid receipt** | User uploads corrupted/unrelated image. Admin declines with reason "Invalid receipt". |
| **Stale request** | User transfers but doesn't submit form within 15 minutes. Admin sees "Late submission" badge. Manual reconciliation required. |
| **Input mismatch** | Transaction ID in form doesn't match receipt image. Admin declines with reason "Transaction ID mismatch". |
| **Duplicate submission** | User submits same Transaction ID twice. Backend should flag/warn admin of duplicate `paymentTransactionId`. |

### 9.3 Dashboard Statistics

| Stat | Description |
|---|---|
| **Approved Deposit Sum** | Total ETB of approved deposits (e.g., 21,495 ETB) |
| **Declined Deposit Sum** | Total ETB of declined deposits (e.g., 6,490 ETB) |
| **Approved Withdrawal Sum** | Total ETB of approved withdrawals (e.g., 11,981 ETB) |
| **Total Profit** | House edge earnings |
| **Users Count** | Total registered users |
| **Commission** | Platform commission percentage |

### 9.4 Financial Controls

| Control | Implementation |
|---|---|
| **Idempotent Transactions** | Each transaction has a unique idempotency key |
| **Locking** | Wallet balance updates use `SELECT FOR UPDATE` |
| **Atomicity** | All balance changes in a single DB transaction |
| **Audit Trail** | Every balance change records `balance_before` and `balance_after` |
| **Minimum Deposit** | 25 Birr (enforced server-side) |
| **Minimum Withdrawal** | 100 Birr (enforced server-side) |
| **Daily Withdrawal Limit** | 10,000 Birr (configurable per user tier) |

---

## 10. Security Specification

### 10.1 Authentication & Authorization
- JWT RS256 (asymmetric signing)
- Access tokens: 15 minutes
- Refresh tokens: 30 days (stored in HttpOnly cookie)
- RBAC: `player` and `admin` roles
- Session invalidation on logout (token blacklist in Redis)

### 10.2 Input Validation
- All API inputs validated with Zod schemas
- SQL injection impossible via parameterized queries (Prisma ORM)
- File uploads: type validation (image only), size limit (5MB), virus scan

### 10.3 Rate Limiting
| Endpoint Category | Limit |
|---|---|
| Auth (login/register) | 10 requests/minute per IP |
| Game join | 5 requests/30 seconds per user |
| Deposit/Withdraw | 3 requests/minute per user |
| General API | 100 requests/minute per user |

### 10.4 Anti-Fraud Measures
- Server-side BINGO validation (client cannot cheat)
- Called numbers generated and stored server-side
- All game state is authoritative on the server; client is display-only
- Duplicate cartela ownership prevented by DB unique constraint

### 10.5 Infrastructure Security
- All connections over HTTPS/WSS
- Database not publicly exposed (VPC-only)
- Redis not publicly exposed (VPC-only)
- Environment variables managed via GCP Secret Manager

---

## 11. Frontend Design Specification

### 11.1 Design System

#### Color Palette
```css
:root {
  /* Backgrounds */
  --color-bg-primary: #0f172a;       /* Deep Navy */
  --color-bg-secondary: #1e293b;     /* Slate dark */
  --color-bg-card: #1e293b;
  --color-bg-modal: #0f172a;
  
  /* Brand Colors */
  --color-accent-gold: #f59e0b;      /* Primary CTA (Join, Deposit) */
  --color-accent-cyan: #06b6d4;      /* Highlights, active states */
  
  /* Status */
  --color-success: #10b981;          /* Win, Refunded */
  --color-error: #ef4444;            /* Rejected, cancelled */
  --color-warning: #f59e0b;          /* Pending */
  
  /* Text */
  --color-text-primary: #f1f5f9;
  --color-text-muted: #94a3b8;
}
```

#### Typography
- **Primary Font:** Inter or Outfit (Google Fonts)
- **Number Display (Bingo Ball):** Bold, large (48px+), monospace feel
- **Labels:** 12–14px, uppercase, letter-spacing

#### Component Inventory
| Component | Description |
|---|---|
| `GameCard` | Lobby card for each game room |
| `CartelaGrid` | 5×5 Bingo card display |
| `BingoBall` | Called number display with animation |
| `WalletModal` | Slide-up modal with balance and actions |
| `DepositForm` | Multi-step deposit flow |
| `WithdrawForm` | Bank withdrawal form |
| `TransactionRow` | Row in history list |
| `NotificationBell` | Bell icon with badge count |
| `Sidebar` | Navigation drawer |
| `CountdownTimer` | Animated countdown |

### 11.2 Page Structure

| Route | Component | SSR/CSR |
|---|---|---|
| `/auth` | LoginPage | CSR |
| `/` | LobbyPage | CSR (real-time) |
| `/quick/[gameId]` | CartelaSelectPage | CSR |
| `/quick/[gameId]/play` | GamePlayPage | CSR (real-time) |
| `/admin` | AdminDashboard | SSR |
| `/admin/payments` | PaymentVerification | SSR+CSR |

### 11.3 Animation Specification
| Interaction | Animation |
|---|---|
| Bingo ball called | Bounce-in + golden glow pulse |
| Number marked on card | Scale up + color fill |
| BINGO! claim | Full-screen celebration confetti |
| Game cancelled | Toast notification slide-in from top |
| Wallet balance update | Number counter animation |
| Cartela selection | Scale + border highlight |
| Page transitions | Fade-through |

---

## 12. Deployment Specification

### 12.1 Tech Stack Summary

| Layer | Technology | Rationale |
|---|---|---|
| **Frontend** | Next.js 14 (App Router) | SSR, file-based routing, React Server Components |
| **Backend API** | Node.js + Fastify | High performance, low overhead vs Express |
| **WebSocket** | Socket.io v4 | Proven, Redis adapter available, fallback support |
| **Language** | TypeScript | Type safety across full stack |
| **ORM** | Prisma | Type-safe DB queries, migrations |
| **Database** | PostgreSQL 16 | ACID transactions, JSON support |
| **Cache/Queue** | Redis 7 | Pub/Sub, BullMQ, session store |
| **File Storage** | Google Cloud Storage | Receipt images |
| **CI/CD** | GitHub Actions | Automated test + deploy pipeline |
| **Hosting** | Google Cloud Run | Serverless containers, auto-scale |
| **Monitoring** | Grafana + Prometheus | Metrics and alerting |
| **Logging** | Google Cloud Logging | Centralized log management |

### 12.2 Monorepo Structure

```
bingo-platform/
├── apps/
│   ├── web/                    # Next.js player frontend
│   │   ├── app/
│   │   │   ├── auth/
│   │   │   ├── (lobby)/
│   │   │   │   └── page.tsx
│   │   │   ├── quick/
│   │   │   │   └── [gameId]/
│   │   │   │       ├── page.tsx      # Cartela selection
│   │   │   │       └── play/
│   │   │   │           └── page.tsx  # Live game
│   │   │   └── layout.tsx
│   │   └── components/
│   ├── admin/                  # Next.js admin dashboard
│   └── api/                    # Fastify REST API + Socket.io
│       ├── src/
│       │   ├── routes/
│       │   ├── services/
│       │   ├── game-engine/
│       │   ├── workers/
│       │   └── websocket/
│       └── prisma/
│           └── schema.prisma
├── packages/
│   ├── shared-types/           # TypeScript interfaces
│   ├── game-logic/             # Pure game logic (sharable)
│   └── ui/                     # Shared React components
└── infrastructure/
    ├── docker-compose.yml
    └── k8s/                    # Kubernetes manifests (optional)
```

### 12.3 Environment Variables

```env
# API
NODE_ENV=production
PORT=8080
DATABASE_URL=postgresql://user:pass@host:5432/bingo
REDIS_URL=redis://host:6379
JWT_PRIVATE_KEY=<RS256 private key>
JWT_PUBLIC_KEY=<RS256 public key>
JWT_REFRESH_SECRET=<secret>
GCS_BUCKET_NAME=bingo-receipts
GCS_PROJECT_ID=your-project
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

# Frontend
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_WS_URL=wss://api.yourdomain.com
```

### 12.4 CI/CD Pipeline

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]

jobs:
  test:
    - Run unit tests (Jest/Vitest)
    - Run integration tests
    - TypeScript type-check

  build:
    - Docker build for api image
    - Docker build for web image
    - Push to Google Artifact Registry

  deploy:
    - Deploy api to Cloud Run
    - Deploy web to Cloud Run
    - Run DB migrations (prisma migrate deploy)
    - Smoke tests against production
```

---

## Appendix A: Risk Register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Payment fraud (fake receipts) | High | High | AI receipt verification, manual review, transaction limits |
| Redis failure during game | Low | Critical | Redis HA, game state checkpoint to PostgreSQL every 30s |
| WebSocket server crash during game | Low | High | Client auto-reconnect, game state recovery from Redis |
| Database connection exhaustion | Medium | High | PgBouncer pooling, read replicas |
| DDoS on WebSocket | Medium | High | Cloudflare WAF, rate limiting |
| Double-spend on wallet | Low | Critical | DB `SELECT FOR UPDATE` lock on all wallet mutations |

## Appendix B: Glossary

| Term | Definition |
|---|---|
| **Cartela** | Ethiopian term for a Bingo card; a 5×5 grid of numbers |
| **House Edge** | Percentage of prize pool retained by the operator |
| **Quorum** | Minimum number of players required for a game to start |
| **Ball Calling** | The sequential random selection of Bingo numbers |
| **Dead Letter Queue** | Queue for failed background jobs that need manual review |
| **Birr (ETB)** | Ethiopian currency used for all transactions |
