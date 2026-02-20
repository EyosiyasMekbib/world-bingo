import { FastifyPluginAsync } from 'fastify'
import { DepositSchema } from '@world-bingo/shared-types'
import { WalletController } from '../../controllers/wallet.controller'

const walletRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preValidation', fastify.authenticate)

    fastify.get('/', {
        handler: WalletController.getBalance,
    })

    fastify.post('/deposit', {
        schema: {
            body: DepositSchema,
        },
        handler: WalletController.deposit,
    })
}

export default walletRoutes
