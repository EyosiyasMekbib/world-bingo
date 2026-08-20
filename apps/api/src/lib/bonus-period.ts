/**
 * Bonus periods run on Africa/Addis_Ababa, which is a fixed UTC+3 offset —
 * Ethiopia observes no DST, so there is no ambiguous or skipped local time to
 * handle. Hardcoded rather than read from SiteSetting; see the design spec §6.
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
