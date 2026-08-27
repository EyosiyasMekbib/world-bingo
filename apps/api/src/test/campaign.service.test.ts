import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import {
    CampaignService,
    evaluateCaps,
    approvalHashOf,
} from '../services/player-crm/campaign.service'
import { PlayerMetricsService } from '../services/player-crm/player-metrics.service'
import { SegmentService } from '../services/player-crm/segment.service'
import { prisma } from './setup'
import { SEGMENT_RULESET_VERSION } from '@world-bingo/shared-types'

vi.mock('../lib/socket', () => ({
    getIo: () => ({ to: () => ({ emit: vi.fn() }), emit: vi.fn() }),
}))

// Bonus grants ship dark. These tests exercise the grant path deliberately, so
// they opt in explicitly — which also documents that the default is OFF.
beforeEach(() => {
    process.env.CRM_BONUS_GRANTS_ENABLED = 'true'
})

const AUTHOR = 'author-id'
const APPROVER = 'approver-id'

const allPlayers = {
    version: SEGMENT_RULESET_VERSION,
    root: { kind: 'group', op: 'AND', children: [{ kind: 'cond', field: 'tenureDays', op: 'gte', value: 0 }] },
}

async function makePlayer(username: string, phone: string, bonus = 0) {
    return prisma.user.create({
        data: {
            username,
            phone,
            passwordHash: 'hashed:pass',
            role: 'PLAYER',
            wallet: { create: { realBalance: 100, bonusBalance: bonus } },
        },
    })
}

async function setup(opts: { players?: number; bonusAmount?: number; caps?: Partial<{ maxRecipients: number; maxTotalBonus: number; maxPerPlayer: number }> } = {}) {
    const players = []
    for (let i = 0; i < (opts.players ?? 2); i++) {
        players.push(await makePlayer(`camp_${i}_${Date.now()}`, `+2519008${String(i).padStart(5, '0')}`))
    }
    await PlayerMetricsService.refreshAll()

    const segment = await SegmentService.create({ name: `seg-${Date.now()}`, rules: allPlayers })

    const campaign = await CampaignService.create({
        name: 'Test campaign',
        segmentId: segment.id,
        actions: opts.bonusAmount
            ? { message: { title: 'Hi', body: 'Come back' }, bonus: { amount: opts.bonusAmount } }
            : { message: { title: 'Hi', body: 'Come back' } },
        maxRecipients: opts.caps?.maxRecipients ?? 1000,
        maxTotalBonus: opts.caps?.maxTotalBonus ?? 10_000,
        maxPerPlayer: opts.caps?.maxPerPlayer ?? 100,
        actorId: AUTHOR,
        actorName: 'author',
    })

    return { players, segment, campaign }
}

async function runToCompletion(id: string) {
    for (let i = 0; i < 20; i++) {
        const { done } = await CampaignService.drainBatch(id)
        if (done) return
    }
}

describe('evaluateCaps — pure', () => {
    const base = {
        grantedTotal: new Decimal(0),
        sentCount: 0,
        maxTotalBonus: new Decimal(1000),
        maxPerPlayer: new Decimal(50),
        maxRecipients: 10,
    }

    it('allows a grant inside every cap', () => {
        expect(evaluateCaps(base, new Decimal(50))).toEqual({ ok: true })
    })

    it('rejects above the per-player cap', () => {
        expect(evaluateCaps(base, new Decimal(51))).toEqual({ ok: false, reason: 'PER_PLAYER_CAP' })
    })

    it('rejects when the campaign total would be exceeded', () => {
        expect(
            evaluateCaps({ ...base, grantedTotal: new Decimal(980) }, new Decimal(50)),
        ).toEqual({ ok: false, reason: 'CAMPAIGN_TOTAL_CAP' })
    })

    it('rejects once the recipient cap is reached', () => {
        expect(evaluateCaps({ ...base, sentCount: 10 }, new Decimal(1))).toEqual({
            ok: false,
            reason: 'RECIPIENT_CAP',
        })
    })

    it('treats the total cap as inclusive at the boundary', () => {
        expect(evaluateCaps({ ...base, grantedTotal: new Decimal(950) }, new Decimal(50))).toEqual({
            ok: true,
        })
    })
})

