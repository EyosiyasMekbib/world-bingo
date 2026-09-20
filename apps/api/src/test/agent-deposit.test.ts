import { describe, it, expect, afterEach, vi } from 'vitest'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import {
    AgentDepositService,
    AgentSuspendedError,
    AmountOutOfRangeError,
    RequestAlreadyFulfilledError,
    RequestExpiredError,
    RequestNotFoundError,
} from '../services/agent-deposit.service'
import { AgentService, InsufficientFloatError } from '../services/agent.service'
import { prisma, expectInvariantClean } from './setup'
import { PaymentStatus, TransactionType } from '@world-bingo/shared-types'

let seq = 0

async function player(overrides: { firstName?: string; lastName?: string; phone?: string } = {}) {
    seq++
    return prisma.user.create({
        data: {
            username: `player-${seq}`,
            phone: overrides.phone ?? `+25191234${String(seq).padStart(4, '0')}`,
            firstName: overrides.firstName,
            lastName: overrides.lastName,
            passwordHash: 'x',
            wallet: { create: { realBalance: 0 } },
        },
    })
}

async function agentWithFloat(float: number) {
    seq++
    const agent = await AgentService.createAgent({
        username: `shop-${seq}`,
        password: 'a-long-enough-password',
        shopName: `Shop ${seq}`,
    })
    if (float > 0) {
        await prisma.agent.update({ where: { id: agent.id }, data: { float } })
    }
    return agent
}

const floatOf = async (agentId: string) =>
    Number((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).float)

const realBalanceOf = async (userId: string) =>
    Number((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).realBalance)

const firstDepositBonuses = (userId: string) =>
    prisma.transaction.count({ where: { userId, type: TransactionType.FIRST_DEPOSIT_BONUS } })

describe('AgentDepositService.createRequest', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('issues a six-digit code with the configured lifetime', async () => {
        const p = await player()
        const before = Date.now()

        const request = await AgentDepositService.createRequest(p.id, '200')

        expect(request.code).toMatch(/^\d{6}$/)
        expect(request.amount).toBe('200.00')
        expect(request.status).toBe('PENDING')
        // Default TTL is 900s; allow for the round trip either side.
        const ttlMs = request.expiresAt.getTime() - before
        expect(ttlMs).toBeGreaterThan(890_000)
        expect(ttlMs).toBeLessThanOrEqual(901_000)
    })

    it('refuses an amount below the minimum', async () => {
        const p = await player()
        const err = await AgentDepositService.createRequest(p.id, '10').catch((e) => e)

        expect(err).toBeInstanceOf(AmountOutOfRangeError)
        expect(err.min).toBe('50.00')
        expect(err.max).toBe('5000.00')
        expect(await prisma.agentDepositRequest.count()).toBe(0)
    })

    it('refuses an amount above the maximum', async () => {
        const p = await player()
        await expect(AgentDepositService.createRequest(p.id, '99999')).rejects.toBeInstanceOf(AmountOutOfRangeError)
        expect(await prisma.agentDepositRequest.count()).toBe(0)
    })

    it('honours configured limits', async () => {
        const p = await player()
        await AgentService.updateSettings({ depositMin: '100', depositMax: '150' })

        await expect(AgentDepositService.createRequest(p.id, '99')).rejects.toBeInstanceOf(AmountOutOfRangeError)
        await expect(AgentDepositService.createRequest(p.id, '151')).rejects.toBeInstanceOf(AmountOutOfRangeError)
        await expect(AgentDepositService.createRequest(p.id, '100')).resolves.toBeTruthy()
    })

    it('cancels the players previous code when a second one is asked for', async () => {
        const p = await player()
        const first = await AgentDepositService.createRequest(p.id, '200')
        const second = await AgentDepositService.createRequest(p.id, '300')

        expect(second.code).not.toBe(first.code)

        const rows = await prisma.agentDepositRequest.findMany({ where: { userId: p.id } })
        expect(rows).toHaveLength(2)
        expect(rows.find((r) => r.id === first.id)?.status).toBe('CANCELLED')
        expect(rows.find((r) => r.id === second.id)?.status).toBe('PENDING')

        // One player, one live code - which is what makes the cash at the counter
        // unambiguous.
        const active = await AgentDepositService.getActiveRequest(p.id)
        expect(active?.id).toBe(second.id)
    })

    it('treats an expired PENDING row as no live code', async () => {
        const p = await player()
        const request = await AgentDepositService.createRequest(p.id, '200')
        await prisma.agentDepositRequest.update({
            where: { id: request.id },
            data: { expiresAt: new Date(Date.now() - 1000) },
        })

        expect(await AgentDepositService.getActiveRequest(p.id)).toBeNull()
    })

    it('cancelActiveRequest is idempotent', async () => {
        const p = await player()
        await AgentDepositService.createRequest(p.id, '200')

        expect(await AgentDepositService.cancelActiveRequest(p.id)).toEqual({ cancelled: 1 })
        expect(await AgentDepositService.cancelActiveRequest(p.id)).toEqual({ cancelled: 0 })
        expect(await AgentDepositService.getActiveRequest(p.id)).toBeNull()
    })
})

