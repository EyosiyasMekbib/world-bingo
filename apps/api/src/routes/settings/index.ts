import { FastifyPluginAsync } from 'fastify'
import prisma from '../../lib/prisma'

/** Default feature flags and game settings — seeded on first read if missing */
const DEFAULTS: Record<string, string> = {
    feature_referrals: 'false',
    feature_tournaments: 'false',
    ball_interval_secs: '3',
    bot_max_spend_etb: '500',
    first_deposit_bonus_amount: '0',
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
        const rows = await prisma.siteSetting.findMany({
            where: { key: { in: ['ball_interval_secs', 'bot_max_spend_etb', 'first_deposit_bonus_amount'] } },
        })
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
        return {
            ball_interval_secs: Number(map.ball_interval_secs ?? 3),
            bot_max_spend_etb: Number(map.bot_max_spend_etb ?? 500),
            first_deposit_bonus_amount: Number(map.first_deposit_bonus_amount ?? 0),
        }
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
        const body = req.body as { ball_interval_secs?: number; bot_max_spend_etb?: number; first_deposit_bonus_amount?: number }
        const updates: Record<string, string> = {}
        if (body.ball_interval_secs != null) {
            updates.ball_interval_secs = String(Math.max(1, Math.min(30, Number(body.ball_interval_secs))))
        }
        if (body.bot_max_spend_etb != null) {
            updates.bot_max_spend_etb = String(Math.max(0, Number(body.bot_max_spend_etb)))
        }
        if (body.first_deposit_bonus_amount != null) {
            updates.first_deposit_bonus_amount = String(Math.max(0, Number(body.first_deposit_bonus_amount)))
        }
        for (const [key, value] of Object.entries(updates)) {
            await prisma.siteSetting.upsert({
                where: { key },
                update: { value },
                create: { key, value },
            })
        }
        return {
            ball_interval_secs: Number(updates.ball_interval_secs ?? (await prisma.siteSetting.findUnique({ where: { key: 'ball_interval_secs' } }))?.value ?? 3),
            bot_max_spend_etb: Number(updates.bot_max_spend_etb ?? (await prisma.siteSetting.findUnique({ where: { key: 'bot_max_spend_etb' } }))?.value ?? 500),
            first_deposit_bonus_amount: Number(updates.first_deposit_bonus_amount ?? (await prisma.siteSetting.findUnique({ where: { key: 'first_deposit_bonus_amount' } }))?.value ?? 0),
        }
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
