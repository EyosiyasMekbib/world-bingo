import { describe, it, expect, vi, beforeEach } from 'vitest'

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }))
vi.mock('../lib/prisma', () => ({ default: { user: { findUnique } } }))
vi.mock('../lib/logger', () => ({ rootLogger: { info: vi.fn(), warn: vi.fn() } }))

import {
    captureEvent,
    initPostHog,
    isExcludedUser,
    isPostHogEnabled,
    _setClientForTests,
} from '../lib/posthog'

const player = { username: 'alice', passwordHash: 'hashed', role: 'PLAYER' }

describe('isExcludedUser', () => {
    it('keeps a plain player', () => {
        expect(isExcludedUser(player)).toBe(false)
    })
    it('drops bot_t usernames', () => {
        expect(isExcludedUser({ ...player, username: 'bot_t1_3' })).toBe(true)
    })
    it('drops BOT_ACCOUNT password hashes', () => {
        expect(isExcludedUser({ ...player, passwordHash: 'BOT_ACCOUNT' })).toBe(true)
    })
    it('drops staff roles', () => {
        expect(isExcludedUser({ ...player, role: 'ADMIN' })).toBe(true)
    })
    it('drops a missing row', () => {
        expect(isExcludedUser(null)).toBe(true)
    })
})

describe('captureEvent', () => {
    const capture = vi.fn()
    const shutdown = vi.fn().mockResolvedValue(undefined)

    beforeEach(() => {
        vi.clearAllMocks()
        findUnique.mockResolvedValue(player)
    })

    it('is a no-op when no client is installed', async () => {
        _setClientForTests(null)
        await captureEvent('u1', 'game_joined', { game_id: 'g1' })
        expect(findUnique).not.toHaveBeenCalled()
        expect(capture).not.toHaveBeenCalled()
    })

    it('forwards to the client with brand and $set person props', async () => {
        _setClientForTests({ capture, shutdown }, 'arada')
        await captureEvent('u1', 'user_registered', { signup_method: 'phone' }, { set: { serial: 7 } })
        expect(capture).toHaveBeenCalledWith({
            distinctId: 'u1',
            event: 'user_registered',
            properties: {
                signup_method: 'phone',
                brand: 'arada',
                $set: { serial: 7, brand: 'arada' },
            },
        })
    })

    it('passes a historical timestamp through', async () => {
        _setClientForTests({ capture, shutdown }, 'arada')
        const ts = new Date('2026-03-01T00:00:00Z')
        await captureEvent('u1', 'game_joined', {}, { timestamp: ts })
        expect(capture.mock.calls[0][0].timestamp).toBe(ts)
    })

    it('drops bots and caches the lookup', async () => {
        _setClientForTests({ capture, shutdown })
        findUnique.mockResolvedValue({ ...player, username: 'bot_t2_1' })
        await captureEvent('bot1', 'game_joined')
        await captureEvent('bot1', 'game_joined')
        expect(capture).not.toHaveBeenCalled()
        expect(findUnique).toHaveBeenCalledTimes(1)
    })

    it('never rejects when the client throws', async () => {
        _setClientForTests({
            capture: () => {
                throw new Error('boom')
            },
            shutdown,
        })
        await expect(captureEvent('u1', 'game_joined')).resolves.toBeUndefined()
    })

    it('never rejects when the user lookup throws', async () => {
        _setClientForTests({ capture, shutdown })
        findUnique.mockRejectedValue(new Error('db down'))
        await expect(captureEvent('u1', 'game_joined')).resolves.toBeUndefined()
        expect(capture).not.toHaveBeenCalled()
    })
})

describe('initPostHog', () => {
    it('stays disabled without POSTHOG_KEY', () => {
        _setClientForTests(null)
        const saved = process.env.POSTHOG_KEY
        delete process.env.POSTHOG_KEY
        initPostHog()
        expect(isPostHogEnabled()).toBe(false)
        if (saved !== undefined) process.env.POSTHOG_KEY = saved
    })
})
