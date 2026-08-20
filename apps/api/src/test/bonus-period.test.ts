import { describe, it, expect } from 'vitest'
import { dayBucketStart, weekBucketStart } from '../lib/bonus-period'

describe('bonus-period', () => {
    describe('dayBucketStart', () => {
        it('a deposit at 02:59 UTC (05:59 local) buckets to the same local day as 00:01 UTC', () => {
            // 2026-08-20T00:01:00Z is 03:01 local on Aug 20 -> bucket start 2026-08-19T21:00:00Z (Aug 20 00:00 local)
            const early = dayBucketStart(new Date('2026-08-20T00:01:00Z'))
            expect(early.toISOString()).toBe('2026-08-19T21:00:00.000Z')
        })

        it('a deposit at 20:59:59 UTC (23:59:59 local) stays in the same local day', () => {
            const lateNight = dayBucketStart(new Date('2026-08-20T20:59:59Z'))
            expect(lateNight.toISOString()).toBe('2026-08-19T21:00:00.000Z')
        })

        it('a deposit at 21:00:00 UTC (00:00:00 local next day) rolls to the next bucket', () => {
            const midnight = dayBucketStart(new Date('2026-08-20T21:00:00Z'))
            expect(midnight.toISOString()).toBe('2026-08-20T21:00:00.000Z')
        })
    })

    describe('weekBucketStart', () => {
        it('a Monday-local deposit buckets to that Monday', () => {
            // 2026-08-24 is a Monday. 00:00 local Monday = 2026-08-23T21:00:00Z.
            const mondayMorning = weekBucketStart(new Date('2026-08-23T22:00:00Z')) // 01:00 local Monday
            expect(mondayMorning.toISOString()).toBe('2026-08-23T21:00:00.000Z')
        })

        it('a Sunday-local deposit buckets to the PRECEDING Monday', () => {
            // 2026-08-30 is a Sunday. 12:00 local Sunday = 2026-08-30T09:00:00Z.
            const sundayNoon = weekBucketStart(new Date('2026-08-30T09:00:00Z'))
            expect(sundayNoon.toISOString()).toBe('2026-08-23T21:00:00.000Z')
        })
    })
})
