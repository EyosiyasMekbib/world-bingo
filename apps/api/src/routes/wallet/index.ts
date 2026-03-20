import { FastifyPluginAsync } from 'fastify'
import { DepositSchema, WithdrawalSchema } from '@world-bingo/shared-types'
import { WalletController } from '../../controllers/wallet.controller'
import zodToJsonSchema from 'zod-to-json-schema'

const walletRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preValidation', fastify.authenticate)

    fastify.get('/', {
        handler: WalletController.getBalance,
    })

    // T16: Accept both multipart/form-data (with receipt file) and JSON body
    fastify.post('/deposit', {
        handler: WalletController.deposit,
    })

    fastify.post('/withdraw', {
        schema: {
            body: zodToJsonSchema(WithdrawalSchema),
        },
        handler: WalletController.withdraw,
    })

    fastify.get('/transactions', {
        handler: WalletController.getTransactions,
    })

    fastify.get('/stats', { handler: WalletController.getStats })
}

export default walletRoutes

