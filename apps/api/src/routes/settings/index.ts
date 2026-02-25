import { FastifyPluginAsync } from 'fastify'
import prisma from '../../lib/prisma'

/** Default feature flags — seeded on first read if missing */
const DEFAULTS: Record<string, string> = {
    feature_referrals: 'false',
    feature_tournaments: 'false',
}

/**
 * Ensure all default keys exist in the database.
 */
async function ensureDefaults() {
    for (const [key, value] of Object.entries(DEFAULTS)) {
        await prisma.siteSetting.upsert({
            where: { key },
            update: {},              // don't overwrite existing
            create: { key, value },
        })
    }
}

const settingsRoutes: FastifyPluginAsync = async (fastify) => {
    // ── Public: GET /settings/features ──────────────────────────────────────
    // Returns all feature flags (no auth needed so the web app can read them).
    fastify.get('/features', async (_req, reply) => {
        await ensureDefaults()
        const rows = await prisma.siteSetting.findMany({
            where: { key: { startsWith: 'feature_' } },
        })
        const features: Record<string, boolean> = {}
        for (const row of rows) {
            features[row.key] = row.value === 'true'
        }
        return features
    })

    // ── Admin: PUT /settings/features ───────────────────────────────────────
    // Body: { feature_referrals: true, feature_tournaments: false, ... }
    fastify.put('/features', {
        preValidation: [
            fastify.authenticate,
            async (request: any, reply) => {
                if (request.user.role !== 'ADMIN' && request.user.role !== 'SUPER_ADMIN') {
                    reply.status(403).send({ error: 'Forbidden: Admin access only' })
                }
            },
        ],
    }, async (req: any, reply) => {
        const body = req.body as Record<string, boolean>
        const results: Record<string, boolean> = {}

        for (const [key, value] of Object.entries(body)) {
            if (!key.startsWith('feature_')) continue
            const row = await prisma.siteSetting.upsert({
                where: { key },
                update: { value: String(value) },
                create: { key, value: String(value) },
            })
            results[row.key] = row.value === 'true'
        }

        return results
    })
}

export default settingsRoutes
