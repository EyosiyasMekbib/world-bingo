import { FastifyPluginAsync } from 'fastify'
import { CheckoutSessionSchema, ClaimCheckoutSchema, DepositSchema, WithdrawalSchema } from '@world-bingo/shared-types'
import { WalletController } from '../../controllers/wallet.controller'
import zodToJsonSchema from 'zod-to-json-schema'

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
}

export default walletRoutes