describe('CampaignService — approval gate', () => {
    it('refuses approval by the author', async () => {
        const { campaign } = await setup()
        await CampaignService.submitForApproval(campaign.id)

        await expect(
            CampaignService.approve(campaign.id, { id: AUTHOR, username: 'author' }),
        ).rejects.toThrow(/other than its author/i)
    })

    it('refuses approval by the last editor, not just the original author', async () => {
        // Otherwise: edit a colleague's draft, then approve your own work.
        const { campaign } = await setup()
        await CampaignService.update(campaign.id, { name: 'Edited' }, APPROVER)
        await CampaignService.submitForApproval(campaign.id)

        await expect(
            CampaignService.approve(campaign.id, { id: APPROVER, username: 'approver' }),
        ).rejects.toThrow(/author or last editor/i)
    })

    it('requires a note when the campaign grants money', async () => {
        const { campaign } = await setup({ bonusAmount: 10 })
        await CampaignService.submitForApproval(campaign.id)

        await expect(
            CampaignService.approve(campaign.id, { id: APPROVER, username: 'approver' }),
        ).rejects.toThrow(/note is required/i)
    })

    it('pins the rules snapshot and hash at approval', async () => {
        const { campaign } = await setup()
        await CampaignService.submitForApproval(campaign.id)
        const approved = await CampaignService.approve(campaign.id, { id: APPROVER, username: 'approver' })

        expect(approved.status).toBe('APPROVED')
        expect(approved.approvalHash).toBeTruthy()
        expect(approved.approvedByUsername).toBe('approver')
        expect(approved.segmentRulesSnapshot).toBeTruthy()
    })

    it('blocks editing once approved', async () => {
        const { campaign } = await setup()
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER })

        await expect(CampaignService.update(campaign.id, { name: 'Sneaky' })).rejects.toThrow(
            /Cannot edit/i,
        )
    })
})

describe('CampaignService — message delivery', () => {
    it('delivers one notification per player and completes', async () => {
        const { campaign, players } = await setup({ players: 3 })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER })
        await CampaignService.launch(campaign.id)

        await runToCompletion(campaign.id)

        const notifications = await prisma.notification.findMany({ where: { type: 'CAMPAIGN_MESSAGE' } })
        expect(notifications).toHaveLength(players.length)

        const final = await prisma.campaign.findUnique({ where: { id: campaign.id } })
        expect(final!.status).toBe('COMPLETED')
        expect(final!.sentCount).toBe(players.length)
    })

    it('caps the recipient list at maxRecipients', async () => {
        const { campaign } = await setup({ players: 4, caps: { maxRecipients: 2 } })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER })

        const { queued } = await CampaignService.launch(campaign.id)

        expect(queued).toBe(2)
    })

    it('re-launching does not duplicate deliveries', async () => {
        const { campaign, players } = await setup({ players: 3 })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER })

        await CampaignService.launch(campaign.id)
        await CampaignService.launch(campaign.id)

        const deliveries = await prisma.campaignDelivery.count({ where: { campaignId: campaign.id } })
        expect(deliveries).toBe(players.length)
    })
})

