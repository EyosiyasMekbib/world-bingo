import { FastifyPluginAsync } from 'fastify'
import { CheckoutSessionSchema, ClaimCheckoutSchema, DepositSchema, WithdrawalSchema } from '@world-bingo/shared-types'
import { WalletController } from '../../controllers/wallet.controller'
import zodToJsonSchema from 'zod-to-json-schema'
import { z } from 'zod'
import { AgentService } from '../../services/agent.service'
import { AgentDepositService, AmountOutOfRangeError } from '../../services/agent-deposit.service'

/**
 * Cash-agent deposits, the player's half.
 *
 * The player names an amount and gets a six-digit code; they hand cash to an
 * agent, who types the code in and confirms. Nothing here moves money. The
 * credit happens on the agent's side of the counter, in `/agent`.
 *
 * Money on the wire is a decimal string or a number. The shape is validated
 * here and the caller's own value is passed on, so the Decimal the service
 * builds comes from the digits that were sent rather than a float round trip.
 */
const agentDepositRequestSchema = z.object({
    amount: z
        .union([z.number(), z.string()])
        .refine((value) => {
            const n = typeof value === 'number' ? value : Number(String(value).trim())
            return Number.isFinite(n) && n > 0
        }, 'Amount must be a positive number')
        .transform((value) => (typeof value === 'number' ? value : String(value).trim())),
})

const walletRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preValidation', fastify.authenticate)

    fastify.get('/', {
        handler: WalletController.getBalance,
    })

    // T16: Accept both multipart/form-data (with receipt file) and JSON body
    fastify.post('/deposit', {
        preHandler: fastify.requireActiveAccount,
        handler: WalletController.deposit,
    })

    fastify.post('/deposit/checkout', {
        preHandler: fastify.requireActiveAccount,
        schema: {
            body: zodToJsonSchema(CheckoutSessionSchema),
        },
        handler: WalletController.createCheckoutSession,
    })

    fastify.post('/deposit/checkout/claim', {
        preHandler: fastify.requireActiveAccount,
        schema: {
            body: zodToJsonSchema(ClaimCheckoutSchema),
        },
        handler: WalletController.claimCheckoutDeposit,
    })

    fastify.post('/withdraw', {
        preHandler: fastify.requireActiveAccount,
        schema: {
            body: zodToJsonSchema(WithdrawalSchema),
        },
        handler: WalletController.withdraw,
    })

    fastify.get('/transactions', {
        handler: WalletController.getTransactions,
    })

    fastify.get('/stats', { handler: WalletController.getStats })

    fastify.patch('/spend-account', {
        handler: WalletController.setSpendAccount,
    })

    fastify.get('/bonus-grants', {
        handler: WalletController.getBonusGrants,
    })

    // ── Cash agent deposits ───────────────────────────────────────────────────

    /** What the card needs before it can ask for an amount. */
    fastify.get('/agent-deposit/limits', {
        preHandler: fastify.requireActiveAccount,
        handler: async () => {
            const settings = await AgentService.getSettings()
            return {
                min: settings.depositMin,
                max: settings.depositMax,
                ttlSeconds: settings.codeTtlSeconds,
            }
        },
    })

    /** The player's live code, or null. A player holds at most one at a time. */
    fastify.get('/agent-deposit/active', {
        preHandler: fastify.requireActiveAccount,
        handler: async (req: any, reply) => {
            const active = await AgentDepositService.getActiveRequest(req.user.id)
            return reply.send(active ?? null)
        },
    })

    fastify.post('/agent-deposit/request', {
        preHandler: fastify.requireActiveAccount,
        handler: async (req: any, reply) => {
            const parsed = agentDepositRequestSchema.safeParse(req.body)
            if (!parsed.success) {
                return reply.status(400).send({ error: parsed.error.issues[0].message })
            }
            try {
                const created = await AgentDepositService.createRequest(req.user.id, parsed.data.amount)
                return reply.status(201).send(created)
            } catch (err) {
                // The limits are configurable, so the refusal has to name the
                // ones in force rather than repeat a number baked into the app.
                if (err instanceof AmountOutOfRangeError) {
                    return reply
                        .status(400)
                        .send({ error: `Amount must be between ${err.min} and ${err.max}`, min: err.min, max: err.max })
                }
                throw err
            }
        },
    })

    /** Player walked away from the counter. Idempotent: no live code is fine. */
    fastify.delete('/agent-deposit/active', {
        preHandler: fastify.requireActiveAccount,
        handler: async (req: any) => {
            await AgentDepositService.cancelActiveRequest(req.user.id)
            return { success: true }
        },
    })
}

export default walletRoutes

