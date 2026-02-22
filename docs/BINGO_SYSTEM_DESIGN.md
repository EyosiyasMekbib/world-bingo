# World Bingo — System Design Document

> **Focus:** High-Concurrency Architecture Supporting 10,000+ Simultaneous Users  
> **Date:** 2026-02-20

---

## 1. System Overview & Goals

The World Bingo platform is a **real-time, real-money multiplayer game** that demands:

- **Sub-50ms** event propagation from server to all game participants
- **Zero game state loss** even if one server instance crashes
- **Atomic financial transactions** — no double-spends, no lost money
- **Horizontal scalability** to grow from 100 to 100,000 concurrent users by adding instances
- **Fair gameplay guaranteed by server authority** — the client is always untrusted

---

## 2. C4 Context Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        EXTERNAL ACTORS                           │
│                                                                  │
│   [Player] ──────────────────────────────► [World Bingo System] │
│   (Browses, deposits, plays bingo)              │                │
│                                                 │                │
│   [Admin/Operator] ─────────────────────────────►               │
│   (Verifies payments, manages games)            │                │
│                                                 │                │
│   [Payment Method]  ◄─────────────────────────                 │
│   (TeleBirr — manual merchant transfer)                          │
│                                                                  │
│   [Email/SMS Provider] ◄────────────────────────                │
│   (Twilio SMS, SendGrid Email)                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Container Diagram (Services)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         WORLD BINGO PLATFORM                            │
│                                                                         │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                   │
│  │  Player App  │   │  Admin App  │   │  Mobile App  │  ← Future        │
│  │  (Next.js)  │   │  (Next.js)  │   │  (React Nat)│                   │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘                   │
│         │                 │                  │                          │
│         └─────────────────┼──────────────────┘                         │
│                           │ HTTPS + WSS                                 │
│                    ┌──────▼──────┐                                      │
│                    │   API GW /  │                                      │
│                    │ Load Balancer│                                      │
│                    └──────┬──────┘                                      │
│                           │                                              │
│          ┌────────────────┼────────────────┐                           │
│          │                │                │                           │
│   ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐                   │
│   │  REST API   │  │  WS Server  │  │   Workers   │                   │
│   │  (Fastify)  │  │ (Socket.io) │  │  (BullMQ)   │                   │
│   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                   │
│          │                │                │                           │
│          └────────────────┼────────────────┘                           │
│                           │                                              │
│     ┌─────────────────────┼─────────────────────┐                      │
│     │                     │                     │                      │
│  ┌──▼──┐           ┌──────▼──────┐       ┌──────▼──────┐               │
│  │  PG │           │    Redis    │       │    GCS      │               │
│  │  DB │           │  (Cache +   │       │  (Receipts) │               │
│  │     │           │  Pub/Sub +  │       └─────────────┘               │
│  └─────┘           │  Game State)│                                      │
│                    └─────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Request Flow Diagrams

### 4.1 Player Joins a Game

```
Player                  API Server            Redis              PostgreSQL
  │                         │                   │                    │
  │── POST /games/:id/join ─►│                   │                    │
  │                         │── GET wallet ─────────────────────────►│
  │                         │◄─ balance: 50.00 ─────────────────────│
  │                         │                   │                    │
  │                         │── ATOMIC TX (BEGIN) ─────────────────►│
  │                         │   Deduct wallet balance                │
  │                         │   Insert game_entry row                │
  │                         │   Assign cartela to user              │
  │                         │── COMMIT ─────────────────────────────►│
  │                         │                   │                    │
  │                         │── INCR game:playerCount ─►│           │
  │                         │── SADD game:players userId►│          │
  │                         │                   │                    │
  │                         │── PUBLISH lobby:game:updated ──────►  │
  │                         │   (triggers all WS servers to         │
  │                         │    broadcast updated player count)    │
  │                         │                   │                    │
  │◄── 200 {entry, balance} ─│                   │                    │
```

