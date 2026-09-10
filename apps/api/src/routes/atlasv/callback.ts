import type { FastifyPluginAsync } from 'fastify'
import { atlasVCallbackHandler } from './callback-helper.js'

/**
 * Atlas-V inbound wallet callbacks. Mounted under /v1/atlasv/callback
 * (configured in index.ts). One URL per action, unlike Palace's single
 * command-dispatch endpoint — see
 * docs/superpowers/specs/2026-09-09-atlasv-integration-design.md.
 */
export const atlasVCallbackRoutes: FastifyPluginAsync = async (fastify) => {
    // Atlas-V's doc mandates Content-Type: text/javascript on every request;
    // also accept application/json in case their staging client sends that.
    const parseJson = (_req: any, body: string, done: (err: Error | null, body?: any) => void) => {
        try {
            done(null, { ...JSON.parse(body), __rawBody: body })
        } catch (e) {
            done(e as Error, undefined)
        }
    }
    fastify.addContentTypeParser('text/javascript', { parseAs: 'string' }, parseJson)
    fastify.addContentTypeParser('application/json', { parseAs: 'string' }, parseJson)

    fastify.post('/account', atlasVCallbackHandler('account'))
    fastify.post('/bet', atlasVCallbackHandler('bet'))
    fastify.post('/betwin', atlasVCallbackHandler('betwin'))
    fastify.post('/result', atlasVCallbackHandler('result'))
    fastify.post('/rollback', atlasVCallbackHandler('rollback'))
    fastify.post('/freespin', atlasVCallbackHandler('freespin'))
    fastify.post('/jackpot', atlasVCallbackHandler('jackpot'))
}