describe('AgentDepositService.lookupByCode', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('shows the full name and only the last four digits of the phone', async () => {
        const p = await player({ firstName: 'Kebede', lastName: 'Mekonnen', phone: '+251912345284' })
        const request = await AgentDepositService.createRequest(p.id, '200')

        const view = await AgentDepositService.lookupByCode(request.code)

        expect(view.amount).toBe('200.00')
        // The name is deliberately unmasked: the agent has to match the person
        // in front of them to the account before taking cash.
        expect(view.player.name).toBe('Kebede Mekonnen')
        expect(view.player.phoneTail).toBe('•••• 5284')
        expect(view.player.depositCount).toBe(0)

        // The phone is still never returned in a form the agent could dial.
        const serialised = JSON.stringify(view)
        expect(serialised).not.toContain('912345284')
        expect(serialised).not.toContain('+251912345284')
    })

    it('falls back to the username when the account has no real name', async () => {
        const p = await player({ phone: '+251912345284' })
        const request = await AgentDepositService.createRequest(p.id, '200')

        const view = await AgentDepositService.lookupByCode(request.code)

        expect(view.player.name).not.toBe('')
        expect(view.player.name).not.toBe('Player')
    })

    it('moves no money', async () => {
        const p = await player()
        const request = await AgentDepositService.createRequest(p.id, '200')

        await AgentDepositService.lookupByCode(request.code)

        expect(await realBalanceOf(p.id)).toBe(0)
        expect(await prisma.transaction.count()).toBe(0)
        expect(
            (await prisma.agentDepositRequest.findUniqueOrThrow({ where: { id: request.id } })).status,
        ).toBe('PENDING')
    })

    it('refuses an unknown code', async () => {
        await expect(AgentDepositService.lookupByCode('000001')).rejects.toBeInstanceOf(RequestNotFoundError)
    })

    it('refuses an expired code', async () => {
        const p = await player()
        const request = await AgentDepositService.createRequest(p.id, '200')
        const expiredAt = new Date(Date.now() - 1000)
        await prisma.agentDepositRequest.update({ where: { id: request.id }, data: { expiresAt: expiredAt } })

        const err = await AgentDepositService.lookupByCode(request.code).catch((e) => e)
        expect(err).toBeInstanceOf(RequestExpiredError)
        expect(err.expiredAt.getTime()).toBe(expiredAt.getTime())
    })

    it('refuses a cancelled code as not found', async () => {
        const p = await player()
        const request = await AgentDepositService.createRequest(p.id, '200')
        await AgentDepositService.cancelActiveRequest(p.id)

        await expect(AgentDepositService.lookupByCode(request.code)).rejects.toBeInstanceOf(RequestNotFoundError)
    })
})