### 4.2 Live Number Calling (Distributed Fan-out)

```
Game Engine Worker      Redis Pub/Sub        WS Server A       WS Server B
      │                      │                    │                  │
      │── Store called[42] ─►│                    │                  │
      │── PUBLISH game:uuid:number_called ─────►  │                  │
      │         {number: 42, called: [...]}        │                  │
      │                      │─── Forward ────────►│                  │
      │                      │─── Forward ──────────────────────────►│
      │                      │                    │                  │
      │                      │           Players connected    Players connected
      │                      │           to Server A          to Server B
      │                      │           receive event         receive event
      │                      │           simultaneously        simultaneously
```

### 4.3 Wallet Deposit (Manual Flow)

```
Player          Frontend         API Server        Admin Panel       Worker
  │                │                 │                  │               │
  │─ Enter amount ─►│                │                  │               │
  │─ Upload receipt─►│               │                  │               │
  │                │── POST /deposit ►│                 │               │
  │                │                 │── Upload to GCS  │               │
  │                │                 │── INSERT payment_request (PENDING)│
  │                │◄── 201 PENDING ─│                  │               │
  │                │                 │                  │               │
  │                │                 │  Admin logs in ──►│              │
  │                │                 │  Sees receipt ───►│              │
  │                │                 │  Clicks Approve ──►              │
  │                │                 │◄── PUT /admin/payments/:id/approve
  │                │                 │── BEGIN TX ────────────────────────►
  │                │                 │   UPDATE payment (APPROVED)      │
  │                │                 │   UPDATE wallet balance (+amount) │
  │                │                 │   INSERT transaction (DEPOSIT/COMPLETED)
  │                │                 │── COMMIT ──────────────────────────►
  │                │                 │── Enqueue notification job ────►  │
  │                │                 │                  │     Job executed│
  │                │                 │                  │  PUBLISH wallet:balance_updated
  │◄─ WS: balance updated ──────────────────────────────────────────────│
```

---

## 5. Data Flow: Game Session Lifecycle

```
[GAME CREATED by Admin]
        │
        ▼
  Status: WAITING
  Redis: game:{id}:state = {status: WAITING, playerCount: 0, ...}
  Lobby: SADD lobby:waiting_games gameId
        │
        │ Players join (0 → N)
        ▼
  playerCount increases in Redis
  WS broadcast: game:updated (new count)
        │
        │ Countdown timer reaches 0
        ▼
  IF playerCount < MIN_PLAYERS:
    Status: CANCELLED
    Enqueue refunds for each player
    WS broadcast: game:cancelled
    Remove from lobby
  ELSE:
    Status: STARTING
    WS broadcast: game:state_change {STARTING}
    5-second grace period
        │
        ▼
  Status: ACTIVE
  Game Engine holds distributed lock (Redlock)
  Calls numbers every 3.5 seconds
  Each call:
    - Add to Redis called list
    - PUBLISH to all WS servers
    - WS servers forward to game room clients
        │
        │ Player clicks BINGO
        ▼
  API: POST /games/:id/claim_bingo
    - Acquire game lock
    - Validate claim server-side
    - If valid:
        Status: WINNER_DECLARED
        Calculate prize (total pool - house edge)
        BEGIN TX:
          Credit winner wallet
          Insert WIN transaction
          Update game record (winner, prize)
        COMMIT
        WS broadcast: game:winner
    - If invalid:
        Return 400 (invalid claim)
        Continue game
        │
        ▼
  Status: ENDED
  Persist final game state to PostgreSQL
  Clear Redis game keys
  Send post-game notifications
  Redirect all players to lobby after 10s
```

---

## 6. Database Design (Entity Relationship)