describe('CampaignService — bonus grants', () => {
    it('credits bonus balance and writes an auditable transaction', async () => {
        const { campaign, players } = await setup({ players: 1, bonusAmount: 25 })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER, note: 'Q3 winback' })
        await CampaignService.launch(campaign.id)
        await runToCompletion(campaign.id)

        const wallet = await prisma.wallet.findUnique({ where: { userId: players[0].id } })
        expect(Number(wallet!.bonusBalance)).toBe(25)
        // Real balance must be untouched — this is promotional credit, not cash.
        expect(Number(wallet!.realBalance)).toBe(100)

        const txn = await prisma.transaction.findFirst({
            where: { userId: players[0].id, type: 'CAMPAIGN_BONUS' },
        })
        expect(txn).not.toBeNull()
        expect(Number(txn!.amount)).toBe(25)
        expect(txn!.referenceId).toBe(campaign.id)
        expect(Number(txn!.bonusBalanceBefore)).toBe(0)
        expect(Number(txn!.bonusBalanceAfter)).toBe(25)

        const lot = await prisma.bonusGrant.findFirstOrThrow({ where: { userId: players[0].id } })
        expect(lot.ruleId).toBeNull()
    })

    it('fails the delivery gracefully when the targeted user has no wallet', async () => {
        // Wallet is an optional relation (schema.prisma), so Prisma allows creating
        // a User with no Wallet row directly — the same shape bot.service.ts's
        // non-transactional upsert pair can transiently leave behind. This proves
        // the explicit guard in processDelivery fails closed instead of letting
        // BonusService.grant's internal wallet-update throw escape uncaught.
        const walletless = await prisma.user.create({
            data: {
                username: `nowallet_${Date.now()}`,
                phone: '+251900199999',
                passwordHash: 'hashed:pass',
                role: 'PLAYER',
            },
        })
        await PlayerMetricsService.refreshAll()

        const segment = await SegmentService.create({ name: `nowallet-${Date.now()}`, rules: allPlayers })
        const campaign = await CampaignService.create({
            name: 'No wallet test',
            segmentId: segment.id,
            actions: { bonus: { amount: 10 } },
            maxRecipients: 1000,
            maxTotalBonus: 10_000,
            maxPerPlayer: 100,
            actorId: AUTHOR,
            actorName: 'author',
        })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER, note: 'test' })
        await CampaignService.launch(campaign.id)
        await runToCompletion(campaign.id)

        const delivery = await prisma.campaignDelivery.findFirst({
            where: { campaignId: campaign.id, userId: walletless.id },
        })
        expect(delivery!.status).toBe('FAILED')
        expect(delivery!.error).toMatch(/wallet/i)
        expect(
            await prisma.transaction.count({ where: { userId: walletless.id, type: 'CAMPAIGN_BONUS' } }),
        ).toBe(0)

        const final = await prisma.campaign.findUnique({ where: { id: campaign.id } })
        expect(final!.failedCount).toBe(1)
    })

    it('skips players above the per-player cap instead of paying them', async () => {
        const { campaign } = await setup({ players: 1, bonusAmount: 500, caps: { maxPerPlayer: 100 } })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER, note: 'test' })
        await CampaignService.launch(campaign.id)
        await runToCompletion(campaign.id)

        expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_BONUS' } })).toBe(0)
        const delivery = await prisma.campaignDelivery.findFirst({ where: { campaignId: campaign.id } })
        expect(delivery!.status).toBe('SKIPPED')
        expect(delivery!.skipReason).toBe('PER_PLAYER_CAP')
    })

    it('stops paying once the campaign total cap is reached', async () => {
        // 4 players × 30 with a 100 total → only 3 can be paid.
        const { campaign } = await setup({
            players: 4,
            bonusAmount: 30,
            caps: { maxTotalBonus: 100, maxPerPlayer: 50 },
        })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER, note: 'test' })
        await CampaignService.launch(campaign.id)
        await runToCompletion(campaign.id)

        const paid = await prisma.transaction.count({ where: { type: 'CAMPAIGN_BONUS' } })
        expect(paid).toBe(3)

        const final = await prisma.campaign.findUnique({ where: { id: campaign.id } })
        expect(Number(final!.grantedTotal)).toBe(90)
        expect(Number(final!.grantedTotal)).toBeLessThanOrEqual(100)
    })

    it('never pays a player twice, even across repeated drains', async () => {
        const { campaign, players } = await setup({ players: 1, bonusAmount: 20 })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER, note: 'test' })
        await CampaignService.launch(campaign.id)

        await runToCompletion(campaign.id)
        await CampaignService.drainBatch(campaign.id).catch(() => {})

        const wallet = await prisma.wallet.findUnique({ where: { userId: players[0].id } })
        expect(Number(wallet!.bonusBalance)).toBe(20)
        expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_BONUS' } })).toBe(1)
    })

    it('locks the wallet so concurrent campaign deliveries to the same player chain their before/after balances correctly', async () => {
        // BonusService.grant() reads the wallet with a plain, unlocked SELECT —
        // it assumes the caller already holds a FOR UPDATE lock on the wallet
        // row in this same transaction (the Global Constraint every other
        // BonusService caller follows; see game.service.ts's joinGame). Without
        // it, two DIFFERENT campaigns draining concurrently — a realistic
        // multi-worker scenario — and both targeting the same player can each
        // read a stale bonusBalance and record a wrong bonusBalanceBefore in
        // their audit row, even though the wallet's own increments are
        // individually atomic and the final balance is correct.
        //
        // A single colliding pair is a coin flip given how much sequential work
        // (user lookup, campaign-row lock, cap check) each delivery does before
        // reaching the unlocked read — not flaky exactly, but not a reliable
        // regression guard on its own. Eight campaigns racing the same player
        // turns that into 28 colliding PAIRS, so the unlocked-code failure rate
        // is close to certain while the locked-code pass rate stays exactly 100%
        // (FOR UPDATE serializes every one of them, no matter how many).
        const player = await makePlayer(`camp_conc_${Date.now()}`, `+2519009${String(Date.now()).slice(-6)}`)
        await PlayerMetricsService.refreshAll()

        const segment = await SegmentService.create({ name: `conc-${Date.now()}`, rules: allPlayers })

        const amounts = [1, 2, 3, 4, 5, 6, 7, 8]
        const campaigns = []
        for (const amount of amounts) {
            campaigns.push(
                await CampaignService.create({
                    name: `Concurrent ${amount}`, segmentId: segment.id,
                    actions: { bonus: { amount } },
                    maxRecipients: 1000, maxTotalBonus: 10_000, maxPerPlayer: 100,
                    actorId: AUTHOR, actorName: 'author',
                }),
            )
        }
        for (const c of campaigns) {
            await CampaignService.submitForApproval(c.id)
            await CampaignService.approve(c.id, { id: APPROVER, note: 'concurrent test' })
            await CampaignService.launch(c.id)
        }

        await Promise.all(campaigns.map((c) => runToCompletion(c.id)))

        const total = amounts.reduce((a, b) => a + b, 0) // 36
        const wallet = await prisma.wallet.findUnique({ where: { userId: player.id } })
        expect(Number(wallet!.bonusBalance)).toBe(total)

        const rows = await prisma.transaction.findMany({
            where: { userId: player.id, type: 'CAMPAIGN_BONUS' },
        })
        expect(rows).toHaveLength(amounts.length)

        // Sorted by "before", a correctly serialized run is a strict chain:
        // each row's before equals the PREVIOUS row's after, starting at 0 and
        // ending at the true final total. An unlocked, racing read breaks this
        // chain — two rows can share the same (wrong) "before".
        const sorted = [...rows].sort(
            (a, b) => Number(a.bonusBalanceBefore) - Number(b.bonusBalanceBefore),
        )
        expect(Number(sorted[0].bonusBalanceBefore)).toBe(0)
        for (let i = 1; i < sorted.length; i++) {
            expect(Number(sorted[i].bonusBalanceBefore)).toBe(Number(sorted[i - 1].bonusBalanceAfter))
        }
        expect(Number(sorted[sorted.length - 1].bonusBalanceAfter)).toBe(total)
    })

    it('fails the campaign if the payload changed after approval', async () => {
        const { campaign } = await setup({ players: 1, bonusAmount: 10 })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER, note: 'approved for 10' })
        await CampaignService.launch(campaign.id)

        // Tamper directly, as an insider bypassing the DRAFT-only guard would.
        await prisma.campaign.update({
            where: { id: campaign.id },
            data: { actions: { bonus: { amount: 5000 } } as never },
        })

        await CampaignService.drainBatch(campaign.id)

        const final = await prisma.campaign.findUnique({ where: { id: campaign.id } })
        expect(final!.status).toBe('FAILED')
        expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_BONUS' } })).toBe(0)
    })
})

