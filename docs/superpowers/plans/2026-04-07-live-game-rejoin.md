# Live Game Rejoin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user navigates away from a live game and returns, they seamlessly re-enter the active game exactly as if they never left — seeing their cartelas, all balls called so far, and continuing to receive live events.

**Architecture:** The frontend `init()` function already fetches game details, seeds `myEntries` and `calledBalls` from the server, and re-connects the socket on mount. The only functional gap is that `GET /games/:id` returns `calledBalls` from the database, which lags behind Redis (the game engine writes to Redis, not DB, during live play). Fixing the controller to read live balls from Redis on the way out closes the gap entirely. Additionally, `fetchAvailableCartelas` is skipped when the game is already `IN_PROGRESS` to avoid a wasteful network call and potential errors on a locked room.

**Tech Stack:** Fastify (Node.js), Prisma + PostgreSQL, Redis (ioredis), Nuxt 3 / Vue 3, Pinia, Socket.io

---

### Task 1: Return live Redis calledBalls from `GET /games/:id`

**Files:**
- Modify: `apps/api/src/controllers/game.controller.ts:91-106`

The `get()` method currently returns `calledBalls` straight from Prisma. During an active game the game engine writes new balls only to Redis; the DB column is only updated at game-end. This task makes the controller merge in the Redis list when the game is `IN_PROGRESS`.

- [ ] **Step 1: Add the Redis import to game.controller.ts**

Open `apps/api/src/controllers/game.controller.ts`. At the top (after the existing imports), add:

```ts
import { getCalledBalls } from '../lib/game-state'
import { GameStatus } from '@world-bingo/shared-types'
```

`GameStatus` is already imported — only add `getCalledBalls`. If `GameStatus` is already present, skip it.

- [ ] **Step 2: Replace the `get()` method body**

Replace the existing `get()` method (lines ~91-106) with:

```ts
static async get(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const game = await prisma.game.findUnique({
        where: { id: request.params.id },
        include: {
            entries: {
                include: { cartela: true },
            },
            _count: { select: { entries: true } },
        },
    })

    if (!game) return reply.status(404).send({ message: 'Game not found' })

    const distinctPlayers = new Set(game.entries.map((e: any) => e.userId)).size

    // For live games, Redis holds the authoritative ball list; DB lags behind.
    let calledBalls: number[] = (game as any).calledBalls ?? []
    if (game.status === GameStatus.IN_PROGRESS) {
        const redisBalls = await getCalledBalls(game.id)
        if (redisBalls.length > 0) calledBalls = redisBalls
    }

    return { ...game, calledBalls, currentPlayers: distinctPlayers }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm --filter @world-bingo/api typecheck
```

Expected: no errors related to `game.controller.ts`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/controllers/game.controller.ts
git commit -m "fix(api): return live Redis calledBalls in GET /games/:id for rejoin"
```

---

### Task 2: Skip `fetchAvailableCartelas` when game is already IN_PROGRESS

**Files:**
- Modify: `apps/web/pages/quick/[gameId]/play.vue` (the `init()` function, ~line 704)

When a user rejoins an `IN_PROGRESS` game the join phase never renders (`phase === 'active'`), so fetching available cartelas is wasteful and can fail if the room is locked. This task guards that call.

- [ ] **Step 1: Wrap `fetchAvailableCartelas` in a status check**

Find this block inside `init()` (around line 704):

```ts
// Load cartelas for join phase (needed even if already joined for card display)
await gameStore.fetchAvailableCartelas(gameId)
```

Replace it with:

```ts
// Load cartelas for join phase only — not needed when rejoining an active game
if (rawStatus !== 'IN_PROGRESS') {
  await gameStore.fetchAvailableCartelas(gameId)
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/pages/quick/[gameId]/play.vue
git commit -m "fix(web): skip fetchAvailableCartelas when rejoining IN_PROGRESS game"
```

---

### Task 3: Manual smoke test

No automated tests exist for the play page (it requires a live socket + game). Verify the rejoin flow manually.

- [ ] **Step 1: Start infra and all apps**

```bash
pnpm infra:up
pnpm dev
```

- [ ] **Step 2: Start a game and join it**

1. Open admin at http://localhost:3001 → create a game
2. Open the player app at http://localhost:3002 → log in → join the game with a cartela
3. Start the game (via admin or wait for auto-start)
4. Confirm you see the active game view with balls being called

- [ ] **Step 3: Leave and rejoin**

1. While the game is active (balls being called), navigate away (e.g. click Back to Lobby)
2. Navigate back to `/quick/[gameId]/play`
3. Expected:
   - Loading spinner briefly, then the active game view loads immediately
   - Your cartela(s) are visible with all previously called balls already marked
   - The ball board shows all called balls up to that moment
   - New ball calls continue to appear in real time

- [ ] **Step 4: Verify no join-phase flash**

Confirm the "Select Cartela" join UI never appears when returning to an IN_PROGRESS game.
