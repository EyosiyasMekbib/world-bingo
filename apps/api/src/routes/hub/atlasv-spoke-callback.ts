import type { FastifyPluginAsync } from 'fastify'
import { AtlasVWalletService } from '../../services/atlasv-wallet.service.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { verifySignature, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'

/**
 * Spoke-side sink for hub-forwarded Atlas-V callbacks. The player_id is
 * already de-namespaced by the hub. Authenticated by the hub's HMAC over the
 * raw body — same shape as routes/hub/spoke-callback.ts, kept as a separate
 * file because Atlas-V's callback envelope (`{ action, data }`, keyed on
 * `player_id`) differs from Palace's (`{ command, data }`, keyed on `account`).
 */
export const atlasVSpokeCallbackRoute: FastifyPluginAsync = async (fastify) => {
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
            return reply.status(401).send({ success: false })
        }

        const { action, data: d = {} } = req.body as { action?: string; data?: Record<string, any> }
        req.log.info({ callingHub: dep, action }, '[Hub] atlasv-spoke-callback received')
        try {
            return reply.status(200).send(await AtlasVWalletService.dispatch(action as any, d))
        } catch (err) {
            req.log.error({ err, action, callingHub: dep }, '[Hub] atlasv-spoke-callback dispatch failed')
            return reply.status(200).send({ success: false })
        }
    })
}
