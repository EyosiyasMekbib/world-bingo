import { FastifyReply, FastifyRequest } from 'fastify'
import prisma from '../lib/prisma'
import { CreateGameDto, GameStatus, PatternType, UserRole } from '@world-bingo/shared-types'
import { generateCartela, generateSerial } from '@world-bingo/game-logic'

export class GameController {
    static async create(request: FastifyRequest<{ Body: CreateGameDto }>, reply: FastifyReply) {
        // Only admin can create games
        // @ts-ignore
        if (request.user.role !== UserRole.ADMIN && request.user.role !== UserRole.SUPER_ADMIN) {
            return reply.status(403).send({ message: 'Forbidden' })
        }

        const { title, ticketPrice, maxPlayers, houseEdgePct, pattern } = request.body

        const game = await prisma.game.create({
            data: {
                title,
                ticketPrice,
                maxPlayers,
                houseEdgePct,
                pattern,
                status: GameStatus.WAITING,
                calledBalls: [],
            },
        })

        // Generate Cartelas for this game (e.g. maxPlayers cards)
        // In a real app we might generate them on demand or in batches
        // For now, let's pre-generate 70 cards as per spec
        const cartelaData = Array.from({ length: 70 }).map(() => {
            const grid = generateCartela()
            const serial = generateSerial(grid)
            return {
                gameId: game.id,
                grid: JSON.stringify(grid),
                serial,
                status: 'AVAILABLE', // We need to add this to schema or handle logic
            }
        })

         // We need a Cartela model in Prisma to store these.
         // Let's assume we have one or we store them in a JSON field if checks are simple.
         // But for individual assignment, a separate table is better.
         // Wait, the spec says "Cartela selection".
         // We should update Prisma schema first to support Cartelas.
        
        return game
    }

    static async list(request: FastifyRequest, reply: FastifyReply) {
        const games = await prisma.game.findMany({
            where: {
                status: {
                    in: [GameStatus.WAITING, GameStatus.STARTING, GameStatus.IN_PROGRESS],
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
        })
        return games
    }

    static async get(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
        const game = await prisma.game.findUnique({
            where: { id: request.params.id },
            include: {
                entries: true, // We need to see who is in
            },
        })
        
        if (!game) return reply.status(404).send({ message: 'Game not found' })
        return game
    }
}
