import type { FastifyPluginAsync } from 'fastify'
import { verifyPalaceCallbackToken } from '../../gateways/game-provider/palace-callback.middleware.js'
import { PalaceWalletService } from '../../services/palace-wallet.service.js'

/**
 * Palace Casino wallet callback route.
 * Mounted under /v1/palace/callback (configured in index.ts).
 * All responses are HTTP 200 — Palace interprets non-200 as a network failure.
 * No JWT auth — validated via Callback-Token header instead.
 *
 * Palace sends: { command: string, data: { ... } }
 * We respond: { result: number, status: string, data: object | null }
 */
export const palaceCallbackRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', {
    preHandler: [verifyPalaceCallbackToken],
    handler: async (req, reply) => {
      try {
        const body = req.body as {
          command: string
          data: Record<string, any>
        }

        const { command, data: d } = body

        switch (command) {
          case 'authenticate':
            return reply.status(200).send({
              result: 0,
              status: 'OK',
              data: { account: d.account },
            })

          case 'balance':
            return reply.status(200).send(await PalaceWalletService.getBalance(d.account))

          case 'bet':
            return reply.status(200).send(
              await PalaceWalletService.processBet({
                trans_guid: d.trans_guid,
                account: d.account,
                gplay_id: d.gplay_id,
                round_id: d.round_id,
                game_code: d.game_code,
                amount: d.amount,
              }),
            )

          case 'win':
            return reply.status(200).send(
              await PalaceWalletService.processWin({
                trans_guid: d.trans_guid,
                account: d.account,
                gplay_id: d.gplay_id,
                round_id: d.round_id,
                game_code: d.game_code,
                amount: d.amount,
                type: d.type,
              }),
            )

          case 'cancel':
            return reply.status(200).send(
              await PalaceWalletService.processCancel({
                trans_guid: d.trans_guid,
                account: d.account,
                gplay_id: d.gplay_id,
                round_id: d.round_id,
                game_code: d.game_code,
                amount: d.amount ?? 0,
                cancle_trans_guid: d.cancle_trans_guid,
              }),
            )

          case 'status':
            return reply.status(200).send(
              await PalaceWalletService.getStatus(d.account, d.trans_guid ?? ''),
            )

          default:
            return reply.status(200).send({ result: 1006, status: 'COMMAND_NOT_FOUND', data: null })
        }
      } catch (err) {
        req.log.error(err, '[Palace] Unhandled error in callback handler')
        return reply.status(200).send({ result: 1001, status: 'INTERNAL_SERVER_ERROR', data: null })
      }
    },
  })
}
