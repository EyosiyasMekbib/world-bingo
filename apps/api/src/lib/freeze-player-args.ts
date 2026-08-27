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
    accountStatus: string
}

/** The minimal slice of PrismaClient this needs — narrow on purpose so tests can pass a fake instead of a real client. */
export interface UserLookupClient {
    user: {
        findMany(args: unknown): Promise<UserLookupRow[]>
    }
}

export type ResolveUserResult =
    | { status: 'found'; user: UserLookupRow }
    | { status: 'not_found' }
    | { status: 'ambiguous'; matches: UserLookupRow[] }

/**
 * Resolve a user by id, username, or phone — whichever the identifier matches.
 *
 * Uses findMany, not findFirst: id/username/phone are three independently
 * unique columns, but nothing stops one user's username from equalling a
 * DIFFERENT user's phone (both are free-form strings with no shared format
 * constraint). An OR across all three can therefore match more than one row.
 * findFirst would silently pick one of them — for a login that just fails
 * closed on the wrong candidate, but for this script it would freeze an
 * innocent player. So every match is fetched and the ambiguous case is
 * reported back explicitly instead of being resolved by accident. The
 * exact-equality filters themselves are not the risk (no partial matching is
 * done) — only the cross-field collision is.
 */
export async function resolveUser(
    client: UserLookupClient,
    identifier: string,
): Promise<ResolveUserResult> {
    const matches = await client.user.findMany({
        where: { OR: [{ id: identifier }, { username: identifier }, { phone: identifier }] },
        select: { id: true, username: true, phone: true, serial: true, accountStatus: true },
    })

    if (matches.length === 0) return { status: 'not_found' }
    if (matches.length > 1) return { status: 'ambiguous', matches }
    return { status: 'found', user: matches[0] }
}

/** Which of id/username/phone a given row actually matched the identifier on — for the ambiguous-match report. */
export function matchedFields(row: UserLookupRow, identifier: string): Array<'id' | 'username' | 'phone'> {
    const fields: Array<'id' | 'username' | 'phone'> = []
    if (row.id === identifier) fields.push('id')
    if (row.username === identifier) fields.push('username')
    if (row.phone === identifier) fields.push('phone')
    return fields
}
