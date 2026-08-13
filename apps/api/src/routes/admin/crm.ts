import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { SegmentService } from '../../services/player-crm/segment.service'
import { SegmentCompileError } from '../../services/player-crm/segment-compiler'
import { PlayerMetricsService } from '../../services/player-crm/player-metrics.service'
import { seedSegmentPresets, SEGMENT_PRESETS } from '../../services/player-crm/segment-presets'
import { SEGMENT_FIELDS, SEGMENT_OPERATORS, OPERATOR_ARITY, segmentField } from '@world-bingo/shared-types'
import prisma from '../../lib/prisma'
import { CampaignService } from '../../services/player-crm/campaign.service'
import { enqueueCampaign } from '../../workers/crm-campaign.worker.js'
import type { SegmentField } from '@world-bingo/shared-types'

/**
 * Player CRM — Phase 1: metrics, segments, CSV export.
 *
 * Mounted inside the admin plugin, so it inherits that scope's auth hook. No
 * campaign or money endpoints live here yet; those arrive in Phase 2 and 3.
 */

const segmentCreateSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional().nullable(),
    rules: z.unknown(),
})

const segmentUpdateSchema = segmentCreateSchema.partial()

const rulesOnlySchema = z.object({ rules: z.unknown() })

const campaignCreateSchema = z.object({
    name: z.string().min(1).max(120),
    segmentId: z.string().uuid(),
    actions: z.object({
        message: z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(2000) }).optional(),
        bonus: z.object({ amount: z.number().positive().max(100_000) }).optional(),
    }),
    maxRecipients: z.number().int().min(1).max(1_000_000).optional(),
    maxTotalBonus: z.number().min(0).max(10_000_000).optional(),
    maxPerPlayer: z.number().min(0).max(100_000).optional(),
})

/**
 * The JWT carries only { id, role } — no username. Rather than change the token
 * shape (which every consumer would have to re-issue for), resolve the display
 * name here. Without it the audit trail records WHAT happened but not WHO, which
 * is most of the point.
 */
async function actorName(req: any): Promise<string | null> {
    if (!req.user?.id) return null
    const user = await prisma.user
        .findUnique({ where: { id: req.user.id }, select: { username: true } })
        .catch(() => null)
    return user?.username ?? null
}

/** Append-only trace. The platform has no other record of privileged actions. */
async function writeAudit(req: any, action: string, target: string, detail: unknown) {
    await prisma.auditLog
        .create({
            data: {
                action,
                actorId: req.user?.id ?? null,
                actorName: await actorName(req),
                target,
                detail: (detail ?? {}) as never,
            },
        })
        .catch(() => {
            /* auditing must never block the action it records */
        })
}

