import { describe, it, expect } from 'vitest'
import {
    deterministicUuid,
    userEvents,
    depositEvents,
    withdrawalEvents,
    bonusEvent,
    gameJoinedEvents,
    gameFinishedEvents,
    gameRefundedEvents,
    analyticsEventRow,
} from '../lib/posthog-backfill'

const T0 = new Date('2026-04-01T10:00:00Z')

describe('deterministicUuid', () => {
    it('is stable for the same name and a valid v5 uuid', () => {
        const a = deterministicUuid('tx:1:deposit_submitted')
        expect(a).toBe(deterministicUuid('tx:1:deposit_submitted'))
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })
    it('differs per event name', () => {
        expect(deterministicUuid('tx:1:deposit_submitted')).not.toBe(deterministicUuid('tx:1:deposit_approved'))
    })
})

describe('userEvents', () => {
    it('emits user_registered with person props', () => {
        const [ev] = userEvents({ id: 'u1', serial: 5, telegramId: null, referredById: 'r', createdAt: T0 })
        expect(ev.event).toBe('user_registered')
        expect(ev.distinctId).toBe('u1')
        expect(ev.timestamp).toBe(T0)
        expect(ev.properties).toEqual({
            signup_method: 'phone',
            referred: true,
            backfilled: true,
            $set: { serial: 5, signup_method: 'phone', referred: true, created_at: T0.toISOString() },
        })
        expect(ev.uuid).toBe(deterministicUuid('user:u1:user_registered'))
    })
    it('marks telegram users', () => {
        const [ev] = userEvents({ id: 'u2', serial: 6, telegramId: '77', referredById: null, createdAt: T0 })
        expect(ev.properties.signup_method).toBe('telegram')
    })
})

describe('depositEvents', () => {
    const known = new Set(['telebirr', 'cbe'])
    const row = { id: 't1', userId: 'u1', type: 'DEPOSIT', amount: '500.00', status: 'APPROVED', note: 'telebirr', gateway: null, referenceId: null, createdAt: T0 }

    it('emits submitted then approved one second later with null timing', () => {
        const evs = depositEvents(row, known)
        expect(evs.map((e) => e.event)).toEqual(['deposit_submitted', 'deposit_approved'])
        expect(evs[0].properties).toEqual({ amount: 500, method: 'telebirr', gateway: 'manual', tx_id: 't1', backfilled: true })
        expect(evs[1].timestamp.getTime()).toBe(T0.getTime() + 1000)
        expect(evs[1].properties).toMatchObject({ hours_to_approve: null, is_first_deposit: null, backfilled: true })
    })
    it('emits rejected for REJECTED rows and drops an unknown note as the method', () => {
        const evs = depositEvents({ ...row, status: 'REJECTED', note: 'blurry receipt' }, known)
        expect(evs.map((e) => e.event)).toEqual(['deposit_submitted', 'deposit_rejected'])
        expect(evs[0].properties.method).toBeNull()
    })
    it('emits only submitted for a pending row', () => {
        expect(depositEvents({ ...row, status: 'PENDING_REVIEW' }, known).map((e) => e.event)).toEqual(['deposit_submitted'])
    })
    it('reports zarecash gateway', () => {
        expect(depositEvents({ ...row, gateway: 'zarecash' }, known)[0].properties.gateway).toBe('zarecash')
    })
})

describe('withdrawalEvents', () => {
    const row = { id: 'w1', userId: 'u1', type: 'WITHDRAWAL', amount: '200', status: 'APPROVED', note: 'cbe: 1000123456', gateway: null, referenceId: null, createdAt: T0 }
    it('emits requested then approved, method only', () => {
        const evs = withdrawalEvents(row)
        expect(evs.map((e) => e.event)).toEqual(['withdrawal_requested', 'withdrawal_approved'])
        expect(evs[0].properties).toEqual({ amount: 200, method: 'cbe', gateway: 'manual', tx_id: 'w1', backfilled: true })
        expect(JSON.stringify(evs)).not.toContain('1000123456')
    })
    it('emits rejected for REJECTED rows', () => {
        expect(withdrawalEvents({ ...row, status: 'REJECTED' }).map((e) => e.event)).toEqual(['withdrawal_requested', 'withdrawal_rejected'])
    })
})

describe('bonusEvent', () => {
    it('maps bonus transaction types to sources', () => {
        const ev = bonusEvent({ id: 'b1', userId: 'u1', type: 'CASHBACK_BONUS', amount: '25', status: 'APPROVED', note: null, gateway: null, referenceId: 'promo-1', createdAt: T0 })
        expect(ev?.event).toBe('bonus_granted')
        expect(ev?.properties).toEqual({ amount: 25, source: 'CASHBACK', rule_id: 'promo-1', backfilled: true })
    })
    it('ignores non-bonus and non-positive rows', () => {
        expect(bonusEvent({ id: 'x', userId: 'u1', type: 'DEPOSIT', amount: '5', status: 'APPROVED', note: null, gateway: null, referenceId: null, createdAt: T0 })).toBeNull()
        expect(bonusEvent({ id: 'y', userId: 'u1', type: 'ADMIN_BONUS_ADJUSTMENT', amount: '-5', status: 'APPROVED', note: null, gateway: null, referenceId: null, createdAt: T0 })).toBeNull()
    })
})

