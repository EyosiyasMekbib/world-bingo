import redis from './redis'

/**
 * T14 — Redis Game State Module
 *
 * During active games, all volatile game state lives in Redis.
 * Keys:
 *   game:{gameId}:state   — Hash with status, pattern, startedAt, winnerId
 *   game:{gameId}:called  — List of called ball numbers
 *   game:{gameId}:players — Set of player userIds
 *
 * At game end, the final state is persisted back to PostgreSQL.
 */

// ─── Key Helpers ─────────────────────────────────────────────────────────────

const stateKey = (gameId: string) => `game:${gameId}:state`
const calledKey = (gameId: string) => `game:${gameId}:called`
const playersKey = (gameId: string) => `game:${gameId}:players`

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RedisGameState {
    gameId: string
    status: string
    pattern: string
    ticketPrice: string
    maxPlayers: string
    minPlayers: string
    houseEdgePct: string
    startedAt: string
    winnerId?: string
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Initialize game state in Redis when a game starts (or is created).
 */
export async function initGameState(
    gameId: string,
    data: {
        status: string
        pattern: string
        ticketPrice: string
        maxPlayers: number
        minPlayers: number
        houseEdgePct: string
        playerIds: string[]
    },
): Promise<void> {
    const pipeline = redis.pipeline()

    pipeline.hset(stateKey(gameId), {
        gameId,
        status: data.status,
        pattern: data.pattern,
        ticketPrice: data.ticketPrice,
        maxPlayers: String(data.maxPlayers),
        minPlayers: String(data.minPlayers),
        houseEdgePct: data.houseEdgePct,
        startedAt: new Date().toISOString(),
    })

    // Add players
    if (data.playerIds.length > 0) {
        pipeline.sadd(playersKey(gameId), ...data.playerIds)
    }

    // Ensure the called balls list is empty
    pipeline.del(calledKey(gameId))

    await pipeline.exec()
}

// ─── Called Balls ────────────────────────────────────────────────────────────

/**
 * Add a called ball to the game's called list.
 * Returns the total number of called balls after the push.
 */
export async function addCalledBall(gameId: string, ball: number): Promise<number> {
    return redis.rpush(calledKey(gameId), String(ball))
}

/**
 * Get all called balls for a game (in order).
 */
export async function getCalledBalls(gameId: string): Promise<number[]> {
    const raw = await redis.lrange(calledKey(gameId), 0, -1)
    return raw.map(Number)
}

// ─── Game State ──────────────────────────────────────────────────────────────

/**
 * Get the full game state hash from Redis.
 * Returns null if the game state doesn't exist.
 */
export async function getGameState(gameId: string): Promise<RedisGameState | null> {
    const data = await redis.hgetall(stateKey(gameId))
    if (!data || Object.keys(data).length === 0) return null
    return data as unknown as RedisGameState
}

/**
 * Update one or more fields of the game state hash.
 */
export async function updateGameState(
    gameId: string,
    fields: Partial<Record<string, string>>,
): Promise<void> {
    if (Object.keys(fields).length === 0) return
    await redis.hset(stateKey(gameId), fields)
}

// ─── Players ─────────────────────────────────────────────────────────────────

/**
 * Add a player to the game's player set.
 */
export async function addPlayer(gameId: string, userId: string): Promise<void> {
    await redis.sadd(playersKey(gameId), userId)
}

/**
 * Get all player IDs in a game.
 */
export async function getPlayers(gameId: string): Promise<string[]> {
    return redis.smembers(playersKey(gameId))
}

/**
 * Get the count of players in a game.
 */
export async function getPlayerCount(gameId: string): Promise<number> {
    return redis.scard(playersKey(gameId))
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Remove all Redis keys for a game (call after game ends and state is persisted to PG).
 */
export async function clearGameState(gameId: string): Promise<void> {
    await redis.del(stateKey(gameId), calledKey(gameId), playersKey(gameId))
}

// ─── Export Key Helpers for Tests ────────────────────────────────────────────
export const keys = { stateKey, calledKey, playersKey }
