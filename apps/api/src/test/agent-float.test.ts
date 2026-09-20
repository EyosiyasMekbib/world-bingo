import { describe, it, expect, beforeEach, vi } from 'vitest'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import {
    AgentNotFoundError,
    AgentService,
    InsufficientFloatError,
    UsernameTakenError,
} from '../services/agent.service'
import { prisma } from './setup'
import { UserRole } from '@world-bingo/shared-types'

let seq = 0

/** An operator issuing float. Only the id is ever used. */
async function operator(): Promise<string> {
    seq++
    const user = await prisma.user.create({
        data: { username: `ops-${seq}`, passwordHash: 'x', role: UserRole.ADMIN },
    })
    return user.id
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

const ledgerOf = (agentId: string) =>
    prisma.agentLedger.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } })

describe('AgentService.createAgent', () => {
    it('creates an AGENT-role login and its agent row together', async () => {
        const agent = await AgentService.createAgent({
            username: 'kebede-shop',
            password: 'a-long-enough-password',
            shopName: 'Kebede Kiosk',
        })

        expect(agent.shopName).toBe('Kebede Kiosk')
        expect(Number(agent.float)).toBe(0)

        const user = await prisma.user.findUniqueOrThrow({ where: { id: agent.userId } })
        expect(user.role).toBe(UserRole.AGENT)
        expect(user.username).toBe('kebede-shop')
        // Never the plaintext. setup.ts mocks bcrypt as `hashed:<password>`.
        expect(user.passwordHash).toBe('hashed:a-long-enough-password')
    })

    it('refuses a username that is already taken', async () => {
        await prisma.user.create({ data: { username: 'taken', passwordHash: 'x' } })

        await expect(
            AgentService.createAgent({ username: 'taken', password: 'a-long-enough-password', shopName: 'Shop' }),
        ).rejects.toBeInstanceOf(UsernameTakenError)

        // The failed create must not leave a half-built agent behind.
        expect(await prisma.agent.count()).toBe(0)
    })
})

describe('AgentService.adjustFloat - commission', () => {
    it('computes the commission from agent_commission_rate when none is supplied', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(0)

        // Default rate is 5 percent when the setting row is absent.
        const result = await AgentService.adjustFloat({
            agentId: agent.id,
            direction: 'CREDIT',
            cashReceived: '1000',
            actorId,
        })

        expect(result.floatAfter).toBe('1050.00')
        expect(await floatOf(agent.id)).toBe(1050)

        const rows = await ledgerOf(agent.id)
        expect(rows.map((r) => r.type)).toEqual(['TOP_UP', 'COMMISSION'])
        expect(Number(rows[0].amount)).toBe(1000)
        expect(Number(rows[0].balanceBefore)).toBe(0)
        expect(Number(rows[0].balanceAfter)).toBe(1000)
        expect(Number(rows[1].amount)).toBe(50)
        // The second row picks up where the first left off, so the ledger reads as
        // one unbroken chain rather than two independent snapshots.
        expect(Number(rows[1].balanceBefore)).toBe(1000)
        expect(Number(rows[1].balanceAfter)).toBe(1050)
    })

    it('uses a configured rate, including a fractional one', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(0)
        await prisma.siteSetting.create({ data: { key: 'agent_commission_rate', value: '7.5' } })

        const result = await AgentService.adjustFloat({
            agentId: agent.id,
            direction: 'CREDIT',
            cashReceived: '1000',
            actorId,
        })

        expect(result.floatAfter).toBe('1075.00')
        const rows = await ledgerOf(agent.id)
        expect(Number(rows[1].amount)).toBe(75)
    })

    it('uses an explicitly supplied commission verbatim, overriding the rate', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(0)
        await prisma.siteSetting.create({ data: { key: 'agent_commission_rate', value: '5' } })

        // A one-off deal: the operator's figure wins, not the standing rate's 50.
        const result = await AgentService.adjustFloat({
            agentId: agent.id,
            direction: 'CREDIT',
            cashReceived: '1000',
            commissionAmount: '123.45',
            actorId,
        })

        expect(result.floatAfter).toBe('1123.45')
        const rows = await ledgerOf(agent.id)
        expect(Number(rows[1].amount)).toBe(123.45)
    })

    it('writes no COMMISSION row when the supplied commission is zero', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(0)

        const result = await AgentService.adjustFloat({
            agentId: agent.id,
            direction: 'CREDIT',
            cashReceived: '500',
            commissionAmount: '0',
            actorId,
        })

        expect(result.floatAfter).toBe('500.00')
        expect(result.entries).toHaveLength(1)
        const rows = await ledgerOf(agent.id)
        expect(rows.map((r) => r.type)).toEqual(['TOP_UP'])
    })

    it('records the movement in the audit log', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(0)

        await AgentService.adjustFloat({
            agentId: agent.id,
            direction: 'CREDIT',
            cashReceived: '200',
            note: 'Monday drop',
            actorId,
            actorName: 'Ops One',
        })

        const log = await prisma.auditLog.findFirstOrThrow({ where: { target: `agent:${agent.id}` } })
        expect(log.action).toBe('agent.float_credit')
        expect(log.actorId).toBe(actorId)
        expect(log.actorName).toBe('Ops One')
        expect(log.detail).toMatchObject({ cashReceived: '200.00', floatBefore: '0.00', floatAfter: '210.00' })
    })
})

