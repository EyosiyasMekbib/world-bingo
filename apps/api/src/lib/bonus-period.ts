/**
 * Bonus periods run on Africa/Addis_Ababa, which is a fixed UTC+3 offset —
 * Ethiopia observes no DST, so there is no ambiguous or skipped local time to
 * handle. Hardcoded rather than read from SiteSetting; see the design spec §6.
 *
 * Every bonus window in the system is cut here: deposit-rule buckets, and — since
 * cashback moved off UTC — cashback's daily, weekly and monthly periods via
 * `getCurrentPeriod`. One module so one wallet cannot hold two ideas of "this
 * week", which is what it did while the two were cut on different clocks.
 */
const ADDIS_OFFSET_MS = 3 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Start of the local day containing `at`, expressed as a UTC instant. */
export function dayBucketStart(at: Date): Date {
    const local = new Date(at.getTime() + ADDIS_OFFSET_MS)
    const localMidnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
    return new Date(localMidnightAsUtc - ADDIS_OFFSET_MS)
}

/** Start of the local Mon-Sun week containing `at`, expressed as a UTC instant. */
export function weekBucketStart(at: Date): Date {
    const dayStart = dayBucketStart(at)
    const localDayStart = new Date(dayStart.getTime() + ADDIS_OFFSET_MS)
    const dow = localDayStart.getUTCDay() // 0 = Sunday .. 6 = Saturday
    const daysSinceMonday = (dow + 6) % 7
    return new Date(dayStart.getTime() - daysSinceMonday * DAY_MS)
}

/** Start of the local calendar month containing `at`, expressed as a UTC instant. */
export function monthBucketStart(at: Date): Date {
    const local = new Date(at.getTime() + ADDIS_OFFSET_MS)
    const localFirstAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1)
    return new Date(localFirstAsUtc - ADDIS_OFFSET_MS)
}

/**
 * Last instant of the local calendar month containing `at`. Derived from the
 * NEXT month's first day rather than by adding a month length, so February and
 * December need no special case — Date.UTC rolls month 12 into January.
 */
export function monthBucketEnd(at: Date): Date {
    const local = new Date(at.getTime() + ADDIS_OFFSET_MS)
    const nextFirstAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1)
    return new Date(nextFirstAsUtc - ADDIS_OFFSET_MS - 1)
}

/**
 * The fixed offset itself, for the one job the bucket helpers cannot do:
 * rendering a stored instant in the clock a player reads it on. Exported rather
 * than duplicated, because a second copy of "+3" is how the two halves of this
 * drift apart.
 */
export const ADDIS_OFFSET = ADDIS_OFFSET_MS
