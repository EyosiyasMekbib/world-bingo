/**
 * The cash agent's own API, mounted at `/agent`.
 *
 * An agent is a shop holding prepaid float. A player generates a six-digit
 * deposit code, the agent types it in, takes the cash across the counter and
 * confirms; that single commit debits the agent's float and credits the
 * player's wallet. Any agent may fulfil any code and the first to confirm
 * wins, so every refusal below is a race the loser has to be told about
 * precisely — "already fulfilled" and "expired" are different apologies.
 *
 * All business logic lives in the services. This file is auth, validation,
 * rate limiting and the error-to-status mapping the counter screen reads.
 */

import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { UserRole } from '@world-bingo/shared-types'
import { rateLimitKey } from '../../lib/rate-limit-key'
import { AgentNotFoundError, AgentService, InsufficientFloatError } from '../../services/agent.service'
import {
    AgentDepositService,
    AgentSuspendedError,
    RequestAlreadyFulfilledError,
    RequestExpiredError,
    RequestNotFoundError,
} from '../../services/agent-deposit.service'

/**
 * A deposit code is exactly six digits and nothing else.
 *
 * Anything that does not match is answered with the SAME 404 an unknown code
 * gets, deliberately, rather than a 400. A 400 would tell a caller probing the
 * endpoint which strings are even worth trying, which is one bit of help more
 * than a bearer token for cash should ever give away.
 */
const CODE_PATTERN = /^\d{6}$/

const LEDGER_TYPES = ['TOP_UP', 'COMMISSION', 'FULFILLMENT', 'ADJUSTMENT'] as const

/** A calendar day from a `<input type="date">`, or any parseable timestamp. */
const dateInput = z
    .string()
    .trim()
    .min(1)
    .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Not a valid date')
    .transform((value) => new Date(value))

const ledgerQuerySchema = z.object({
    from: dateInput.optional(),
    to: dateInput.optional(),
    // The history screen sends `type=` when the filter is cleared.
    type: z
        .union([z.enum(LEDGER_TYPES), z.literal('')])
        .optional()
        .transform((value) => (value === '' ? undefined : value)),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
})

/**
 * The refusals the counter screen has to explain, each with its own status so
 * a proxy that mangles the body still leaves the agent with a usable answer.
 * Returns null for anything unrecognised, which the caller rethrows into the
 * server's normal error handler rather than swallowing as a 4xx.
 */
function mapAgentError(err: unknown): { status: number; body: Record<string, unknown> } | null {
    if (err instanceof RequestNotFoundError) {
        return { status: 404, body: { error: 'NOT_FOUND' } }
    }
    if (err instanceof RequestAlreadyFulfilledError) {
        return { status: 409, body: { error: 'ALREADY_FULFILLED', fulfilledAt: err.fulfilledAt } }
    }
    if (err instanceof RequestExpiredError) {
        return { status: 410, body: { error: 'EXPIRED', expiredAt: err.expiredAt } }
    }
    if (err instanceof InsufficientFloatError) {
        return { status: 422, body: { error: 'INSUFFICIENT_FLOAT', float: err.float, required: err.required } }
    }
    if (err instanceof AgentSuspendedError) {
        return { status: 403, body: { error: 'SUSPENDED' } }
    }
    return null
}

/**
 * Per-agent budget on the two endpoints that take a code.
 *
 * Six digits is a million-wide space, but only a handful of codes are live at
 * any moment and each one is worth real money, so an unthrottled lookup is a
 * guessing oracle with a cash prize. Fulfil is throttled just as tightly
 * because its 404 answers exactly the same question as a lookup's.
 *
 * `hook: 'preValidation'` because the default `onRequest` phase runs before
 * this plugin's `authenticate` hook, where `request.user` does not exist yet
 * and every agent behind one shop's connection would share an IP bucket. The
 * key is namespaced so it never collides with the global per-user limiter.
 */
function codeRateLimit(max: number) {
    return {
        max,
        timeWindow: '1 minute',
        hook: 'preValidation' as const,
        keyGenerator: (req: any) => `agent-code:${rateLimitKey({ userId: req.user?.id, ip: req.ip })}`,
    }
}

const agentRoutes: FastifyPluginAsync = async (fastify) => {
    /**
     * Agent-only, in three steps: a verified token, an ACTIVE account, then the
     * role itself. Shaped like the `requireAdmin` / `requireAdminOrClerk`
     * decorators in index.ts but kept local, because it guards exactly this
     * prefix. `authenticate` has already verified the token and populated
     * `request.user` by the time this runs.
     */
    const requireAgent = async (request: any, reply: any) => {
        if (request.user?.role !== UserRole.AGENT) {
            return reply.status(403).send({ error: 'Forbidden: Agent access only' })
        }
    }

    fastify.addHook('preValidation', fastify.authenticate)
    fastify.addHook('preValidation', fastify.requireActiveAccount)
    fastify.addHook('preValidation', requireAgent)

    /** Shop name, float, today's counter activity and the deposit limits. */
    fastify.get('/me', async (req: any, reply) => {
        try {
            return await AgentService.getDashboard(req.user.id)
        } catch (err) {
            if (err instanceof AgentNotFoundError) {
                return reply.status(404).send({ error: 'NOT_FOUND' })
            }
            throw err
        }
    })

    /**
     * What the agent sees before taking the cash: the amount, and enough of the
     * player's identity to check they are talking to the right person. The
     * service masks the name and phone; nothing here unmasks them.
     */
    fastify.get('/requests/:code', {
        config: { rateLimit: codeRateLimit(20) },
    }, async (req: any, reply) => {
        const code = String(req.params.code ?? '')
        if (!CODE_PATTERN.test(code)) {
            return reply.status(404).send({ error: 'NOT_FOUND' })
        }
        try {
            return await AgentDepositService.lookupByCode(code)
        } catch (err) {
            const mapped = mapAgentError(err)
            if (!mapped) throw err
            return reply.status(mapped.status).send(mapped.body)
        }
    })

    /** Cash is now in the drawer. One commit: float down, player balance up. */
    fastify.post('/requests/:code/fulfill', {
        config: { rateLimit: codeRateLimit(10) },
    }, async (req: any, reply) => {
        const code = String(req.params.code ?? '')
        if (!CODE_PATTERN.test(code)) {
            return reply.status(404).send({ error: 'NOT_FOUND' })
        }
        try {
            return await AgentDepositService.fulfill(code, req.user.id)
        } catch (err) {
            const mapped = mapAgentError(err)
            if (!mapped) throw err
            return reply.status(mapped.status).send(mapped.body)
        }
    })

    /** Every movement in and out of this agent's float, filtered and paged. */
    fastify.get('/ledger', async (req: any, reply) => {
        const parsed = ledgerQuerySchema.safeParse(req.query ?? {})
        if (!parsed.success) {
            return reply.status(400).send({ error: parsed.error.issues[0].message })
        }
        try {
            const agent: any = await AgentService.getAgentByUserId(req.user.id)
            if (!agent?.id) return reply.status(404).send({ error: 'NOT_FOUND' })
            return await AgentService.getLedger(agent.id, parsed.data)
        } catch (err) {
            if (err instanceof AgentNotFoundError) {
                return reply.status(404).send({ error: 'NOT_FOUND' })
            }
            throw err
        }
    })
}

export default agentRoutes