describe('AgentDepositService.fulfill', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('debits the float and credits the player in one commit', async () => {
        const p = await player({ firstName: 'Almaz', lastName: 'Tesfaye' })
        const agent = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '200')

        const result = await AgentDepositService.fulfill(request.code, agent.userId)

        expect(result.amount).toBe('200.00')
        expect(result.floatAfter).toBe('800.00')
        expect(result.code).toBe(request.code)
        expect(result.player.name).toBe('Almaz Tesfaye')

        expect(await floatOf(agent.id)).toBe(800)
        expect(await realBalanceOf(p.id)).toBe(200)

        const settled = await prisma.agentDepositRequest.findUniqueOrThrow({ where: { id: request.id } })
        expect(settled.status).toBe('FULFILLED')
        expect(settled.agentId).toBe(agent.id)
        expect(settled.transactionId).toBe(result.reference)
        expect(settled.fulfilledAt).toBeInstanceOf(Date)

        const deposit = await prisma.transaction.findUniqueOrThrow({ where: { id: result.reference } })
        expect(deposit.type).toBe(TransactionType.DEPOSIT)
        expect(deposit.status).toBe(PaymentStatus.APPROVED)
        expect(deposit.gateway).toBe('agent')
        expect(deposit.reviewedById).toBe(agent.userId)
        expect(Number(deposit.balanceBefore)).toBe(0)
        expect(Number(deposit.balanceAfter)).toBe(200)

        const entry = await prisma.agentLedger.findFirstOrThrow({ where: { agentId: agent.id } })
        expect(entry.type).toBe('FULFILLMENT')
        expect(Number(entry.amount)).toBe(-200)
        expect(Number(entry.balanceBefore)).toBe(1000)
        expect(Number(entry.balanceAfter)).toBe(800)
        expect(entry.requestId).toBe(request.id)
        // No member of staff moved this: the agent settled it at the counter.
        expect(entry.actorId).toBeNull()
    })

    it('leaves senderName and senderAccount null on the deposit row', async () => {
        const p = await player()
        const agent = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '200')

        const result = await AgentDepositService.fulfill(request.code, agent.userId)

        // Load-bearing, not cosmetic: PayerIdentityService keys shared-payer
        // detection on senderAccount. See the comment in agent-deposit.service.ts.
        const deposit = await prisma.transaction.findUniqueOrThrow({ where: { id: result.reference } })
        expect(deposit.senderName).toBeNull()
        expect(deposit.senderAccount).toBeNull()
    })

    it('refuses a fulfilment larger than the float and moves nothing', async () => {
        const p = await player()
        const agent = await agentWithFloat(100)
        const request = await AgentDepositService.createRequest(p.id, '200')

        const err = await AgentDepositService.fulfill(request.code, agent.userId).catch((e) => e)

        expect(err).toBeInstanceOf(InsufficientFloatError)
        expect(err.float).toBe('100.00')
        expect(err.required).toBe('200.00')

        // Nothing moved anywhere: no float, no wallet, no deposit row, and the code
        // is still live so the player can go to a different shop.
        expect(await floatOf(agent.id)).toBe(100)
        expect(await realBalanceOf(p.id)).toBe(0)
        expect(await prisma.transaction.count()).toBe(0)
        expect(await prisma.agentLedger.count()).toBe(0)
        expect(
            (await prisma.agentDepositRequest.findUniqueOrThrow({ where: { id: request.id } })).status,
        ).toBe('PENDING')
    })

    it('two agents racing on one code: exactly one wins and the float moves once', async () => {
        const p = await player()
        const first = await agentWithFloat(1000)
        const second = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '200')

        const settled = await Promise.allSettled([
            AgentDepositService.fulfill(request.code, first.userId),
            AgentDepositService.fulfill(request.code, second.userId),
        ])

        const fulfilled = settled.filter((r) => r.status === 'fulfilled')
        const rejected = settled.filter((r) => r.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RequestAlreadyFulfilledError)

        // The winner paid, the loser did not. Whichever way the race went, the
        // floats must total exactly one 200 debit.
        const floats = [await floatOf(first.id), await floatOf(second.id)]
        expect(floats.sort((x, y) => x - y)).toEqual([800, 1000])

        // And the player was credited exactly once.
        expect(await realBalanceOf(p.id)).toBe(200)
        expect(await prisma.transaction.count({ where: { userId: p.id, type: TransactionType.DEPOSIT } })).toBe(1)
        expect(await prisma.agentLedger.count({ where: { type: 'FULFILLMENT' } })).toBe(1)
    })

    it('refuses a code that has already been fulfilled, and says when', async () => {
        const p = await player()
        const agent = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '200')
        const done = await AgentDepositService.fulfill(request.code, agent.userId)

        const err = await AgentDepositService.fulfill(request.code, agent.userId).catch((e) => e)

        expect(err).toBeInstanceOf(RequestAlreadyFulfilledError)
        expect(err.fulfilledAt.getTime()).toBe(done.fulfilledAt.getTime())
        // Charged once, not twice.
        expect(await floatOf(agent.id)).toBe(800)
        expect(await realBalanceOf(p.id)).toBe(200)
    })

    it('refuses an expired code', async () => {
        const p = await player()
        const agent = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '200')
        const expiredAt = new Date(Date.now() - 1000)
        await prisma.agentDepositRequest.update({ where: { id: request.id }, data: { expiresAt: expiredAt } })

        const err = await AgentDepositService.fulfill(request.code, agent.userId).catch((e) => e)

        expect(err).toBeInstanceOf(RequestExpiredError)
        expect(err.expiredAt.getTime()).toBe(expiredAt.getTime())
        expect(await floatOf(agent.id)).toBe(1000)
        expect(await realBalanceOf(p.id)).toBe(0)
    })

    it('refuses a cancelled code', async () => {
        const p = await player()
        const agent = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '200')
        await AgentDepositService.cancelActiveRequest(p.id)

        await expect(AgentDepositService.fulfill(request.code, agent.userId)).rejects.toBeInstanceOf(
            RequestNotFoundError,
        )
        expect(await floatOf(agent.id)).toBe(1000)
        expect(await realBalanceOf(p.id)).toBe(0)
    })

    it('refuses a suspended agent', async () => {
        const p = await player()
        const agent = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '200')
        await prisma.user.update({ where: { id: agent.userId }, data: { accountStatus: 'SUSPENDED' } })

        await expect(AgentDepositService.fulfill(request.code, agent.userId)).rejects.toBeInstanceOf(
            AgentSuspendedError,
        )
        expect(await floatOf(agent.id)).toBe(1000)
        expect(await realBalanceOf(p.id)).toBe(0)
        // The code survives: the player can walk to another shop.
        expect(
            (await prisma.agentDepositRequest.findUniqueOrThrow({ where: { id: request.id } })).status,
        ).toBe('PENDING')
    })

    it('refuses an agent fulfilling a code on their own player account', async () => {
        const agent = await agentWithFloat(1000)
        // The agent's own login, used as a player: same user id on both sides.
        await prisma.wallet.create({ data: { userId: agent.userId, realBalance: 0 } })
        const request = await AgentDepositService.createRequest(agent.userId, '200')

        // Caught by the existing separation-of-duties rule inside
        // creditApprovedDepositInTx, because the fulfilment stamps the agent as the
        // reviewer of the deposit it is crediting.
        await expect(AgentDepositService.fulfill(request.code, agent.userId)).rejects.toThrow(
            'You cannot approve your own deposit',
        )

        expect(await floatOf(agent.id)).toBe(1000)
        expect(await realBalanceOf(agent.userId)).toBe(0)
        expect(await prisma.transaction.count()).toBe(0)
        expect(await prisma.agentLedger.count()).toBe(0)
    })
})