describe('CampaignService — exclusions and stop', () => {
    it('skips a player frozen after launch', async () => {
        const { campaign, players } = await setup({ players: 1, bonusAmount: 10 })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER, note: 'test' })
        await CampaignService.launch(campaign.id)

        // Raw UPDATE, exactly as freeze_flagged.sql does — bumps no timestamp.
        await prisma.$executeRaw`UPDATE users SET "accountStatus" = 'SUSPENDED' WHERE id = ${players[0].id}`

        await runToCompletion(campaign.id)

        expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_BONUS' } })).toBe(0)
        const delivery = await prisma.campaignDelivery.findFirst({ where: { campaignId: campaign.id } })
        expect(delivery!.status).toBe('SKIPPED')
        expect(delivery!.skipReason).toBe('EXCLUDED')
    })

    it('stop leaves no delivery in limbo', async () => {
        const { campaign } = await setup({ players: 3 })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER })
        await CampaignService.launch(campaign.id)

        await CampaignService.stop(campaign.id)

        const queued = await prisma.campaignDelivery.count({
            where: { campaignId: campaign.id, status: 'QUEUED' },
        })
        expect(queued).toBe(0)
        const final = await prisma.campaign.findUnique({ where: { id: campaign.id } })
        expect(final!.status).toBe('CANCELLED')
    })

    it('a stopped campaign does not deliver on a later drain', async () => {
        const { campaign } = await setup({ players: 2, bonusAmount: 10 })
        await CampaignService.submitForApproval(campaign.id)
        await CampaignService.approve(campaign.id, { id: APPROVER, note: 'test' })
        await CampaignService.launch(campaign.id)
        await CampaignService.stop(campaign.id)

        await CampaignService.drainBatch(campaign.id)

        expect(await prisma.transaction.count({ where: { type: 'CAMPAIGN_BONUS' } })).toBe(0)
    })
})

