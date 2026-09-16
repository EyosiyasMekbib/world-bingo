import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { AdminService, userSearchOr } from '../services/admin.service'

/**
 * Finding a player by the number they read out over the phone.
 *
 * Since SMS sign-in, new accounts store E.164 (`+251911234567`) — but a player
 * on a support call says "zero nine one one…". A `contains` match never bridges
 * those two spellings, so without the exact-match arm a clerk searching the
 * number a player just gave them finds nothing.
 */
describe('userSearchOr', () => {
    it('matches the spellings a number could be stored under', () => {
        const or = userSearchOr('0911234567')
        const exact = or.find((clause) => 'phone' in clause && 'in' in (clause.phone as object))

        expect(exact).toBeTruthy()
        expect((exact as { phone: { in: string[] } }).phone.in).toEqual(
            expect.arrayContaining(['+251911234567', '251911234567', '0911234567', '911234567']),
        )
    })

    // A username search must not grow a phone clause that matches the raw
    // string — `phoneVariants` returns just the input for anything it cannot
    // place, and an exact `phone` match on a username is noise.
    it('adds no exact phone clause for a search that is not a number', () => {
        const or = userSearchOr('john_doe')

        expect(or.some((clause) => 'phone' in clause && 'in' in (clause.phone as object))).toBe(false)
    })
})

describe('AdminService.getUsers — search', () => {
    it.each([
        ['local, trunk-prefixed', '0911234567'],
        ['bare national', '911234567'],
        ['E.164', '+251911234567'],
        ['international, no plus', '251911234567'],
    ])('finds an account stored as E.164 when a clerk types %s', async (_label, typed) => {
        const user = await prisma.user.create({
            data: { phone: '+251911234567', firebaseUid: 'uid-search', wallet: { create: {} } },
        })

        const { data } = await AdminService.getUsers({ search: typed })

        expect(data.map((u: { id: string }) => u.id)).toContain(user.id)
    })

    it('still finds an account stored the old way', async () => {
        const user = await prisma.user.create({
            data: { username: 'legacy', phone: '0911234567', wallet: { create: {} } },
        })

        const { data } = await AdminService.getUsers({ search: '+251911234567' })

        expect(data.map((u: { id: string }) => u.id)).toContain(user.id)
    })

    it('does not return a different number', async () => {
        const user = await prisma.user.create({
            data: { phone: '+251911234568', firebaseUid: 'uid-other', wallet: { create: {} } },
        })

        const { data } = await AdminService.getUsers({ search: '0911234567' })

        expect(data.map((u: { id: string }) => u.id)).not.toContain(user.id)
    })

    it('still searches usernames', async () => {
        const user = await prisma.user.create({
            data: { username: 'JohnDoe', wallet: { create: {} } },
        })

        const { data } = await AdminService.getUsers({ search: 'johnd' })

        expect(data.map((u: { id: string }) => u.id)).toContain(user.id)
    })
})