describe('AgentService.adjustFloat - DEBIT never goes below zero', () => {
    it('refuses a debit larger than the float rather than clamping it', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(300)

        await expect(
            AgentService.adjustFloat({ agentId: agent.id, direction: 'DEBIT', cashReceived: '500', actorId }),
        ).rejects.toBeInstanceOf(InsufficientFloatError)

        // Refused, not clamped to zero: the float is untouched and no row was written.
        expect(await floatOf(agent.id)).toBe(300)
        expect(await ledgerOf(agent.id)).toHaveLength(0)
    })

    it('carries the float it has and the amount it needed, as strings', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(300)

        const err = await AgentService.adjustFloat({
            agentId: agent.id,
            direction: 'DEBIT',
            cashReceived: '500',
            actorId,
        }).catch((e) => e)

        expect(err).toBeInstanceOf(InsufficientFloatError)
        expect(err.float).toBe('300.00')
        expect(err.required).toBe('500.00')
    })

    it('allows a debit down to exactly zero', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(300)

        const result = await AgentService.adjustFloat({
            agentId: agent.id,
            direction: 'DEBIT',
            cashReceived: '300',
            actorId,
        })

        expect(result.floatAfter).toBe('0.00')
        expect(await floatOf(agent.id)).toBe(0)

        const rows = await ledgerOf(agent.id)
        expect(rows).toHaveLength(1)
        expect(rows[0].type).toBe('ADJUSTMENT')
        // Signed, so the ledger sums to the balance without needing the type.
        expect(Number(rows[0].amount)).toBe(-300)
        expect(Number(rows[0].balanceBefore)).toBe(300)
        expect(Number(rows[0].balanceAfter)).toBe(0)
    })

    it('never pays a commission on a debit', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(1000)

        await AgentService.adjustFloat({ agentId: agent.id, direction: 'DEBIT', cashReceived: '100', actorId })

        const rows = await ledgerOf(agent.id)
        expect(rows.map((r) => r.type)).toEqual(['ADJUSTMENT'])
        expect(await floatOf(agent.id)).toBe(900)
    })

    it('refuses an unknown agent', async () => {
        const actorId = await operator()
        await expect(
            AgentService.adjustFloat({
                agentId: '00000000-0000-0000-0000-000000000000',
                direction: 'CREDIT',
                cashReceived: '100',
                actorId,
            }),
        ).rejects.toBeInstanceOf(AgentNotFoundError)
    })
})