```
┌─────────────┐       ┌─────────────┐       ┌──────────────────┐
│    users    │──────►│   wallets   │       │  payment_requests│
│─────────────│  1:1  │─────────────│       │──────────────────│
│ id (PK)     │       │ id (PK)     │       │ id (PK)          │
│ username    │       │ user_id(FK) │       │ user_id (FK)     │
│ phone       │       │ balance     │◄──────│ type             │
│ password_h  │       │ currency    │       │ amount           │
│ role        │       └─────────────┘       │ receipt_url      │
└──────┬──────┘                             │ bank_name        │
       │                                    │ account_number   │
       │         ┌─────────────┐            │ status           │
       │         │transactions │            └──────────────────┘
       └────────►│─────────────│
                 │ id (PK)     │
                 │ user_id(FK) │           ┌──────────────────┐
                 │ wallet_id(FK)│          │    cartelas      │
                 │ type        │           │──────────────────│
                 │ amount      │           │ id (PK)          │
                 │ status      │           │ card_number      │
                 │ reference_id│           │ b_column (int[]) │
                 └─────────────┘           │ i_column (int[]) │
                                           │ n_column (int[]) │
┌──────────────────┐                       │ g_column (int[]) │
│     games        │                       │ o_column (int[]) │
│──────────────────│                       └──────────────────┘
│ id (PK)          │
│ ticket_price     │      ┌──────────────────────────┐
│ min_players      │      │    game_cartela_assignments│
│ status           │      │──────────────────────────│
│ called_numbers[] │      │ id (PK)                  │
│ winner_user_id   │◄─────│ game_id (FK) ─────►games │
│ prize_amount     │      │ user_id (FK) ─────►users │
│ house_edge_pct   │      │ cartela_id(FK)────►cartelas│
└──────────────────┘      └──────────────────────────┘
```

---

## 7. Redis Data Structures

```
KEY SCHEMA:
═══════════════════════════════════════════════════════

# Active Game State (Hash)
game:{gameId}:state
  Fields: status, called_numbers_json, player_count, 
          prize_pool, winning_pattern, started_at

# Connected Players (Set)
game:{gameId}:players
  Members: {userId}

# Cartela → Owner Mapping (Hash)
game:{gameId}:cartelas
  Fields: {cartelaId} → {userId}

# Waiting Games for Lobby (Sorted Set)
lobby:waiting_games
  Score: Unix timestamp of game start time
  Member: {gameId}

# User Session Cache (String)
session:{userId}
  Value: JWT payload JSON
  TTL: 900 seconds (15 min)

# Wallet Balance Cache (String)
wallet:{userId}:balance
  Value: "350.00"
  TTL: 30 seconds

# Rate Limiting (String w/ TTL)
ratelimit:login:{ip}
  Value: attempt count
  TTL: 60 seconds

# Distributed Lock for Game Engine (String)
lock:game_engine:{gameId}
  Value: worker instance ID
  TTL: 10 seconds (auto-renewed every 5s by holding worker)

# BullMQ Job Queues (Stream/List)
bull:refund-queue
bull:notification-queue
bull:withdrawal-queue
```

---

## 8. API Gateway Configuration

### Nginx Configuration (Reverse Proxy)

```nginx
upstream api_servers {
  least_conn;
  server api-1:8080;
  server api-2:8080;
  server api-3:8080;
  keepalive 64;
}

upstream ws_servers {
  ip_hash;  # Sticky sessions for WebSocket connections
  server ws-1:8081;
  server ws-2:8081;
}

server {
  listen 443 ssl http2;

  # REST API
  location /api/ {
    proxy_pass http://api_servers;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_read_timeout 30s;
    
    # Rate limiting
    limit_req zone=api_limit burst=20 nodelay;
  }

  # WebSocket
  location /socket.io/ {
    proxy_pass http://ws_servers;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;  # 1 hour for persistent WS
    proxy_send_timeout 3600s;
  }
}
```

**Key:** WebSocket connections use `ip_hash` load balancing (sticky sessions) so that a user's Socket.io handshake and upgrade happen on the same server. Once connected, cross-server pub/sub is handled by Redis.

