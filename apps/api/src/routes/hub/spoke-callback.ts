import type { FastifyPluginAsync } from 'fastify'
import { PalaceWalletService } from '../../services/palace-wallet.service.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import {
  verifySignature,
  DEPLOYMENT_HEADER,
  SIGNATURE_HEADER,
} from '../../gateways/hub/hub-auth.js'

/**
 * Spoke-side sink for hub-forwarded provider callbacks. The account is already
 * de-namespaced by the hub. Authenticated by the hub's HMAC over the raw body.
 */
export const spokeCallbackRoute: FastifyPluginAsync = async (fastify) => {
  // Capture the raw body so the HMAC matches byte-for-byte what the hub signed.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, { __rawBody: body as string, ...JSON.parse(body as string) })
    } catch (e) {
      done(e as Error, undefined)
    }
  })

  fastify.post('/', async (req, reply) => {
    const cfg = deploymentConfig()
    const raw = (req.body as any)?.__rawBody ?? ''
    const sig = req.headers[SIGNATURE_HEADER] as string | undefined
    const dep = req.headers[DEPLOYMENT_HEADER] as string | undefined

    if (!sig || !dep || !verifySignature(cfg.hubSecret, raw, sig)) {
      return reply.status(401).send({ result: 1009, status: 'TOKEN_INVALID', data: null })
    }

    const { command, data: d = {} } = req.body as { command?: string; data?: Record<string, any> }
    req.log.info({ callingHub: dep, command }, '[Hub] spoke-callback received')
    try {
      return reply.status(200).send(await PalaceWalletService.dispatch(command, d))
    } catch (err) {
      req.log.error({ err, command, callingHub: dep }, '[Hub] spoke-callback dispatch failed')
      return reply.status(200).send({ result: 1001, status: 'INTERNAL_SERVER_ERROR', data: null })
    }
  })
}
