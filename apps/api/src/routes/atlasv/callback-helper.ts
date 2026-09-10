import type { FastifyReply, FastifyRequest } from 'fastify'
import { AtlasVWalletService, type AtlasVAction, type AtlasVResponse } from '../../services/atlasv-wallet.service.js'
import { verifyAtlasVBody } from '../../gateways/game-provider/atlasv-signature.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { decideCallbackRoute } from '../../gateways/hub/route-callback.js'
import { signBody, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'

const SPOKE_FORWARD_TIMEOUT_MS = Number(process.env.ATLASV_SPOKE_TIMEOUT_MS ?? 5000)
const DEBUG = process.env.ATLASV_CALLBACK_DEBUG === 'true'

function fail(): AtlasVResponse {
    return { success: false }
}

/**
 * Builds a Fastify handler for one Atlas-V callback action. Verifies the
 * per-request signature, routes local-vs-forward-to-spoke on `player_id`
 * (same mechanism as routes/palace/callback.ts, keyed on Atlas-V's own field
 * name), and always answers HTTP 200 — Atlas-V is assumed to retry on
 * anything else, same as Palace/GASea.
 */
export function atlasVCallbackHandler(action: AtlasVAction) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
        const body = (req.body ?? {}) as Record<string, any>
        req.log.info({ action, body }, '[Atlas-V] callback received')

        if (!verifyAtlasVBody(body)) {
            if (DEBUG) req.log.warn({ action, body }, '[Atlas-V] signature verification failed')
            return reply.status(200).send(fail())
        }

        const d = { ...body }
        const cfg = deploymentConfig()
        if (cfg.role === 'hub' && typeof d.player_id === 'string') {
            const route = decideCallbackRoute(cfg, d.player_id)
            if (route.kind === 'forward') {
                const forwardBody = JSON.stringify({ action, data: { ...d, player_id: route.account } })
                const sig = signBody(route.spoke.secret, forwardBody)
                try {
                    const controller = new AbortController()
                    const timer = setTimeout(() => controller.abort(), SPOKE_FORWARD_TIMEOUT_MS)
                    let res: Response
                    try {
                        res = await fetch(`${route.spoke.baseUrl}/v1/hub/atlasv-spoke-callback`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-request-id': String(req.id),
                                [DEPLOYMENT_HEADER]: cfg.code,
                                [SIGNATURE_HEADER]: sig,
                            },
                            body: forwardBody,
                            signal: controller.signal,
                        })
                    } finally {
                        clearTimeout(timer)
                    }
                    if (!res.ok) {
                        req.log.error({ spoke: route.spoke.code, action, httpStatus: res.status }, '[Atlas-V] spoke forward returned non-200')
                        return reply.status(200).send(fail())
                    }
                    const relayed = await res.json()
                    return reply.status(200).send(relayed)
                } catch (err) {
                    req.log.error({ err, spoke: route.spoke.code, action }, '[Atlas-V] spoke forward failed')
                    return reply.status(200).send(fail())
                }
            }
            if (route.kind === 'local') {
                d.player_id = route.account
            }
            // 'unknown' — fall through with the raw player_id; the wallet
            // service's resolveUser returns its not-found shape.
        }

        try {
            const result = await AtlasVWalletService.dispatch(action, d)
            req.log.info({ action, result }, '[Atlas-V] callback handled')
            return reply.status(200).send(result)
        } catch (err) {
            req.log.error({ err, action }, '[Atlas-V] unhandled error in callback handler')
            return reply.status(200).send(fail())
        }
    }
}