---

## 9. Concurrency & Locking Strategy

### 9.1 Wallet Operations (Database-Level Locking)

```typescript
// All wallet mutations MUST go through this function
async function deductWalletBalance(
  tx: PrismaTransaction,
  userId: string,
  amount: Decimal,
  reason: string
): Promise<Wallet> {
  // Lock the wallet row for this transaction
  const wallet = await tx.$queryRaw<Wallet[]>`
    SELECT * FROM wallets WHERE user_id = ${userId} FOR UPDATE
  `;

  if (wallet[0].balance < amount) {
    throw new InsufficientFundsError();
  }

  return await tx.wallet.update({
    where: { userId },
    data: {
      balance: { decrement: amount },
      updatedAt: new Date()
    }
  });
}
```

### 9.2 Cartela Claiming (Redis Atomic Operations)

```typescript
// Prevent two players from claiming the same cartela
async function claimCartela(
  gameId: string,
  cartelaId: string,
  userId: string
): Promise<boolean> {
  // HSETNX is atomic: only sets if field doesn't exist
  const claimed = await redis.hsetnx(
    `game:${gameId}:cartelas`,
    cartelaId,
    userId
  );

  return claimed === 1; // 1 = success, 0 = already taken
}
```

### 9.3 Game Engine Leader Election (Redlock)

```typescript
import Redlock from 'redlock';

const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 3,
  retryDelay: 200,
});

async function runGameEngine(gameId: string) {
  // Only ONE worker instance will hold this lock
  let lock = await redlock.acquire([`lock:game_engine:${gameId}`], 10000);

  try {
    while (gameIsActive(gameId)) {
      await callNextNumber(gameId);
      await sleep(3500);
      
      // Extend lock before it expires
      lock = await lock.extend(10000);
    }
  } finally {
    await lock.release();
  }
}
```

---

## 10. Scalability Benchmarks & Targets

### 10.1 Load Projections

| Users Online | Concurrent Games | WS Connections | API RPS |
|---|---|---|---|
| 100 | 5 | 150 | 50 |
| 1,000 | 50 | 1,500 | 500 |
| 5,000 | 200 | 7,500 | 2,500 |
| 10,000 | 500 | 15,000 | 5,000 |
| 50,000 | 2,000 | 75,000 | 25,000 |

### 10.2 Infrastructure Scaling Plan

| Users | API Instances | WS Instances | Redis Memory | PG Spec |
|---|---|---|---|---|
| < 1,000 | 2 | 2 | 1GB | 2 vCPU / 4GB |
| 1K–10K | 5 | 5 | 4GB | 4 vCPU / 16GB |
| 10K–50K | 15 | 10 | 8GB | 8 vCPU / 32GB + read replica |
| 50K+ | 30+ | 20+ | 16GB | 16 vCPU / 64GB + 2 read replicas |

### 10.3 Performance Optimization Checklist

| Area | Optimization |
|---|---|
| **Database** | Index on `games.status`, `transactions.user_id`, `game_entries.game_id` |
| **Database** | `pg_partitioning` on `transactions` table by month |
| **Database** | PgBouncer connection pooling (transaction mode) |
| **API** | Response compression (gzip/br) |
| **API** | HTTP/2 multiplexing via Nginx |
| **WebSocket** | Enable per-message deflate compression |
| **Redis** | Pipelining for multi-command operations |
| **Frontend** | Next.js static generation for non-dynamic pages |
| **Frontend** | React lazy loading for modal components |
| **Assets** | Cloudflare CDN for JS bundles and images |
| **Cartelas** | Pre-generate and cache all 70+ cartela grids at startup |

---

## 11. Fault Tolerance & Disaster Recovery

### 11.1 Redis Failure During Active Game

