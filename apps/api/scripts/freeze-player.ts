/**
 * Freeze or unfreeze a player's account, and mirror the action to ZareCash.
 *
 * WHY THIS SCRIPT EXISTS: containment used to mean an operator running
 * `UPDATE users SET "isActive" = false` straight against the database, which
 * left no reason, no actor and no audit trail, and never fired Prisma's
 * `@updatedAt` — so the CRM liveness rollup went stale and a frozen fraud
 * account could still look live.
 *
 * It now delegates to AccountStatusService, the single writer of
 * accountStatus. The history row, the audit log, the player notification and
 * the ZareCash mirror are all guaranteed by that service rather than being
 * remembered here, so this script and the admin panel cannot drift apart.
 *
 * `freeze` maps to SUSPENDED. RESTRICTED — the review state that still lets a
 * player reach support — is a considered decision that belongs in the admin
 * panel, where a category and an expiry can be set alongside it.
 *
 * USAGE (run from apps/api/)
 *   pnpm exec tsx --env-file ../../.env scripts/freeze-player.ts <freeze|unfreeze> <userId|username|phone> <reason...>
 *
 * EXAMPLES
 *   pnpm exec tsx --env-file ../../.env scripts/freeze-player.ts freeze cljk3x9f00001 "fraud review — chargeback pattern"
 *   pnpm exec tsx --env-file ../../.env scripts/freeze-player.ts unfreeze +251911223344 "cleared by fraud team, ticket #482"
 *
 * The reason is required and is never defaulted — a containment action with
 * no recorded reason is how audit trails rot. The user may be identified by
 * id, username, or phone (whichever is cheapest to have on hand). All three
 * are unique columns, but username/phone are independently unique free-form
 * strings, so one user's username CAN collide with a different user's phone
 * — if the identifier matches more than one row, this script refuses to
 * guess: it prints every match and exits non-zero without touching anyone.
 * Re-run with the printed `id=` value to disambiguate.
 *
 * The ZareCash mirror is best-effort and happens inside the service: it is a
 * no-op when ZARECASH_ENABLED is not "true", and a failure there never undoes
 * the local transition — the local status is what protects our balance. Only a
 * failed transition, or an ambiguous/missing identifier, exits non-zero.
 *
 * The argument parsing and user lookup below are thin wrappers around
 * ../src/lib/freeze-player-args.ts, which holds the actual logic and is unit
 * tested at src/test/freeze-player-script.test.ts — this file stays a plain
 * I/O shell (Prisma call + ZareCash call + console output) that isn't itself
 * covered by `tsc --noEmit` (it lives outside src/'s rootDir), so keeping it
 * this thin is deliberate.
 */

import prisma from '../src/lib/prisma.js'
import { AccountStatusService } from '../src/services/account-status.service.js'
import { parseArgs, resolveUser, matchedFields, type ParsedArgs } from '../src/lib/freeze-player-args.js'

async function main(): Promise<void> {
    let parsed: ParsedArgs
    try {
        parsed = parseArgs(process.argv.slice(2))
    } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
        return
    }

    const { action, identifier, reason } = parsed
    const frozen = action === 'freeze'

    const lookup = await resolveUser(prisma, identifier)

    if (lookup.status === 'not_found') {
        console.error(`Player not found: ${identifier} (checked id, username, and phone)`)
        process.exitCode = 1
        return
    }

    if (lookup.status === 'ambiguous') {
        console.error(
            `Ambiguous identifier "${identifier}" matches ${lookup.matches.length} players — refusing to guess. No changes were made.`,
        )
        for (const row of lookup.matches) {
            const fields = matchedFields(row, identifier).join(', ')
            console.error(
                `  - id=${row.id} serial=${row.serial} username=${row.username ?? '(none)'} phone=${row.phone ?? '(none)'} (matched on: ${fields})`,
            )
        }
        console.error('Re-run this script with the exact "id=" value above to disambiguate.')
        process.exitCode = 1
        return
    }

    const user = lookup.user

    // ── The transition itself goes through AccountStatusService, which is the
    // only writer of accountStatus in the codebase. This script used to write
    // the flag directly; that made it a second path with its own semantics, and
    // the audit row, the player notification and the ZareCash mirror all had to
    // be remembered here rather than being guaranteed by the service.
    //
    // `freeze` maps to SUSPENDED rather than RESTRICTED: this is the blunt
    // operator-facing containment tool, and someone reaching for a shell script
    // at 2am means it, whereas RESTRICTED is a considered review state that
    // belongs in the admin panel where a category and an expiry can be set.
    try {
        if (frozen) {
            await AccountStatusService.suspend(user.id, { reason, actorId: null })
        } else {
            await AccountStatusService.reinstate(user.id, { reason, actorId: null })
        }
    } catch (err) {
        console.error(`Local ${action} FAILED for ${identifier}: ${(err as Error).message}`)
        process.exitCode = 1
        return
    }

    const updated = await prisma.user.findUnique({
        where: { id: user.id },
        select: { id: true, username: true, phone: true, serial: true, accountStatus: true },
    })
    if (!updated) {
        console.error(`Player vanished mid-${action}: ${identifier}`)
        process.exitCode = 1
        return
    }

    const label = updated.username ?? updated.phone ?? updated.id
    console.log('──────────────────────────────────────────────')
    console.log(`Action:   ${action.toUpperCase()}`)
    console.log(`User:     ${label} (id=${updated.id}, serial=${updated.serial})`)
    console.log(`Reason:   ${reason}`)
    console.log(`Local:    OK — accountStatus=${updated.accountStatus} (history row and audit log written)`)
    console.log('ZareCash: mirrored by AccountStatusService (best-effort; see the API log for the outcome)')
    console.log('──────────────────────────────────────────────')
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
    main()
        .catch((err) => {
            console.error('Unexpected error:', err)
            process.exitCode = 1
        })
        .finally(async () => {
            await prisma.$disconnect().catch(() => {})
        })
}