const game = { id: 'g1', templateId: 't1', ticketPrice: '50', houseEdgePct: '10', status: 'COMPLETED', winnerId: 'w', createdAt: T0, startedAt: T0, endedAt: new Date(T0.getTime() + 90_000) }
const entrants = [
    { userId: 'w', cartelas: 1, firstJoinedAt: T0 },
    { userId: 'l', cartelas: 2, firstJoinedAt: new Date(T0.getTime() + 5000) },
]

describe('gameJoinedEvents', () => {
    it('emits one game_joined per player at their first join', () => {
        const evs = gameJoinedEvents(game, entrants)
        expect(evs).toHaveLength(2)
        expect(evs[1]).toMatchObject({
            distinctId: 'l',
            event: 'game_joined',
            timestamp: entrants[1].firstJoinedAt,
            properties: { game_id: 'g1', template_id: 't1', ticket_price: 50, cartelas: 2, stake: 100, spend_account: null, backfilled: true },
        })
        expect(evs[1].uuid).toBe(deterministicUuid('game:g1:l:game_joined'))
    })
})

describe('gameFinishedEvents', () => {
    it('uses the pot formula and endedAt', () => {
        const evs = gameFinishedEvents(game, entrants)
        expect(evs[0].properties).toMatchObject({ outcome: 'won', prize: 135, net: 85, duration_secs: 90 })
        expect(evs[0].timestamp).toBe(game.endedAt)
    })
    it('returns nothing when endedAt is missing', () => {
        expect(gameFinishedEvents({ ...game, endedAt: null }, entrants)).toEqual([])
    })
})

describe('gameRefundedEvents', () => {
    it('emits per refunded player', () => {
        const evs = gameRefundedEvents({ ...game, status: 'CANCELLED', winnerId: null }, [{ userId: 'w', amount: 50 }])
        expect(evs[0]).toMatchObject({ event: 'game_refunded', properties: { game_id: 'g1', template_id: 't1', reason: 'backfill', refund: 50, backfilled: true } })
    })
})

describe('analyticsEventRow', () => {
    it('maps a frontend event with userId as the distinct id', () => {
        const ev = analyticsEventRow({ id: 'e1', name: 'join_click', userId: 'u1', anonId: 'a1', createdAt: T0, props: { gameId: 'g1' } })
        expect(ev).toMatchObject({ distinctId: 'u1', event: 'join_click', properties: { gameId: 'g1', backfilled: true } })
    })
    it('uses anonId when there is no user', () => {
        expect(analyticsEventRow({ id: 'e2', name: 'lobby_view', userId: null, anonId: 'a1', createdAt: T0, props: null })).toMatchObject({ distinctId: 'a1' })
    })
    it('drops deposit_submitted, which the transactions mapper already emits', () => {
        // wallet.controller.ts records one of these per manual deposit AND
        // depositEvents() derives one from `transactions`, under a different
        // uuid namespace — so PostHog would keep both.
        expect(
            analyticsEventRow({
                id: 'e6',
                name: 'deposit_submitted',
                userId: 'u1',
                anonId: null,
                createdAt: T0,
                props: { amount: 500, paymentMethod: 'cbe', txId: 't1' },
            }),
        ).toBeNull()
    })

    it('renames provider_game_launched props to the snake_case the live hook sends', () => {
        const ev = analyticsEventRow({
            id: 'e7',
            name: 'provider_game_launched',
            userId: 'u1',
            anonId: null,
            createdAt: T0,
            props: { providerCode: 'smartsoft', gameCode: 'JetX', balanceBefore: 240 },
        })
        expect(ev).toMatchObject({
            distinctId: 'u1',
            event: 'provider_game_launched',
            properties: {
                provider_code: 'smartsoft',
                game_code: 'JetX',
                balance_before: 240,
                backfilled: true,
            },
        })
        const props = (ev as { properties: Record<string, unknown> }).properties
        expect(Object.keys(props)).not.toContain('providerCode')
        expect(Object.keys(props)).not.toContain('gameCode')
        expect(Object.keys(props)).not.toContain('balanceBefore')
    })

    it('leaves props alone for events with no rename map', () => {
        const ev = analyticsEventRow({ id: 'e8', name: 'game_view', userId: 'u1', anonId: null, createdAt: T0, props: { gameId: 'g1' } })
        expect((ev as { properties: Record<string, unknown> }).properties).toMatchObject({ gameId: 'g1' })
    })

    it('turns identify rows into aliases and drops unusable rows', () => {
        expect(analyticsEventRow({ id: 'e3', name: 'identify', userId: 'u1', anonId: 'a1', createdAt: T0, props: null })).toEqual({ distinctId: 'u1', alias: 'a1' })
        expect(analyticsEventRow({ id: 'e4', name: 'identify', userId: null, anonId: 'a1', createdAt: T0, props: null })).toBeNull()
        expect(analyticsEventRow({ id: 'e5', name: 'lobby_view', userId: null, anonId: null, createdAt: T0, props: null })).toBeNull()
    })
})
