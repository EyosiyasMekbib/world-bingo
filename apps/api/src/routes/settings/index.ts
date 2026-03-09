import { FastifyPluginAsync } from 'fastify'
import prisma from '../../lib/prisma'

/** Default feature flags and game settings — seeded on first read if missing */
const DEFAULTS: Record<string, string> = {
    feature_referrals: 'false',
    feature_tournaments: 'false',
    ball_interval_secs: '3',
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

    // ── Admin: GET /settings/game ─────────────────────────────────────────────
    // Returns configurable game settings (admin only).
    fastify.get('/game', {
        preValidation: [
            fastify.authenticate,
            async (request: any, reply) => {
                if (request.user.role !== 'ADMIN' && request.user.role !== 'SUPER_ADMIN') {
                    reply.status(403).send({ error: 'Forbidden: Admin access only' })
                }
            },
        ],
    }, async (_req, _reply) => {
        await ensureDefaults()
        const row = await prisma.siteSetting.findUnique({ where: { key: 'ball_interval_secs' } })
        return { ball_interval_secs: Number(row?.value ?? 3) }
    })

    // ── Admin: PUT /settings/game ─────────────────────────────────────────────
    // Body: { ball_interval_secs: 5 }
    fastify.put('/game', {
        preValidation: [
            fastify.authenticate,
            async (request: any, reply) => {
                if (request.user.role !== 'ADMIN' && request.user.role !== 'SUPER_ADMIN') {
                    reply.status(403).send({ error: 'Forbidden: Admin access only' })
                }
            },
        ],
    }, async (req: any, _reply) => {
        const { ball_interval_secs } = req.body as { ball_interval_secs: number }
        const secs = Math.max(1, Math.min(30, Number(ball_interval_secs)))
        await prisma.siteSetting.upsert({
            where: { key: 'ball_interval_secs' },
            update: { value: String(secs) },
            create: { key: 'ball_interval_secs', value: String(secs) },
        })
        return { ball_interval_secs: secs }
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
