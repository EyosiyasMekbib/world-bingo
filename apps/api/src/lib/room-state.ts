/**
 * Room State — Redis Layer
 *
 * Manages the per-room volatile state during the WAITING phase and throughout
 * the game lifecycle as described in the system architecture spec.
 *
 * Redis keys (mirroring the spec exactly):
 *   room:{roomId}:timer    — String integer. Seconds left on the countdown.
 *   room:{roomId}:players  — Set of unique player IDs who have purchased tickets.
 *   room:{roomId}:pot      — String integer. Total ETB collected in this room.
 *   room:{roomId}:status   — String. Current state-machine phase.
 *   room:{roomId}:drawn    — List of drawn ball numbers (IN_PROGRESS phase).
 *
 * All keys share a TTL that auto-expires 2 hours after creation to prevent
 * orphan state on crashed games.
 */

import redis from './redis'

// ─── TTL ──────────────────────────────────────────────────────────────────────
/** 2-hour TTL on all room keys — guards against orphan state */
const ROOM_TTL_SECS = 7_200

// ─── Key Helpers ─────────────────────────────────────────────────────────────
const timerKey   = (roomId: string) => `room:${roomId}:timer`
const playersKey = (roomId: string) => `room:${roomId}:players`
const potKey     = (roomId: string) => `room:${roomId}:pot`
const statusKey  = (roomId: string) => `room:${roomId}:status`
const drawnKey   = (roomId: string) => `room:${roomId}:drawn`

// ─── State Machine Phases (canonical Redis values) ───────────────────────────
export type RoomPhase =
    | 'WAITING'
    | 'LOCKING'
    | 'IN_PROGRESS'
    | 'PAYOUT'
    | 'REFUNDING'
    | 'COMPLETED'
    | 'CANCELLED'

// ─── Initialisation ──────────────────────────────────────────────────────────

/**
 * Bootstrap a new room in Redis when it enters the WAITING phase.
 * Safe to call multiple times — uses SET NX for the timer so it won't
 * reset a countdown already in progress.
 */
export async function initRoom(
    roomId: string,
    opts: { countdownSecs: number },
): Promise<void> {
    const pipe = redis.pipeline()
    // NX: only set if not already present (idempotent)
    pipe.set(timerKey(roomId), String(opts.countdownSecs), 'EX', ROOM_TTL_SECS, 'NX')
    pipe.set(statusKey(roomId), 'WAITING', 'EX', ROOM_TTL_SECS)
    pipe.expire(playersKey(roomId), ROOM_TTL_SECS)
    pipe.set(potKey(roomId), '0', 'EX', ROOM_TTL_SECS, 'NX')
    pipe.del(drawnKey(roomId))
    await pipe.exec()
}

// ─── Timer ───────────────────────────────────────────────────────────────────

/** Get the current timer value in seconds. Returns 0 if key is missing. */
export async function getTimer(roomId: string): Promise<number> {
    const val = await redis.get(timerKey(roomId))
    return val ? parseInt(val, 10) : 0
}

/**
 * Decrement the countdown by 1.
 * Returns the new value. When it hits 0, the engine should trigger validation.
 */
export async function decrementTimer(roomId: string): Promise<number> {
    return redis.decr(timerKey(roomId))
}

/** Explicitly set the timer (e.g. for reseed after admin reset). */
export async function setTimer(roomId: string, secs: number): Promise<void> {
    await redis.set(timerKey(roomId), String(secs), 'EX', ROOM_TTL_SECS)
}

// ─── Status ──────────────────────────────────────────────────────────────────

/** Get the current state-machine phase from Redis. */
export async function getRoomStatus(roomId: string): Promise<RoomPhase | null> {
    const val = await redis.get(statusKey(roomId))
    return val as RoomPhase | null
}

/** Transition the room to a new phase. */
export async function setRoomStatus(roomId: string, phase: RoomPhase): Promise<void> {
    await redis.set(statusKey(roomId), phase, 'EX', ROOM_TTL_SECS)
}

// ─── Players ─────────────────────────────────────────────────────────────────

/**
 * Add one or more players to the room player set.
 * Returns the new total player count.
 */
export async function addPlayers(roomId: string, ...userIds: string[]): Promise<number> {
    if (userIds.length === 0) return getRoomPlayerCount(roomId)
    await redis.sadd(playersKey(roomId), ...userIds)
    await redis.expire(playersKey(roomId), ROOM_TTL_SECS)
    return getRoomPlayerCount(roomId)
}

/** Get the count of unique players who have purchased tickets in this room. */
export async function getRoomPlayerCount(roomId: string): Promise<number> {
    return redis.scard(playersKey(roomId))
}

/** Remove a player from the room. Returns the new player count. */
export async function removePlayer(roomId: string, userId: string): Promise<number> {
    await redis.srem(playersKey(roomId), userId)
    return getRoomPlayerCount(roomId)
}

/** Get all player IDs in the room. */
export async function getRoomPlayers(roomId: string): Promise<string[]> {
    return redis.smembers(playersKey(roomId))
}

// ─── Pot ─────────────────────────────────────────────────────────────────────

/**
 * Increment the pot by the given ETB amount (in whole units; stored as integer
 * cents internally to avoid float drift — divided by 100 when read).
 *
 * We store as integer paisa (1 ETB = 100 paisa) to use Redis INCRBY atomically.
 */
export async function incrementPot(roomId: string, etbAmount: number): Promise<number> {
    const paisa = Math.round(etbAmount * 100)
    await redis.incrby(potKey(roomId), paisa)
    await redis.expire(potKey(roomId), ROOM_TTL_SECS)
    return getPot(roomId)
}

/** Get the current pot total in ETB. */
export async function getPot(roomId: string): Promise<number> {
    const raw = await redis.get(potKey(roomId))
    return raw ? parseInt(raw, 10) / 100 : 0
}

/** Decrement the pot by the given ETB amount. */
export async function decrementPot(roomId: string, etbAmount: number): Promise<number> {
    const paisa = Math.round(etbAmount * 100)
    await redis.decrby(potKey(roomId), paisa)
    return getPot(roomId)
}

// ─── Drawn Numbers ────────────────────────────────────────────────────────────

/** Push a drawn ball to the ordered list. Returns total drawn count. */
export async function pushDrawnNumber(roomId: string, ball: number): Promise<number> {
    const count = await redis.rpush(drawnKey(roomId), String(ball))
    await redis.expire(drawnKey(roomId), ROOM_TTL_SECS)
    return count
}

/** Get all drawn numbers for this room (in draw order). */
export async function getDrawnNumbers(roomId: string): Promise<number[]> {
    const raw = await redis.lrange(drawnKey(roomId), 0, -1)
    return raw.map(Number)
}

// ─── Full Cleanup ─────────────────────────────────────────────────────────────

/** Delete all room keys from Redis (call after state is persisted to Postgres). */
export async function clearRoomState(roomId: string): Promise<void> {
    await redis.del(
        timerKey(roomId),
        playersKey(roomId),
        potKey(roomId),
        statusKey(roomId),
        drawnKey(roomId),
    )
}

/** Export key builders so tests can inspect Redis directly. */
export const roomKeys = { timerKey, playersKey, potKey, statusKey, drawnKey }
