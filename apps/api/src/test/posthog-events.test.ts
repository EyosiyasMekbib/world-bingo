import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
    transaction: { findUnique: vi.fn(), count: vi.fn() },
    game: { findUnique: vi.fn() },
    gameEntry: { groupBy: vi.fn() },
}))
vi.mock('../lib/prisma', () => ({ default: db }))
const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))
vi.mock('../lib/logger', () => ({ rootLogger: { info: vi.fn(), warn: vi.fn() } }))

import {
    hoursBetween,
    withdrawalMethodFromNote,
    personPropsFor,
    gameOutcomeEvents,
    emitDepositApproved,
    emitGameFinished,
    emitGameRefunded,
} from '../lib/posthog-events'

beforeEach(() => vi.clearAllMocks())

describe('hoursBetween', () => {
    it('rounds to two decimals', () => {
        const from = new Date('2026-09-01T00:00:00Z')
        const to = new Date('2026-09-01T02:20:00Z')
        expect(hoursBetween(from, to)).toBe(2.33)
    })
    it('never goes negative', () => {
        const from = new Date('2026-09-01T05:00:00Z')
        const to = new Date('2026-09-01T00:00:00Z')
        expect(hoursBetween(from, to)).toBe(0)
    })
})

describe('withdrawalMethodFromNote', () => {
    it('returns the method code and never the account', () => {
        expect(withdrawalMethodFromNote('telebirr: 0911223344')).toBe('telebirr')
    })
    it('lower-cases the code', () => {
        expect(withdrawalMethodFromNote('CBE: 1000123456')).toBe('cbe')
    })
    it('returns null for a reviewer note or empty input', () => {
        expect(withdrawalMethodFromNote('Wrong account number')).toBeNull()
        expect(withdrawalMethodFromNote(null)).toBeNull()
        expect(withdrawalMethodFromNote(undefined)).toBeNull()
    })
})

describe('personPropsFor', () => {
    it('emits only the allowed person properties', () => {
        const props = personPropsFor(
            { serial: 42, createdAt: new Date('2026-05-01T10:00:00Z'), referredById: 'ref-1' },
            'phone',
        )
        expect(props).toEqual({
            serial: 42,
            signup_method: 'phone',
            referred: true,
            created_at: '2026-05-01T10:00:00.000Z',
        })
    })
})

describe('gameOutcomeEvents', () => {
    const base = {
        gameId: 'g1',
        templateId: 't1',
        ticketPrice: 50,
        durationSecs: 120,
        entrants: [
            { userId: 'winner', cartelas: 2 },
            { userId: 'loser', cartelas: 1 },
        ],
    }

    it('fans out one event per entrant with won / lost outcomes', () => {
        const events = gameOutcomeEvents({ ...base, winnerId: 'winner', prize: 135 })
        expect(events).toHaveLength(2)
        expect(events[0]).toEqual({
            userId: 'winner',
            properties: {
                game_id: 'g1',
                template_id: 't1',
                ticket_price: 50,
                cartelas: 2,
                stake: 100,
                outcome: 'won',
                prize: 135,
                net: 35,
                duration_secs: 120,
            },
        })
        expect(events[1].properties).toMatchObject({ outcome: 'lost', stake: 50, prize: 0, net: -50 })
    })

    it('marks every entrant no_winner when there is no winner', () => {
        const events = gameOutcomeEvents({ ...base, winnerId: null, prize: 0 })
        expect(events.map((e) => e.properties.outcome)).toEqual(['no_winner', 'no_winner'])
        expect(events[0].properties.net).toBe(-100)
    })
})

describe('emitDepositApproved', () => {
    it('captures amount, method, gateway, hours and first-deposit flag', async () => {
        db.transaction.findUnique.mockResolvedValue({
            id: 'tx1',
            userId: 'u1',
            amount: '500.00',
            note: 'telebirr',
            gateway: null,
            createdAt: new Date('2026-09-01T00:00:00Z'),
        })
        db.transaction.count.mockResolvedValue(0)
        await emitDepositApproved('tx1', new Date('2026-09-01T01:30:00Z'))
        expect(captureEvent).toHaveBeenCalledWith('u1', 'deposit_approved', {
            amount: 500,
            method: 'telebirr',
            gateway: 'manual',
            hours_to_approve: 1.5,
            is_first_deposit: true,
            tx_id: 'tx1',
        })
    })

    it('reports zarecash as the gateway and false for a repeat depositor', async () => {
        db.transaction.findUnique.mockResolvedValue({
            id: 'tx2',
            userId: 'u1',
            amount: '200',
            note: 'cbe',
            gateway: 'zarecash',
            createdAt: new Date('2026-09-01T00:00:00Z'),
        })
        db.transaction.count.mockResolvedValue(3)
        await emitDepositApproved('tx2', new Date('2026-09-01T00:00:00Z'))
        expect(captureEvent.mock.calls[0][2]).toMatchObject({ gateway: 'zarecash', is_first_deposit: false })
    })

    it('is silent when the row is missing or the read throws', async () => {
        db.transaction.findUnique.mockResolvedValue(null)
        await emitDepositApproved('nope')
        db.transaction.findUnique.mockRejectedValue(new Error('db'))
        await expect(emitDepositApproved('boom')).resolves.toBeUndefined()
        expect(captureEvent).not.toHaveBeenCalled()
    })
})

describe('emitGameFinished', () => {
    it('reads the game and entries and emits game_finished per player', async () => {
        db.game.findUnique.mockResolvedValue({
            id: 'g1',
            templateId: 't1',
            ticketPrice: '50',
            houseEdgePct: '10',
            winnerId: 'w',
            startedAt: new Date('2026-09-01T00:00:00Z'),
            endedAt: new Date('2026-09-01T00:03:00Z'),
        })
        db.gameEntry.groupBy.mockResolvedValue([
            { userId: 'w', _count: { _all: 1 } },
            { userId: 'l', _count: { _all: 2 } },
        ])
        await emitGameFinished('g1')
        expect(captureEvent).toHaveBeenCalledTimes(2)
        // pot = 50 * 3 = 150, prize = 150 * 0.9 = 135
        expect(captureEvent).toHaveBeenCalledWith('w', 'game_finished', expect.objectContaining({
            outcome: 'won', prize: 135, net: 85, duration_secs: 180,
        }))
        expect(captureEvent).toHaveBeenCalledWith('l', 'game_finished', expect.objectContaining({
            outcome: 'lost', stake: 100, net: -100,
        }))
    })

    it('is silent when the game is missing', async () => {
        db.game.findUnique.mockResolvedValue(null)
        await emitGameFinished('missing')
        expect(captureEvent).not.toHaveBeenCalled()
    })
})

describe('emitGameRefunded', () => {
    it('emits only for players actually refunded now', () => {
        emitGameRefunded('g1', 't1', [
            { userId: 'a', amount: 50, alreadyRefunded: false },
            { userId: 'b', amount: 50, alreadyRefunded: true },
        ], 'under_filled')
        expect(captureEvent).toHaveBeenCalledTimes(1)
        expect(captureEvent).toHaveBeenCalledWith('a', 'game_refunded', {
            game_id: 'g1', template_id: 't1', reason: 'under_filled', refund: 50,
        })
    })
})
