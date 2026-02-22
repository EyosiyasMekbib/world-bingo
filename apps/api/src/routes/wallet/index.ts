import { FastifyPluginAsync } from 'fastify'
import { DepositSchema, WithdrawalSchema } from '@world-bingo/shared-types'
import { WalletController } from '../../controllers/wallet.controller'
import zodToJsonSchema from 'zod-to-json-schema'

const walletRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preValidation', fastify.authenticate)

    fastify.get('/', {
        handler: WalletController.getBalance,
    })

    fastify.post('/deposit', {
        schema: {
            body: zodToJsonSchema(DepositSchema),
        },
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
}

export default walletRoutes