describe('AgentService.getSettings / updateSettings', () => {
    it('falls back to the documented defaults when no rows exist', async () => {
        expect(await AgentService.getSettings()).toEqual({
            commissionRate: 5,
            depositMin: '50.00',
            depositMax: '5000.00',
            codeTtlSeconds: 900,
        })
    })

    it('writes only the supplied keys and answers with the full set', async () => {
        const actorId = await operator()

        const updated = await AgentService.updateSettings({ commissionRate: 8, depositMax: '9000' }, actorId)

        expect(updated).toEqual({
            commissionRate: 8,
            depositMin: '50.00',
            depositMax: '9000.00',
            codeTtlSeconds: 900,
        })
        // Scoped by actor: cleanDb does not truncate audit_logs, so an unscoped
        // lookup here would pick up another suite's row.
        const log = await prisma.auditLog.findFirstOrThrow({
            where: { action: 'agent.settings_updated', actorId },
        })
        expect(log.detail).toMatchObject({ agent_commission_rate: '8', agent_deposit_max: '9000.00' })
    })

    it('ignores an unparseable stored value rather than widening a limit', async () => {
        await prisma.siteSetting.create({ data: { key: 'agent_deposit_max', value: 'not-a-number' } })
        expect((await AgentService.getSettings()).depositMax).toBe('5000.00')
    })
})

describe('AgentService.listAgents / getLedger', () => {
    beforeEach(async () => {
        seq = 0
    })

    it('summarises float outstanding and head count across the network', async () => {
        const a = await agentWithFloat(1000)
        const b = await agentWithFloat(250)
        await prisma.user.update({ where: { id: b.userId }, data: { accountStatus: 'SUSPENDED' } })

        const { agents, summary } = await AgentService.listAgents()

        expect(summary.totalCount).toBe(2)
        expect(summary.activeCount).toBe(1)
        expect(summary.floatOutstanding).toBe('1250.00')
        expect(agents.find((x) => x.id === a.id)?.float).toBe('1000.00')
        // Volume, not a count, and zero before any fulfilment.
        expect(agents.find((x) => x.id === a.id)?.fulfilled7d).toBe('0.00')
        expect(agents.find((x) => x.id === a.id)?.fulfilled7dCount).toBe(0)
    })

    it('reports the last top-up time per agent', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(0)
        await AgentService.adjustFloat({ agentId: agent.id, direction: 'CREDIT', cashReceived: '100', actorId })

        const { agents } = await AgentService.listAgents()
        expect(agents[0].lastTopUpAt).toBeInstanceOf(Date)
    })

    it('pages the ledger and keeps the summary unscoped by the filters', async () => {
        const actorId = await operator()
        const agent = await agentWithFloat(0)
        await AgentService.adjustFloat({ agentId: agent.id, direction: 'CREDIT', cashReceived: '1000', actorId })
        await AgentService.adjustFloat({ agentId: agent.id, direction: 'DEBIT', cashReceived: '100', actorId })

        const all = await AgentService.getLedger(agent.id, {})
        expect(all.total).toBe(3)
        expect(all.rows).toHaveLength(3)
        // TOP_UP 1000 + COMMISSION 50, the DEBIT is not a top-up.
        expect(all.summary.toppedUp7d).toBe('1050.00')
        expect(all.summary.float).toBe('950.00')
        expect(all.summary.fulfilled7d).toBe('0.00')
        expect(all.summary.deposits7d).toBe(0)

        const filtered = await AgentService.getLedger(agent.id, { type: 'ADJUSTMENT' })
        expect(filtered.total).toBe(1)
        expect(filtered.rows[0].type).toBe('ADJUSTMENT')
        // The context strip stays put while the operator filters underneath it.
        expect(filtered.summary.toppedUp7d).toBe('1050.00')

        const paged = await AgentService.getLedger(agent.id, { page: 2, pageSize: 2 })
        expect(paged.rows).toHaveLength(1)
        expect(paged.total).toBe(3)
    })

    it('refuses an unknown agent', async () => {
        await expect(
            AgentService.getLedger('00000000-0000-0000-0000-000000000000', {}),
        ).rejects.toBeInstanceOf(AgentNotFoundError)
    })
})
