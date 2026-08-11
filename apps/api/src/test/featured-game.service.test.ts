import { describe, expect, it, vi } from 'vitest'

// Pure normalization tests — stub the IO modules so importing the service does
// not open a database or Redis connection.
vi.mock('../lib/prisma', () => ({ default: {} }))
vi.mock('../lib/redis', () => ({ default: { keys: vi.fn(), del: vi.fn() } }))

const { toNameKey, PROVIDER_GAME_ORDER_BY } = await import('../services/featured-game.service')

describe('toNameKey', () => {
    it('strips case, spaces and punctuation the way the SQL projection does', () => {
        expect(toNameKey('Aviator')).toBe('aviator')
        expect(toNameKey('Chicken Road 2')).toBe('chickenroad2')
        expect(toNameKey("Chick'n Road")).toBe('chicknroad')
        expect(toNameKey('The Incredible Balloon Machine')).toBe('theincredibleballoonmachine')
        expect(toNameKey('FlyX Cash & Turbo')).toBe('flyxcashturbo')
        expect(toNameKey('BG25 Plinko')).toBe('bg25plinko')
    })

    it('is total — empty and nullish input yield an empty key rather than throwing', () => {
        expect(toNameKey('')).toBe('')
        expect(toNameKey('   ')).toBe('')
        expect(toNameKey(undefined as unknown as string)).toBe('')
    })
})

describe('PROVIDER_GAME_ORDER_BY', () => {
    it('sorts curated rank first with unpinned games last, then sortOrder, then name', () => {
        expect(PROVIDER_GAME_ORDER_BY).toEqual([
            { featuredRank: { sort: 'asc', nulls: 'last' } },
            { sortOrder: 'asc' },
            { gameName: 'asc' },
        ])
    })
})
