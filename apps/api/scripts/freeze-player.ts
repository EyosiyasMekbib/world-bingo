/**
 * Freeze or unfreeze a player's account, and mirror the action to ZareCash.
 *
 * WHY THIS SCRIPT EXISTS (instead of the raw SQL that has been used so far):
 * Nothing in the app writes User.isActive for a player — containment has
 * historically meant an operator running `UPDATE users SET "isActive" = false`
 * directly against the database (see the comment at
 * apps/api/src/services/player-crm/player-metrics.service.ts:288-293 for the
 * fallout: Prisma's `@updatedAt` never fires on a raw UPDATE, so the CRM
 * liveness rollup goes stale and a frozen fraud account can still look live).
 * This script goes through `prisma.user.update` instead, so the ORM sees the
 * change, and — because it's now real application code — it can actually call
 * `ZareCashService.syncPlayerFreeze` afterwards. Before this script there was
 * no call site for that sync to hook into at all.
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
 * id, username, or phone (whichever is cheapest to have on hand); all three
 * are unique columns, so a single lookup resolves any of them.
 *
 * The ZareCash mirror is best-effort: it is a no-op when ZARECASH_ENABLED is
 * not "true", and if it fails, this script still exits 0 — the LOCAL freeze
 * (the one that actually protects our balance, enforced in
 * WalletService.requestWithdrawal and AdminService.reviewTransaction) already
 * stands by the time the mirror is attempted. Only a failure to write the
 * local isActive flag is treated as a real failure (exit 1).
 *
 * The argument parsing and user lookup below are thin wrappers around
 * ../src/lib/freeze-player-args.ts, which holds the actual logic and is unit
 * tested at src/test/freeze-player-script.test.ts — this file stays a plain
 * I/O shell (Prisma call + ZareCash call + console output) that isn't itself
 * covered by `tsc --noEmit` (it lives outside src/'s rootDir), so keeping it
 * this thin is deliberate.
 */

import prisma from '../src/lib/prisma.js'
import { ZareCashService } from '../src/services/zarecash.service.js'
import { isZareCashEnabled } from '../src/gateways/payment/zarecash/config.js'
import { parseArgs, resolveUser, type ParsedArgs } from '../src/lib/freeze-player-args.js'

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

    const user = await resolveUser(prisma, identifier)
    if (!user) {
        console.error(`Player not found: ${identifier} (checked id, username, and phone)`)
        process.exitCode = 1
        return
    }

    // ── Step 1: LOCAL freeze, through Prisma so @updatedAt fires. This is the
    // freeze that actually protects our balance — it must land before the
    // upstream mirror is even attempted.
    let updated: { id: string; username: string | null; phone: string | null; serial: number; isActive: boolean }
    try {
        updated = await prisma.user.update({
            where: { id: user.id },
            data: { isActive: !frozen },
            select: { id: true, username: true, phone: true, serial: true, isActive: true },
        })
    } catch (err) {
        console.error(`Local ${action} FAILED for ${identifier}: ${(err as Error).message}`)
        process.exitCode = 1
        return
    }

    // ── Step 2: mirror to ZareCash, best-effort, local-first. syncPlayerFreeze
    // never throws by design (a failed mirror must never undo or block the
    // local freeze), so the only way this script can report whether the
    // mirror actually succeeded is by watching for the specific failure log
    // it emits internally — briefly intercepting console.error to catch it,
    // without changing syncPlayerFreeze's contract or its passing test suite.
    const mirrorAttempted = isZareCashEnabled()
    let mirrorFailed = false
    if (mirrorAttempted) {
        const originalError = console.error
        console.error = (...args: unknown[]) => {
            if (String(args[0] ?? '').includes('[ZareCash] freeze sync failed')) mirrorFailed = true
            originalError(...args)
        }
        try {
            await ZareCashService.syncPlayerFreeze(updated.id, frozen, reason)
        } finally {
            console.error = originalError
        }
    }

    const label = updated.username ?? updated.phone ?? updated.id
    console.log('──────────────────────────────────────────────')
    console.log(`Action:   ${action.toUpperCase()}`)
    console.log(`User:     ${label} (id=${updated.id}, serial=${updated.serial})`)
    console.log(`Reason:   ${reason}`)
    console.log(`Local:    OK — isActive=${updated.isActive} (written via Prisma, updatedAt bumped)`)
    console.log(
        `ZareCash: ${
            !mirrorAttempted
                ? 'not attempted (ZARECASH_ENABLED is not "true")'
                : mirrorFailed
                  ? 'attempted — FAILED (see [ZareCash] log above; local freeze still stands)'
                  : 'attempted — OK'
        }`,
    )
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
