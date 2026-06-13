import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: { analyticsEvent: { createMany: vi.fn() } },
}))
import prisma from '../lib/prisma'
const createMany = prisma.analyticsEvent.createMany as unknown as ReturnType<typeof vi.fn>

import { EventService, ALLOWED_EVENTS } from '../services/event.service'

beforeEach(() => { vi.clearAllMocks() })

describe('EventService.record', () => {
    it('bulk-inserts allowed events', async () => {
        createMany.mockResolvedValueOnce({ count: 2 })
        await EventService.record(
            [
                { name: 'lobby_view', anonId: 'anon-1', sessionId: 'sess-1', props: null },
                { name: 'game_view', anonId: 'anon-1', sessionId: 'sess-1', props: { gameId: 'g1' } },
            ],
            { userId: undefined },
        )
        expect(createMany).toHaveBeenCalledWith({
            data: [
                { name: 'lobby_view', anonId: 'anon-1', sessionId: 'sess-1', props: null, userId: undefined },
                { name: 'game_view', anonId: 'anon-1', sessionId: 'sess-1', props: { gameId: 'g1' }, userId: undefined },
            ],
            skipDuplicates: true,
        })
    })

    it('drops events with unknown names silently', async () => {
        createMany.mockResolvedValueOnce({ count: 1 })
        await EventService.record(
            [
                { name: 'lobby_view', anonId: 'a', sessionId: 's', props: null },
                { name: 'EVIL_ARBITRARY_EVENT', anonId: 'a', sessionId: 's', props: null },
            ],
            { userId: undefined },
        )
        const data = createMany.mock.calls[0][0].data
        expect(data).toHaveLength(1)
        expect(data[0].name).toBe('lobby_view')
    })

    it('attaches userId from context, not from event body', async () => {
        createMany.mockResolvedValueOnce({ count: 1 })
        await EventService.record(
            [{ name: 'lobby_view', anonId: 'a', sessionId: 's', props: null }],
            { userId: 'user-123' },
        )
        expect(createMany.mock.calls[0][0].data[0].userId).toBe('user-123')
    })

    it('does nothing when all events are filtered out', async () => {
        await EventService.record(
            [{ name: 'BAD_EVENT', anonId: 'a', sessionId: 's', props: null }],
            { userId: undefined },
        )
        expect(createMany).not.toHaveBeenCalled()
    })
})

describe('ALLOWED_EVENTS', () => {
    it('contains the expected event names', () => {
        expect(ALLOWED_EVENTS).toContain('lobby_view')
        expect(ALLOWED_EVENTS).toContain('identify')
        expect(ALLOWED_EVENTS).toContain('deposit_submitted')
    })
})
