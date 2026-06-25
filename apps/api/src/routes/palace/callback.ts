import type { FastifyPluginAsync } from 'fastify'
import { verifyPalaceCallbackToken } from '../../gateways/game-provider/palace-callback.middleware.js'
import { PalaceWalletService } from '../../services/palace-wallet.service.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { decideCallbackRoute } from '../../gateways/hub/route-callback.js'
import { signBody, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'

/**
 * Palace Casino wallet callback route.
 * Mounted under /v1/palace/callback (configured in index.ts).
 * All responses are HTTP 200 — Palace interprets non-200 as a network failure.
 * No JWT auth — validated via Callback-Token header instead.
 *
 * Palace sends: { command: string, data: { ... } }
 * We respond: { result: number, status: string, data: object | null }
 */
// Palace's HTTP client aborts the request (logged as "An error occurred while
// sending the request") if we don't answer in time. Cap our own work well under
// that so we ALWAYS return a valid 200 body instead of letting the socket hang.
const HANDLER_TIMEOUT_MS = Number(process.env.PALACE_CALLBACK_TIMEOUT_MS ?? 8000)

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('palace callback timeout'), { code: 'TIMEOUT' })), ms),
    ),
  ])
}

export const palaceCallbackRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', {
    preHandler: [verifyPalaceCallbackToken],
    handler: async (req, reply) => {
      // Capture exactly what Palace sent (full raw body) so any future error in
      // their dashboard can be matched to the request/response on our side.
      req.log.info({ rawBody: req.body }, '[Palace] callback received')
      try {
        const body = (req.body ?? {}) as {
          command?: string
          data?: Record<string, any>
        }

        const { command, data: d = {} } = body

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

        // Hub routing: an account may belong to another deployment.
        const cfg = deploymentConfig()
        if (cfg.role === 'hub' && typeof d.account === 'string') {
          const route = decideCallbackRoute(cfg, d.account)
          if (route.kind === 'unknown') {
            return respond({ result: 1002, status: 'USER_NOT_FOUND', data: null })
          }
          if (route.kind === 'forward') {
            // Strip the prefix and relay the spoke's verbatim response.
            const forwardBody = JSON.stringify({ command, data: { ...d, account: route.account } })
            const sig = signBody(route.spoke.secret, forwardBody)
            const res = await withTimeout(
              fetch(`${route.spoke.baseUrl}/v1/hub/spoke-callback`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  [DEPLOYMENT_HEADER]: cfg.code,
                  [SIGNATURE_HEADER]: sig,
                },
                body: forwardBody,
              }),
              HANDLER_TIMEOUT_MS,
            )
            if (!res.ok) {
              // Non-200 to the provider → it retries. Never fabricate success.
              return reply.status(200).send({ result: 1001, status: 'INTERNAL_SERVER_ERROR', data: null })
            }
            return respond(await res.json() as { result: number; status: string; data: object | null })
          }
          // route.kind === 'local' → continue with the stripped account.
          d.account = route.account
        }

        const dispatch = (): Promise<{ result: number; status: string; data: object | null }> => {
          switch (command) {
            case 'authenticate':
              return PalaceWalletService.authenticate(d.account)
            case 'balance':
              return PalaceWalletService.getBalance(d.account)
            case 'bet':
              return PalaceWalletService.processBet({
                trans_guid: d.trans_guid,
                account: d.account,
                gplay_id: d.gplay_id,
                round_id: d.round_id,
                game_code: d.game_code,
                amount: d.amount,
              })
            case 'win':
              return PalaceWalletService.processWin({
                trans_guid: d.trans_guid,
                account: d.account,
                gplay_id: d.gplay_id,
                round_id: d.round_id,
                game_code: d.game_code,
                amount: d.amount,
                type: d.type ?? 2,
              })
            case 'cancel':
              return PalaceWalletService.processCancel({
                trans_guid: d.trans_guid,
                account: d.account,
                gplay_id: d.gplay_id,
                round_id: d.round_id,
                game_code: d.game_code,
                amount: d.amount ?? 0,
                // Palace sends the correctly-spelled `cancel_trans_guid`; keep the
                // legacy misspelling as a fallback for safety.
                cancle_trans_guid: d.cancel_trans_guid ?? d.cancle_trans_guid,
              })
            case 'status':
              return PalaceWalletService.getStatus(d.account, d.trans_guid ?? d.trans_id ?? '')
            default:
              return Promise.resolve({ result: 1006, status: 'COMMAND_NOT_FOUND', data: null })
          }
        }

        return respond(await withTimeout(dispatch(), HANDLER_TIMEOUT_MS))
      } catch (err) {
        // Log the command + payload (not just the error) so we can see exactly which
        // fields Palace sent — essential for diagnosing missing/renamed keys.
        const body = req.body as { command?: string; data?: Record<string, any> }
        const timedOut = (err as any)?.code === 'TIMEOUT'
        req.log.error(
          { err, command: body?.command, dataKeys: body?.data ? Object.keys(body.data) : [], data: body?.data, timedOut },
          '[Palace] Unhandled error in callback handler',
        )
        // Always return a well-formed 200 — a hung socket is what shows up in Palace's
        // dashboard as "An error occurred while sending the request".
        return reply.status(200).send({ result: 1001, status: 'INTERNAL_SERVER_ERROR', data: null })
      }
    },
  })
}