describe('AgentDepositService.fulfill - first-deposit incentives', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('grants the first-deposit bonus, exactly as a gateway deposit would', async () => {
        await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '100' } })
        const p = await player()
        const agent = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '200')

        await AgentDepositService.fulfill(request.code, agent.userId)

        expect(await firstDepositBonuses(p.id)).toBe(1)
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: p.id } })
        expect(Number(wallet.realBalance)).toBe(200)
        expect(Number(wallet.bonusBalance)).toBe(100)
    })

    it('REGRESSION: two players at the SAME shop both keep first-deposit eligibility', async () => {
        await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '100' } })
        const agent = await agentWithFloat(1000)
        const a = await player()
        const b = await player()

        const firstRequest = await AgentDepositService.createRequest(a.id, '200')
        await AgentDepositService.fulfill(firstRequest.code, agent.userId)
        const secondRequest = await AgentDepositService.createRequest(b.id, '200')
        await AgentDepositService.fulfill(secondRequest.code, agent.userId)

        // The trap this guards: stamping the agent into senderName/senderAccount
        // would make PayerIdentityService read every player after the first at this
        // shop as a shared payer, and silently withhold their bonus. Every player at
        // an agent legitimately pays through the same shop.
        expect(await firstDepositBonuses(a.id)).toBe(1)
        expect(await firstDepositBonuses(b.id)).toBe(1)
        expect(Number((await prisma.wallet.findUniqueOrThrow({ where: { userId: b.id } })).bonusBalance)).toBe(100)

        // And no shared-payer event was reported for either of them.
        expect(captureEvent.mock.calls.filter((c) => c[1] === 'first_deposit_shared_payer')).toHaveLength(0)

        expect(await floatOf(agent.id)).toBe(600)
    })

    it('still withholds the bonus on a genuine second deposit', async () => {
        await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '100' } })
        const p = await player()
        const agent = await agentWithFloat(1000)

        const one = await AgentDepositService.createRequest(p.id, '200')
        await AgentDepositService.fulfill(one.code, agent.userId)
        const two = await AgentDepositService.createRequest(p.id, '200')
        await AgentDepositService.fulfill(two.code, agent.userId)

        expect(await firstDepositBonuses(p.id)).toBe(1)
        expect(await realBalanceOf(p.id)).toBe(400)
        expect(await floatOf(agent.id)).toBe(600)
    })
})

