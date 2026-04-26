/**
 * T60 — Tournament Routes
 *
 * Public:
 *   GET  /tournaments              — list all (filter by ?status=)
 *   GET  /tournaments/:id          — single tournament
 *   GET  /tournaments/:id/leaderboard — live leaderboard
 *
 * Authenticated:
 *   POST /tournaments/:id/register — player registers for a tournament
 *
 * Admin:
 *   POST /tournaments              — create tournament
 *   POST /tournaments/:id/start    — open registration → in_progress
 *   POST /tournaments/:id/cancel   — cancel tournament (refunds players)
 *   POST /tournaments/:id/advance  — manually advance to next round (for testing / edge cases)
 */

import type { FastifyInstance } from 'fastify'
import { TournamentService } from '../../services/tournament.service'
import { TournamentStatus } from '@world-bingo/shared-types'
import { CreateTournamentSchema } from '@world-bingo/shared-types'
import type { CreateTournamentDto } from '@world-bingo/shared-types'

export default async function tournamentRoutes(server: FastifyInstance) {
    // ── GET /tournaments ─────────────────────────────────────────────────────
    server.get('/', async (request, reply) => {
        const { status } = request.query as { status?: string }
        try {
            const tournaments = await TournamentService.list(status as TournamentStatus | undefined)
            return reply.send(tournaments)
        } catch (err: any) {
            return reply.status(500).send({ error: err.message })
        }
    })

    // ── GET /tournaments/:id ─────────────────────────────────────────────────
    server.get('/:id', async (request, reply) => {
        const { id } = request.params as { id: string }
        try {
            const tournament = await TournamentService.getById(id)
            return reply.send(tournament)
        } catch (err: any) {
            return reply.status(404).send({ error: err.message })
        }
    })

    // ── GET /tournaments/:id/leaderboard ─────────────────────────────────────
    server.get('/:id/leaderboard', async (request, reply) => {
        const { id } = request.params as { id: string }
        try {
            const leaderboard = await TournamentService.getLeaderboard(id)
            return reply.send(leaderboard)
        } catch (err: any) {
            return reply.status(404).send({ error: err.message })
        }
    })

    // ── POST /tournaments/:id/register ────────────────────────────────────────
    server.post(
        '/:id/register',
        { preHandler: [server.authenticate] },
        async (request, reply) => {
            const { id } = request.params as { id: string }
            const userId = (request.user as any).id
            try {
                const entry = await TournamentService.register(id, userId)
                return reply.status(201).send(entry)
            } catch (err: any) {
                const status = err.message === 'Tournament not found' ? 404
                    : err.message === 'Insufficient funds' ? 400
                    : err.message.includes('full') ? 409
                    : err.message.includes('Already') ? 409
                    : 400
                return reply.status(status).send({ error: err.message })
            }
        },
    )

    // ── POST /tournaments (admin only) ────────────────────────────────────────
    server.post(
        '/',
        { preHandler: [server.requireAdmin] },
        async (request, reply) => {
            try {
                const body = request.body as Record<string, any>
                const parsed = CreateTournamentSchema.safeParse(body)
                if (!parsed.success) {
                    return reply.status(400).send({ error: parsed.error.issues })
                }
                const tournament = await TournamentService.create(parsed.data as CreateTournamentDto)
                return reply.status(201).send(tournament)
            } catch (err: any) {
                return reply.status(500).send({ error: err.message })
            }
        },
    )

    // ── POST /tournaments/:id/start (admin) ───────────────────────────────────
    server.post(
        '/:id/start',
        { preHandler: [server.requireAdmin] },
        async (request, reply) => {
            const { id } = request.params as { id: string }
            try {
                const tournament = await TournamentService.start(id)
                return reply.send(tournament)
            } catch (err: any) {
                return reply.status(400).send({ error: err.message })
            }
        },
    )

    // ── POST /tournaments/:id/cancel (admin) ──────────────────────────────────
    server.post(
        '/:id/cancel',
        { preHandler: [server.requireAdmin] },
        async (request, reply) => {
            const { id } = request.params as { id: string }
            try {
                await TournamentService.cancel(id)
                return reply.send({ success: true })
            } catch (err: any) {
                return reply.status(400).send({ error: err.message })
            }
        },
    )

    // ── POST /tournaments/:id/advance (admin) ─────────────────────────────────
    // Manual round advancement (useful for testing / stuck states)
    server.post(
        '/:id/advance',
        { preHandler: [server.requireAdmin] },
        async (request, reply) => {
            const { id } = request.params as { id: string }
            const { winnerId } = request.body as { winnerId: string }
            if (!winnerId) return reply.status(400).send({ error: 'winnerId is required' })
            try {
                // Find the latest game in this tournament
                const latestGame = await (await import('../../lib/prisma')).default.tournamentGame.findFirst({
                    where: { tournamentId: id },
                    orderBy: { round: 'desc' },
                })
                if (!latestGame) return reply.status(404).send({ error: 'No round game found' })
                await TournamentService.processRoundResult(id, latestGame.gameId, winnerId)
                return reply.send({ success: true })
            } catch (err: any) {
                return reply.status(400).send({ error: err.message })
            }
        },
    )
}