describe('approvalHashOf', () => {
    it('is stable across key ordering', () => {
        const a = approvalHashOf({
            rules: { b: 1, a: 2 },
            actions: { bonus: { amount: 5 } },
            maxRecipients: 10,
            maxTotalBonus: 100,
            maxPerPlayer: 5,
        })
        const b = approvalHashOf({
            rules: { a: 2, b: 1 },
            actions: { bonus: { amount: 5 } },
            maxRecipients: 10,
            maxTotalBonus: 100,
            maxPerPlayer: 5,
        })
        expect(a).toBe(b)
    })

    it('changes when the amount changes', () => {
        const base = { rules: {}, maxRecipients: 10, maxTotalBonus: 100, maxPerPlayer: 5 }
        expect(approvalHashOf({ ...base, actions: { bonus: { amount: 5 } } })).not.toBe(
            approvalHashOf({ ...base, actions: { bonus: { amount: 5000 } } }),
        )
    })

    it('changes when a cap changes', () => {
        const base = { rules: {}, actions: { bonus: { amount: 5 } }, maxTotalBonus: 100, maxPerPlayer: 5 }
        expect(approvalHashOf({ ...base, maxRecipients: 10 })).not.toBe(
            approvalHashOf({ ...base, maxRecipients: 100000 }),
        )
    })
})

describe('Phase 3 kill switch', () => {
    it('refuses to create a bonus campaign when grants are disabled', async () => {
        process.env.CRM_BONUS_GRANTS_ENABLED = 'false'
        const segment = await SegmentService.create({ name: `off-${Date.now()}`, rules: allPlayers })

        await expect(
            CampaignService.create({
                name: 'Should not exist',
                segmentId: segment.id,
                actions: { bonus: { amount: 10 } },
                actorId: AUTHOR,
            }),
        ).rejects.toThrow(/disabled/i)
    })

    it('still allows message-only campaigns when grants are disabled', async () => {
        process.env.CRM_BONUS_GRANTS_ENABLED = 'false'
        const segment = await SegmentService.create({ name: `msg-${Date.now()}`, rules: allPlayers })

        const campaign = await CampaignService.create({
            name: 'Message only',
            segmentId: segment.id,
            actions: { message: { title: 'Hi', body: 'There' } },
            actorId: AUTHOR,
        })

        expect(campaign.status).toBe('DRAFT')
    })

    it('refuses to approve a bonus campaign drafted before the flag was switched off', async () => {
        process.env.CRM_BONUS_GRANTS_ENABLED = 'true'
        const { campaign } = await setup({ players: 1, bonusAmount: 10 })
        await CampaignService.submitForApproval(campaign.id)

        process.env.CRM_BONUS_GRANTS_ENABLED = 'false'

        await expect(
            CampaignService.approve(campaign.id, { id: APPROVER, note: 'nope' }),
        ).rejects.toThrow(/disabled/i)
    })
})