```
Scenario: Redis crashes during a live game

Mitigation:
  1. Game state checkpointed to PostgreSQL every 30 seconds
     (background task writes called_numbers, player_count)
  2. On reconnect, game engine reloads state from PostgreSQL
  3. Players reconnecting via WebSocket receive full catch-up
     state (all called numbers so far) on connect

Recovery Time: < 30 seconds of state potentially lost
Acceptable: Yes (at most 8 balls missed, player can see called list)
```

### 11.2 API Server Crash During Wallet Transaction

```
Scenario: Server crashes mid-transaction

Mitigation:
  All wallet mutations are in a single PostgreSQL ACID transaction.
  If the server crashes, the transaction is automatically rolled back
  by PostgreSQL. The next request will see the original balance.
  Idempotency keys prevent duplicate processing on retry.

Recovery Time: Instant (PostgreSQL handles it)
Data Loss: Zero
```

### 11.3 WebSocket Server Crash During Game

```
Scenario: WS Server B crashes; 500 players lose connection

Mitigation:
  1. Socket.io client configured with auto-reconnect (exponential backoff)
  2. Client will reconnect to another WS server (Server A or C)
  3. On reconnect, client emits 'game:subscribe' with game_id
  4. Server immediately sends current game state from Redis
  5. Player is back in game within 2–5 seconds

Recovery Time: 2–5 seconds per client (transparent to user)
```

---

## 12. Monitoring & Alerting

### 12.1 Key Metrics to Track

| Metric | Tool | Alert Threshold |
|---|---|---|
| API P99 latency | Prometheus + Grafana | > 500ms |
| WebSocket event lag | Custom metric | > 100ms |
| Active WS connections | Socket.io admin | > 80% of capacity |
| Redis memory usage | Redis metrics | > 80% |
| PostgreSQL connection count | pg_stat_activity | > 80% of max |
| BullMQ queue depth | BullMQ dashboard | > 1000 jobs |
| Failed transactions | DB query | > 10/minute |
| Game cancellation rate | DB query | > 30% of games |

### 12.2 Dashboard Panels (Grafana)

1. **Business Metrics:** Active games, players online, hourly revenue, deposits/withdrawals
2. **Infrastructure:** CPU/memory per service, network I/O
3. **Database:** Query latency, connection pool usage, slow queries
4. **Redis:** Memory, hit rate, pub/sub message throughput
5. **Game Health:** Average players per game, game completion rate, BINGO claims/rejections

---

## 13. Development Roadmap

### Phase 1 — MVP (6 weeks)
- [ ] User auth (register, login, JWT)
- [ ] Wallet system (deposit manual, withdrawal manual)
- [ ] Lobby with one game type
- [ ] Cartela selection
- [ ] Live game (WebSocket ball calling, card marking)
- [ ] Winner detection and payout
- [ ] Admin panel (payment verification, game management)

### Phase 2 — Scale & Polish (4 weeks)
- [ ] Redis adapter for Socket.io (horizontal WS scaling)
- [ ] BullMQ workers for refunds and notifications
- [ ] SMS notifications (Twilio)
- [ ] Multiple winning patterns (diagonal, full card)
- [ ] Game history and statistics page
- [ ] Mobile responsive optimization

### Phase 3 — Manual Payment Flow Hardening (2 weeks)
- [ ] Add TeleBirr transaction details to deposit form (Transaction ID, Name, Account Number)
- [ ] Admin cross-check: receipt image vs submitted form data
- [ ] 15-minute transfer deadline display & stale request warnings
- [ ] Predefined decline reasons for admin review
- **Note:** No Chapa or Telebirr API integration. All payments are manual receipt-based via TeleBirr merchant transfers.

### Phase 4 — Growth Features (4 weeks)
- [ ] Referral system
- [ ] VIP tiers and bonus system
- [ ] Tournament mode
- [ ] Multi-language support (Amharic)
- [ ] Progressive Jackpot mode