describe('AgentService counters after a fulfilment', () => {
    afterEach(async () => {
        await expectInvariantClean()
    })

    it('reports the volume on the roster, the dashboard and the ledger summary', async () => {
        const p = await player()
        const agent = await agentWithFloat(1000)
        const request = await AgentDepositService.createRequest(p.id, '250')
        await AgentDepositService.fulfill(request.code, agent.userId)

        const { agents, summary } = await AgentService.listAgents()
        const row = agents.find((a) => a.id === agent.id)
        expect(row?.fulfilled7d).toBe('250.00')
        expect(row?.fulfilled7dCount).toBe(1)
        expect(summary.fulfilledTodayVolume).toBe('250.00')
        expect(summary.fulfilledTodayCount).toBe(1)
        expect(summary.floatOutstanding).toBe('750.00')

        const dashboard = await AgentService.getDashboard(agent.userId)
        expect(dashboard.float).toBe('750.00')
        expect(dashboard.today).toEqual({ count: 1, volume: '250.00' })
        expect(dashboard.limits).toEqual({ min: '50.00', max: '5000.00' })

        const ledger = await AgentService.getLedger(agent.id, {})
        expect(ledger.summary.fulfilled7d).toBe('250.00')
        expect(ledger.summary.deposits7d).toBe(1)
        expect(ledger.summary.float).toBe('750.00')

        const detail = await AgentService.getAgent(agent.id)
        expect(detail.stats.sold30d).toBe('250.00')
        expect(detail.stats.fulfilledCount30d).toBe(1)
        expect(detail.agent.userId).toBe(agent.userId)
    })
})
