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

        // Log every command's payload and the result we return, so Palace's
        // dashboard test failures (e.g. 1015 CALLBACK_ERROR) can be matched to the
        // exact request/response on our side.
        const respond = (payload: { result: number; status: string; data: object | null }) => {
          req.log.info(
            { command, data: d, result: payload.result, status: payload.status },
            '[Palace] callback handled',
          )
          return reply.status(200).send(payload)
        }

        switch (command) {
          case 'authenticate':
            return respond({ result: 0, status: 'OK', data: { account: d.account } })

          case 'balance':
            return respond(await PalaceWalletService.getBalance(d.account))

          case 'bet':
            return respond(
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
            return respond(
              await PalaceWalletService.processWin({
                trans_guid: d.trans_guid,
                account: d.account,
                gplay_id: d.gplay_id,
                round_id: d.round_id,
                game_code: d.game_code,
                amount: d.amount,
                type: d.type ?? 2,
              }),
            )

          case 'cancel':
            return respond(
              await PalaceWalletService.processCancel({
                trans_guid: d.trans_guid,
                account: d.account,
                gplay_id: d.gplay_id,
                round_id: d.round_id,
                game_code: d.game_code,
                amount: d.amount ?? 0,
                // Palace sends the correctly-spelled `cancel_trans_guid`; keep the
                // legacy misspelling as a fallback for safety.
                cancle_trans_guid: d.cancel_trans_guid ?? d.cancle_trans_guid,
              }),
            )

          case 'status':
            return respond(await PalaceWalletService.getStatus(d.account, d.trans_guid ?? d.trans_id ?? ''))

          default:
            return respond({ result: 1006, status: 'COMMAND_NOT_FOUND', data: null })
        }
      } catch (err) {
        // Log the command + payload (not just the error) so we can see exactly which
        // fields Palace sent — essential for diagnosing missing/renamed keys.
        const body = req.body as { command?: string; data?: Record<string, any> }
        req.log.error(
          { err, command: body?.command, dataKeys: body?.data ? Object.keys(body.data) : [], data: body?.data },
          '[Palace] Unhandled error in callback handler',
        )
        return reply.status(200).send({ result: 1001, status: 'INTERNAL_SERVER_ERROR', data: null })
      }
    },
  })
}
