/**
 * Pure, side-effect-free helpers for scripts/freeze-player.ts. Split out of
 * that script (which lives outside src/, so tsc's rootDir refuses to type
 * check anything that imports it) specifically so this logic can be unit
 * tested under src/test/ like everything else in the app.
 */

export type FreezeAction = 'freeze' | 'unfreeze'

export interface ParsedArgs {
    action: FreezeAction
    identifier: string
    reason: string
}

export const FREEZE_PLAYER_USAGE =
    'Usage: tsx scripts/freeze-player.ts <freeze|unfreeze> <userId|username|phone> <reason...>'

/**
 * Pure argument parsing — no I/O, no imports of prisma/ZareCash.
 */
export function parseArgs(argv: string[]): ParsedArgs {
    const [action, identifier, ...reasonParts] = argv

    if (action !== 'freeze' && action !== 'unfreeze') {
        throw new Error(
            `${FREEZE_PLAYER_USAGE}\nExpected action to be "freeze" or "unfreeze", got: ${action ? JSON.stringify(action) : '(none)'}`,
        )
    }
    if (!identifier) {
        throw new Error(`${FREEZE_PLAYER_USAGE}\nMissing user identifier (id, username, or phone).`)
    }
    const reason = reasonParts.join(' ').trim()
    if (!reason) {
        throw new Error(
            `${FREEZE_PLAYER_USAGE}\nMissing reason. A containment action with no recorded reason is how audit trails rot — pass one.`,
        )
    }

    return { action, identifier, reason }
}

export interface UserLookupRow {
    id: string
    username: string | null
    phone: string | null
    serial: number
    isActive: boolean
}

/** The minimal slice of PrismaClient this needs — narrow on purpose so tests can pass a fake instead of a real client. */
export interface UserLookupClient {
    user: {
        findFirst(args: unknown): Promise<UserLookupRow | null>
    }
}

/**
 * Resolve a user by id, username, or phone — whichever the identifier matches.
 * All three are unique columns, so one OR-lookup covers all of them. Returns
 * null (never throws) when nothing matches, so the caller can report a clean
 * "not found" instead of letting a Prisma error escape raw.
 */
export async function resolveUser(
    client: UserLookupClient,
    identifier: string,
): Promise<UserLookupRow | null> {
    return client.user.findFirst({
        where: { OR: [{ id: identifier }, { username: identifier }, { phone: identifier }] },
        select: { id: true, username: true, phone: true, serial: true, isActive: true },
    })
}
