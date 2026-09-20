import { describe, it, expect } from 'vitest'
import { dayBucketStart, weekBucketStart, monthBucketStart, monthBucketEnd } from '../lib/bonus-period'
import { getCurrentPeriod, getPreviousPeriod } from '../services/cashback.service'
import { CashbackFrequency } from '@world-bingo/shared-types'

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

    describe('monthBucketStart / monthBucketEnd', () => {
        it('starts the month at local midnight on the 1st, which is 21:00Z the day before', () => {
            expect(monthBucketStart(new Date('2026-09-15T12:00:00Z')).toISOString()).toBe('2026-08-31T21:00:00.000Z')
        })

        it('keeps the last three UTC hours of the month in that month', () => {
            // 2026-09-30T21:30Z is 00:30 local on 1 October — already next month.
            expect(monthBucketStart(new Date('2026-09-30T20:59:59Z')).toISOString()).toBe('2026-08-31T21:00:00.000Z')
            expect(monthBucketStart(new Date('2026-09-30T21:00:00Z')).toISOString()).toBe('2026-09-30T21:00:00.000Z')
        })

        it('ends the month one millisecond before the next one starts', () => {
            const end = monthBucketEnd(new Date('2026-09-15T12:00:00Z'))
            expect(end.toISOString()).toBe('2026-09-30T20:59:59.999Z')
            expect(end.getTime() + 1).toBe(monthBucketStart(new Date('2026-10-15T12:00:00Z')).getTime())
        })

        it('needs no special case for December or February', () => {
            expect(monthBucketEnd(new Date('2026-12-10T12:00:00Z')).toISOString()).toBe('2026-12-31T20:59:59.999Z')
            // 2028 is a leap year, so local February has 29 days.
            expect(monthBucketEnd(new Date('2028-02-10T12:00:00Z')).toISOString()).toBe('2028-02-29T20:59:59.999Z')
            expect(monthBucketEnd(new Date('2026-02-10T12:00:00Z')).toISOString()).toBe('2026-02-28T20:59:59.999Z')
        })
    })
})

/**
 * Cashback windows are cut by the same buckets as deposit bonuses. They used to
 * be cut on UTC midnight, which put the last three hours of every local day into
 * the next window and settled a Mon-Sun promotion at 02:59 on Monday local — and
 * meant one wallet could hold two different ideas of "this week".
 */
describe('getCurrentPeriod — cut on Addis, returned as UTC instants', () => {
    /** Renders an instant on the clock a player reads it on. */
    function addis(d: Date): string {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Africa/Addis_Ababa',
            dateStyle: 'short',
            timeStyle: 'medium',
            hour12: false,
        }).format(d)
    }

    it('opens and closes the daily window at local midnight', () => {
        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY, new Date('2026-09-20T18:00:00Z'))
        expect(periodStart.toISOString()).toBe('2026-09-19T21:00:00.000Z')
        expect(periodEnd.toISOString()).toBe('2026-09-20T20:59:59.999Z')
        expect(addis(periodStart)).toBe('20/09/2026, 00:00:00')
        expect(addis(periodEnd)).toBe('20/09/2026, 23:59:59')
    })

    it('rolls the day at 21:00Z, not at 00:00Z', () => {
        // 20:59:59Z is 23:59:59 local — still the 20th.
        expect(getCurrentPeriod(CashbackFrequency.DAILY, new Date('2026-09-20T20:59:59Z')).periodStart.toISOString())
            .toBe('2026-09-19T21:00:00.000Z')
        // 21:00Z is 00:00 local on the 21st.
        expect(getCurrentPeriod(CashbackFrequency.DAILY, new Date('2026-09-20T21:00:00Z')).periodStart.toISOString())
            .toBe('2026-09-20T21:00:00.000Z')
    })

    it('runs the weekly window local Monday to local Sunday', () => {
        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.WEEKLY, new Date('2026-09-20T18:00:00Z'))
        expect(addis(periodStart)).toBe('14/09/2026, 00:00:00')
        expect(addis(periodEnd)).toBe('20/09/2026, 23:59:59')
        // Exactly seven local days, which holds because Addis has no DST.
        expect(periodEnd.getTime() - periodStart.getTime()).toBe(7 * 24 * 60 * 60 * 1000 - 1)
    })

    it('rolls the week with the local day, so a late Sunday night is already next week', () => {
        // 2026-09-20 is a Sunday; 21:30Z is 00:30 local on Monday the 21st.
        const { periodStart } = getCurrentPeriod(CashbackFrequency.WEEKLY, new Date('2026-09-20T21:30:00Z'))
        expect(addis(periodStart)).toBe('21/09/2026, 00:00:00')
    })

    it('runs the monthly window local 1st to local last day', () => {
        const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.MONTHLY, new Date('2026-09-20T18:00:00Z'))
        expect(addis(periodStart)).toBe('01/09/2026, 00:00:00')
        expect(addis(periodEnd)).toBe('30/09/2026, 23:59:59')
    })

    it('leaves no gap or overlap between consecutive windows', () => {
        // A settled window ending one millisecond before the next opens is what
        // lets play be attributed to exactly one period.
        for (const frequency of [CashbackFrequency.DAILY, CashbackFrequency.WEEKLY, CashbackFrequency.MONTHLY]) {
            const now = new Date('2026-09-20T18:00:00Z')
            const current = getCurrentPeriod(frequency, now)
            const previous = getPreviousPeriod(frequency, now)
            expect(previous.periodEnd.getTime() + 1, `${frequency} leaves a gap`).toBe(current.periodStart.getTime())
            expect(previous.periodStart.getTime()).toBeLessThan(previous.periodEnd.getTime())
        }
    })

    it('gives the previous window on the same local boundaries', () => {
        const { periodStart, periodEnd } = getPreviousPeriod(CashbackFrequency.WEEKLY, new Date('2026-09-20T18:00:00Z'))
        expect(addis(periodStart)).toBe('07/09/2026, 00:00:00')
        expect(addis(periodEnd)).toBe('13/09/2026, 23:59:59')
    })
})