const previewSchema = z.object({
    rules: z.unknown(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
})

/**
 * A ZodError's `message` is the entire serialized issue array — dumping it into
 * the UI shows the operator a wall of JSON. Reduce it to the first issue, phrased
 * against the rule path so the builder can still point at the offending row.
 */
function ruleErrorMessage(err: any): string {
    if (Array.isArray(err?.issues) && err.issues.length) {
        const first = err.issues[0]
        const path = Array.isArray(first.path) ? first.path.join('.') : ''
        return path ? `${path}: ${first.message}` : first.message
    }
    const msg = String(err?.message ?? 'Invalid segment rules')
    return msg.trim().startsWith('[') ? 'Invalid segment rules' : msg
}

/** Invalid rules are a client mistake, not a server fault — map them to 400. */
function isBadRules(err: unknown): boolean {
    return (
        err instanceof SegmentCompileError ||
        (err as { name?: string })?.name === 'ZodError' ||
        (err as { name?: string })?.name === 'SegmentCompileError'
    )
}

const crmRoutes: FastifyPluginAsync = async (fastify) => {
    // ── Builder metadata ──────────────────────────────────────────────────────
    // The admin builder renders its field and operator pickers from this, so the
    // UI can never offer a field the server would reject.
    fastify.get('/fields', async () => ({
        fields: Object.keys(SEGMENT_FIELDS).map((key) => {
            // segmentField() widens the `as const` literal back to the descriptor
            // interface — presence fields carry no min/max, so reading them off
            // the literal union does not typecheck.
            const descriptor = segmentField(key as SegmentField)
            return {
                key,
                label: descriptor.label,
                type: descriptor.type,
                operators: descriptor.operators,
                min: descriptor.min ?? null,
                max: descriptor.max ?? null,
            }
        }),
        operators: SEGMENT_OPERATORS.map((op) => ({ op, arity: OPERATOR_ARITY[op] })),
    }))

    // ── Metrics ───────────────────────────────────────────────────────────────
    fastify.get('/metrics/freshness', async () => PlayerMetricsService.getFreshness())

    fastify.post('/metrics/refresh', async (req: any, reply) => {
        // Manual rebuild for when someone cannot wait for the 5-minute tick.
        const full = req.query?.full === 'true' || req.query?.full === true
        const result = full
            ? await PlayerMetricsService.refreshAll()
            : await PlayerMetricsService.refreshIncremental()
        req.log.info({ full, result }, '[crm] manual metrics refresh')
        return reply.send(result)
    })

    // ── Segments ──────────────────────────────────────────────────────────────
    fastify.get('/segments', async () => SegmentService.list())

    fastify.post('/segments/presets', async (_req, reply) => {
        const result = await seedSegmentPresets()
        return reply.send({ ...result, available: SEGMENT_PRESETS.length })
    })

    fastify.get('/segments/:id', async (req: any, reply) => {
        try {
            return await SegmentService.getById(req.params.id)
        } catch {
            return reply.status(404).send({ error: 'Segment not found' })
        }
    })

    fastify.post('/segments', async (req: any, reply) => {
        const parsed = segmentCreateSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
        }
        try {
            const segment = await SegmentService.create({
                name: parsed.data.name,
                description: parsed.data.description ?? null,
                rules: parsed.data.rules,
                createdById: req.user?.id ?? null,
            })
            return reply.status(201).send(segment)
        } catch (err: any) {
            if (isBadRules(err)) {
                return reply.status(400).send({ error: ruleErrorMessage(err), issues: err.issues })
            }
            if (err?.code === 'P2002') {
                return reply.status(409).send({ error: 'A segment with that name already exists' })
            }
            throw err
        }
    })

    fastify.patch('/segments/:id', async (req: any, reply) => {
        const parsed = segmentUpdateSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
        }
        try {
            return await SegmentService.update(req.params.id, parsed.data)
        } catch (err: any) {
            if (isBadRules(err)) {
                return reply.status(400).send({ error: ruleErrorMessage(err), issues: err.issues })
            }
            if (err?.code === 'P2025') {
                return reply.status(404).send({ error: 'Segment not found' })
            }
            throw err
        }
    })

    fastify.delete('/segments/:id', async (req: any, reply) => {
        try {
            await SegmentService.remove(req.params.id)
            return { success: true }
        } catch (err: any) {
            if (err?.code === 'P2025') {
                return reply.status(404).send({ error: 'Segment not found' })
            }
            return reply.status(409).send({ error: err.message })
        }
    })

    // ── Live preview (unsaved rules) ──────────────────────────────────────────
    fastify.post('/segments/count', async (req: any, reply) => {
        const parsed = rulesOnlySchema.safeParse(req.body)
        if (!parsed.success) return reply.status(400).send({ error: 'rules is required' })
        try {
            return { count: await SegmentService.countRules(parsed.data.rules) }
        } catch (err: any) {
            if (isBadRules(err)) {
                return reply.status(400).send({ error: ruleErrorMessage(err), issues: err.issues })
            }
            throw err
        }
    })

    fastify.post('/segments/preview', async (req: any, reply) => {
        const parsed = previewSchema.safeParse(req.body)
        if (!parsed.success) return reply.status(400).send({ error: 'rules is required' })
        try {
            return await SegmentService.preview(parsed.data.rules, {
                page: parsed.data.page,
                limit: parsed.data.limit,
            })
        } catch (err: any) {
            if (isBadRules(err)) {
                return reply.status(400).send({ error: ruleErrorMessage(err), issues: err.issues })
            }
            throw err
        }
    })

    // ── CSV export ────────────────────────────────────────────────────────────
    fastify.get('/segments/:id/export.csv', async (req: any, reply) => {
        let segment
        try {
            segment = await SegmentService.getById(req.params.id)
        } catch {
            return reply.status(404).send({ error: 'Segment not found' })
        }

        // This file leaves the building with player phone numbers in it. There is
        // no audit table on this platform, so at minimum the export is logged with
        // who asked for it and which segment — otherwise a PII export is invisible.
        req.log.warn(
            { segmentId: segment.id, segmentName: segment.name, actorId: req.user?.id ?? null },
            '[crm] segment CSV export',
        )
        // Written BEFORE the stream opens, so a killed request still leaves a trace.
        await writeAudit(req, 'segment.export_csv', `segment:${segment.id}`, {
            segmentName: segment.name,
        })

        const safeName = segment.name.replace(/[^a-zA-Z0-9-_]+/g, '-').slice(0, 60)
        reply.header('Content-Type', 'text/csv; charset=utf-8')
        reply.header('Content-Disposition', `attachment; filename="segment-${safeName}.csv"`)
        // Streamed rather than buffered: a 100k-row segment is tens of MB held in
        // memory otherwise, for the whole life of the request.
        return reply.send(streamToWebReadable(SegmentService.exportCsv(segment.rules)))
    })

    // ── Campaigns (Phase 2 messages, Phase 3 bonus grants) ────────────────────
    fastify.get('/campaigns', async () =>
        prisma.campaign.findMany({
            orderBy: { createdAt: 'desc' },
            include: { segment: { select: { name: true } } },
        }),
    )

    fastify.get('/campaigns/:id', async (req: any, reply) => {
        const campaign = await prisma.campaign.findUnique({
            where: { id: req.params.id },
            include: { segment: { select: { name: true } } },
        })
        if (!campaign) return reply.status(404).send({ error: 'Campaign not found' })

        // Delivery outcomes, grouped — "who was in this and what happened".
        const breakdown = await prisma.campaignDelivery.groupBy({
            by: ['status'],
            where: { campaignId: campaign.id },
            _count: true,
        })
        return { ...campaign, breakdown }
    })

    fastify.post('/campaigns', async (req: any, reply) => {
        const parsed = campaignCreateSchema.safeParse(req.body)
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Invalid request', details: parsed.error.issues })
        }
        try {
            const campaign = await CampaignService.create({
                name: parsed.data.name,
                segmentId: parsed.data.segmentId,
                actions: parsed.data.actions as never,
                maxRecipients: parsed.data.maxRecipients,
                maxTotalBonus: parsed.data.maxTotalBonus,
                maxPerPlayer: parsed.data.maxPerPlayer,
                actorId: req.user?.id ?? null,
                actorName: await actorName(req),
            })
            return reply.status(201).send(campaign)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.patch('/campaigns/:id', async (req: any, reply) => {
        try {
            return await CampaignService.update(req.params.id, req.body ?? {}, req.user?.id ?? null)
        } catch (err: any) {
            return reply.status(409).send({ error: err.message })
        }
    })

    fastify.post('/campaigns/:id/submit', async (req: any, reply) => {
        try {
            return await CampaignService.submitForApproval(req.params.id)
        } catch (err: any) {
            return reply.status(409).send({ error: err.message })
        }
    })

    /**
     * Approval. Money-granting campaigns additionally require SUPER_ADMIN — an
     * ADMIN can no longer mint another admin, so this is a boundary an insider
     * cannot manufacture for themselves.
     */
    fastify.post('/campaigns/:id/approve', async (req: any, reply) => {
        const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } })
        if (!campaign) return reply.status(404).send({ error: 'Campaign not found' })

        const grantsMoney = !!(campaign.actions as any)?.bonus?.amount
        if (grantsMoney && req.user?.role !== 'SUPER_ADMIN') {
            return reply
                .status(403)
                .send({ error: 'Only a super admin may approve a campaign that grants bonus credit' })
        }

        try {
            const approved = await CampaignService.approve(req.params.id, {
                id: req.user?.id,
                username: await actorName(req),
                note: req.body?.note,
            })
            await writeAudit(req, 'campaign.approve', `campaign:${req.params.id}`, {
                grantsMoney,
                maxTotalBonus: String(campaign.maxTotalBonus),
                maxPerPlayer: String(campaign.maxPerPlayer),
                note: req.body?.note ?? null,
            })
            return approved
        } catch (err: any) {
            return reply.status(409).send({ error: err.message })
        }
    })

    fastify.post('/campaigns/:id/launch', async (req: any, reply) => {
        try {
            const result = await CampaignService.launch(req.params.id)
            await enqueueCampaign(req.params.id)
            await writeAudit(req, 'campaign.launch', `campaign:${req.params.id}`, result)
            return result
        } catch (err: any) {
            return reply.status(409).send({ error: err.message })
        }
    })

    fastify.post('/campaigns/:id/stop', async (req: any, reply) => {
        const stopped = await CampaignService.stop(req.params.id)
        await writeAudit(req, 'campaign.stop', `campaign:${req.params.id}`, { stopped })
        return { stopped }
    })

}

/** Adapts the async generator to something Fastify can pipe. */
function streamToWebReadable(gen: AsyncGenerator<string>): NodeJS.ReadableStream {
    const { Readable } = require('stream') as typeof import('stream')
    return Readable.from(gen)
}

export default crmRoutes
