/**
 * Agent network administration, mounted at `/admin/agents`.
 *
 * Registered inside the admin plugin's `requireAdmin` scope in ./index.ts, so
 * ADMIN and SUPER_ADMIN both reach it and there is no auth hook here. That is
 * deliberate: issuing float is a daily counter operation, not a privileged
 * one-off, and gating it behind SUPER_ADMIN would make the one account an
 * admin cannot re-create the bottleneck for routine work.
 *
 * Business logic lives in AgentService; this file is validation and status
 * mapping.
 */

import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AccountStatusService, STATUS_CATEGORIES } from '../../services/account-status.service.js'
import {
    AgentNotFoundError,
    AgentService,
    InsufficientFloatError,
    UsernameTakenError,
} from '../../services/agent.service'

/**
 * Money on the wire is a decimal string or a number. Validate the shape here
 * and hand the service the value the caller actually sent, so the Decimal it
 * builds comes from those digits rather than from a float round trip.
 */
const money = z
    .union([z.number(), z.string()])
    .refine((value) => {
        const n = typeof value === 'number' ? value : Number(String(value).trim())
        return Number.isFinite(n) && n > 0
    }, 'Must be a positive amount')
    .transform((value) => (typeof value === 'number' ? value : String(value).trim()))

const createSchema = z.object({
    username: z.string().trim().min(3).max(32),
    password: z.string().min(8),
    shopName: z.string().trim().min(1).max(120),
})

const updateSchema = z.object({
    shopName: z.string().trim().min(1).max(120),
})

const settingsSchema = z
    .object({
        // Units are the service's business; the route only refuses nonsense.
        commissionRate: z.coerce.number().min(0).max(100),
        depositMin: money,
        depositMax: money,
    })
    .refine(
        (value) => Number(value.depositMin) <= Number(value.depositMax),
        { message: 'depositMin must not be greater than depositMax', path: ['depositMin'] },
    )

const floatSchema = z.object({
    direction: z.enum(['CREDIT', 'DEBIT']),
    /** What the operator was actually paid. Commission is added on top of it. */
    cashReceived: money,
    commissionAmount: money.optional(),
    note: z.string().trim().max(500).optional(),
})

const statusSchema = z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    reason: z.string().trim().min(3, 'A reason of at least 3 characters is required'),
    category: z.enum(STATUS_CATEGORIES).optional(),
})

function badRequest(reply: any, error: z.ZodError) {
    return reply.status(400).send({ error: error.issues[0].message, details: error.issues })
}

const agentAdminRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/', async () => AgentService.listAgents())

    fastify.post('/', async (req: any, reply) => {
        const parsed = createSchema.safeParse(req.body)
        if (!parsed.success) return badRequest(reply, parsed.error)
        // Spelled out rather than spread: this package compiles with
        // `strict: false`, under which zod infers every object key as optional
        // and a spread stops satisfying a required-field signature.
        const { username, password, shopName } = parsed.data
        try {
            const agent = await AgentService.createAgent({ username, password, shopName })
            return reply.status(201).send(agent)
        } catch (err) {
            if (err instanceof UsernameTakenError) {
                return reply.status(409).send({ error: err.message || 'Username already taken' })
            }
            throw err
        }
    })

    // Registered ahead of `/:id` so the literal path is never swallowed by the
    // parameterised one and read as an agent with the id "settings".
    fastify.get('/settings', async () => AgentService.getSettings())

    fastify.put('/settings', async (req: any, reply) => {
        const parsed = settingsSchema.safeParse(req.body)
        if (!parsed.success) return badRequest(reply, parsed.error)
        return AgentService.updateSettings(parsed.data, req.user.id)
    })

    fastify.get('/:id', async (req: any, reply) => {
        try {
            return await AgentService.getAgent(req.params.id)
        } catch (err) {
            if (err instanceof AgentNotFoundError) {
                return reply.status(404).send({ error: 'Agent not found' })
            }
            throw err
        }
    })

    fastify.patch('/:id', async (req: any, reply) => {
        const parsed = updateSchema.safeParse(req.body)
        if (!parsed.success) return badRequest(reply, parsed.error)
        try {
            return await AgentService.updateAgent(req.params.id, { shopName: parsed.data.shopName })
        } catch (err) {
            if (err instanceof AgentNotFoundError) {
                return reply.status(404).send({ error: 'Agent not found' })
            }
            throw err
        }
    })

    /**
     * Issue or claw back float. The cash moved off-platform before this call:
     * this only records the credit the operator is issuing against it, so a
     * DEBIT that would take the float below zero is refused rather than
     * clamped.
     */
    fastify.post('/:id/float', async (req: any, reply) => {
        const parsed = floatSchema.safeParse(req.body)
        if (!parsed.success) return badRequest(reply, parsed.error)
        const { direction, cashReceived, commissionAmount, note } = parsed.data
        try {
            return await AgentService.adjustFloat({
                agentId: req.params.id,
                direction,
                cashReceived,
                commissionAmount,
                note,
                actorId: req.user.id,
            })
        } catch (err) {
            if (err instanceof InsufficientFloatError) {
                return reply
                    .status(422)
                    .send({ error: 'INSUFFICIENT_FLOAT', float: err.float, required: err.required })
            }
            if (err instanceof AgentNotFoundError) {
                return reply.status(404).send({ error: 'Agent not found' })
            }
            throw err
        }
    })

    /**
     * Suspend or reinstate the agent's login. Delegated to AccountStatusService
     * exactly as the player routes in ./index.ts do, so a disabled agent is one
     * more row in the same audited status history rather than a second, parallel
     * notion of "switched off". The service keys on the USER id, not the agent
     * id, so the agent record is resolved first.
     */
    fastify.post('/:id/status', async (req: any, reply) => {
        const parsed = statusSchema.safeParse(req.body)
        if (!parsed.success) return badRequest(reply, parsed.error)

        let userId: string
        try {
            // getAgent answers with a detail envelope, { agent, stats, ledger };
            // the flat fallback keeps this working if that ever unwraps.
            const detail: any = await AgentService.getAgent(req.params.id)
            const resolved = detail?.agent?.userId ?? detail?.userId
            if (!resolved) return reply.status(404).send({ error: 'Agent not found' })
            userId = resolved
        } catch (err) {
            if (err instanceof AgentNotFoundError) {
                return reply.status(404).send({ error: 'Agent not found' })
            }
            throw err
        }

        try {
            if (parsed.data.status === 'SUSPENDED') {
                return await AccountStatusService.suspend(userId, {
                    reason: parsed.data.reason,
                    category: parsed.data.category ?? null,
                    actorId: req.user.id,
                })
            }
            return await AccountStatusService.reinstate(userId, {
                reason: parsed.data.reason,
                actorId: req.user.id,
            })
        } catch (err: any) {
            return reply.status(err?.statusCode ?? 500).send({ error: err?.message, code: err?.code })
        }
    })
}

export default agentAdminRoutes
