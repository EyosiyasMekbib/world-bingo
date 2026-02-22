import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import redis from '../lib/redis'
import {
    initGameState,
    addCalledBall,
    getCalledBalls,
    getGameState,
    updateGameState,
    addPlayer,
    getPlayers,
    getPlayerCount,
    clearGameState,
    keys,
} from '../lib/game-state'

const TEST_GAME_ID = 'test-game-state-' + Date.now()

describe('GameState (Redis)', () => {
    beforeEach(async () => {
        // Clean up any leftover keys from previous runs
        await redis.del(
            keys.stateKey(TEST_GAME_ID),
            keys.calledKey(TEST_GAME_ID),
            keys.playersKey(TEST_GAME_ID),
        )
    })

    afterAll(async () => {
        // Final cleanup
        await redis.del(
            keys.stateKey(TEST_GAME_ID),
            keys.calledKey(TEST_GAME_ID),
            keys.playersKey(TEST_GAME_ID),
        )
    })

    describe('initGameState', () => {
        it('should create state hash, player set, and empty called list', async () => {
            await initGameState(TEST_GAME_ID, {
                status: 'STARTING',
                pattern: 'ANY_LINE',
                ticketPrice: '50.00',
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: '10.00',
                playerIds: ['user-1', 'user-2'],
            })

            const state = await getGameState(TEST_GAME_ID)
            expect(state).not.toBeNull()
            expect(state!.status).toBe('STARTING')
            expect(state!.pattern).toBe('ANY_LINE')
            expect(state!.maxPlayers).toBe('10')

            const players = await getPlayers(TEST_GAME_ID)
            expect(players).toContain('user-1')
            expect(players).toContain('user-2')

            const called = await getCalledBalls(TEST_GAME_ID)
            expect(called).toEqual([])
        })
    })

    describe('addCalledBall / getCalledBalls', () => {
        it('should add balls in order and retrieve them', async () => {
            await initGameState(TEST_GAME_ID, {
                status: 'IN_PROGRESS',
                pattern: 'ANY_LINE',
                ticketPrice: '50.00',
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: '10.00',
                playerIds: [],
            })

            await addCalledBall(TEST_GAME_ID, 42)
            await addCalledBall(TEST_GAME_ID, 7)
            await addCalledBall(TEST_GAME_ID, 15)

            const balls = await getCalledBalls(TEST_GAME_ID)
            expect(balls).toEqual([42, 7, 15])
        })

        it('should return count after push', async () => {
            await initGameState(TEST_GAME_ID, {
                status: 'IN_PROGRESS',
                pattern: 'ANY_LINE',
                ticketPrice: '50.00',
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: '10.00',
                playerIds: [],
            })

            const count1 = await addCalledBall(TEST_GAME_ID, 1)
            const count2 = await addCalledBall(TEST_GAME_ID, 2)

            expect(count1).toBe(1)
            expect(count2).toBe(2)
        })
    })

    describe('getGameState / updateGameState', () => {
        it('should return null for non-existent game', async () => {
            const state = await getGameState('non-existent-id')
            expect(state).toBeNull()
        })

        it('should update specific fields without losing others', async () => {
            await initGameState(TEST_GAME_ID, {
                status: 'STARTING',
                pattern: 'FULL_CARD',
                ticketPrice: '100.00',
                maxPlayers: 20,
                minPlayers: 5,
                houseEdgePct: '15.00',
                playerIds: [],
            })

            await updateGameState(TEST_GAME_ID, { status: 'IN_PROGRESS' })

            const state = await getGameState(TEST_GAME_ID)
            expect(state!.status).toBe('IN_PROGRESS')
            expect(state!.pattern).toBe('FULL_CARD') // unchanged
            expect(state!.ticketPrice).toBe('100.00') // unchanged
        })

        it('should set winnerId', async () => {
            await initGameState(TEST_GAME_ID, {
                status: 'IN_PROGRESS',
                pattern: 'ANY_LINE',
                ticketPrice: '50.00',
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: '10.00',
                playerIds: [],
            })

            await updateGameState(TEST_GAME_ID, { winnerId: 'winner-user-id', status: 'COMPLETED' })

            const state = await getGameState(TEST_GAME_ID)
            expect(state!.winnerId).toBe('winner-user-id')
            expect(state!.status).toBe('COMPLETED')
        })
    })

    describe('players', () => {
        it('should add and count players', async () => {
            await initGameState(TEST_GAME_ID, {
                status: 'WAITING',
                pattern: 'ANY_LINE',
                ticketPrice: '50.00',
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: '10.00',
                playerIds: ['user-a'],
            })

            await addPlayer(TEST_GAME_ID, 'user-b')

            const count = await getPlayerCount(TEST_GAME_ID)
            expect(count).toBe(2)

            const players = await getPlayers(TEST_GAME_ID)
            expect(players).toContain('user-a')
            expect(players).toContain('user-b')
        })

        it('adding same player twice should not duplicate', async () => {
            await initGameState(TEST_GAME_ID, {
                status: 'WAITING',
                pattern: 'ANY_LINE',
                ticketPrice: '50.00',
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: '10.00',
                playerIds: [],
            })

            await addPlayer(TEST_GAME_ID, 'user-x')
            await addPlayer(TEST_GAME_ID, 'user-x')

            const count = await getPlayerCount(TEST_GAME_ID)
            expect(count).toBe(1)
        })
    })

    describe('clearGameState', () => {
        it('should remove all keys for a game', async () => {
            await initGameState(TEST_GAME_ID, {
                status: 'IN_PROGRESS',
                pattern: 'ANY_LINE',
                ticketPrice: '50.00',
                maxPlayers: 10,
                minPlayers: 2,
                houseEdgePct: '10.00',
                playerIds: ['user-1'],
            })
            await addCalledBall(TEST_GAME_ID, 42)

            await clearGameState(TEST_GAME_ID)

            const state = await getGameState(TEST_GAME_ID)
            expect(state).toBeNull()

            const balls = await getCalledBalls(TEST_GAME_ID)
            expect(balls).toEqual([])

            const players = await getPlayers(TEST_GAME_ID)
            expect(players).toEqual([])
        })
    })
})
