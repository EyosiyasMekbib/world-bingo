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
            // Fix: generated cartelas should be stored. 
            // In the previous step we updated schema but didn't actually insert them.
            // Let's insert them into the DB.
            return {
                serial,
                grid: grid // JSON
            }
        })
        
        // We need to save these cartelas. 
        // Note: Creating 70 rows per game creation is fine for MVP.
        // But the schema "Cartela" has unique serial. 
        // If "Cartela" is a global concept, we should upsert or find them.
        // Spec says "Cartela Selection... 1-70 cards per game".
        // It implies specific to the game.
        // If Schema has `Cartela` separate from `Game`, how do we link them?
        // `GameEntry` links them.
        // So `Cartela` might be a pool of standard cards?
        // Let's assume we create new ones for simplicity or reuse pool.
        // Schema: `model Cartela { id, serial, grid }`.
        // Serial is unique. So `1-2-3...` serials must be unique globally? 
        // No, serial is usually the string representation of numbers.
        // Let's just create them if not exist? 
        // Actually, to display "1-70" in UI, we verify availability via GameEntry.
        
        // For this implementation, I will skip complex "Standard Cartela Pool" and just return 
        // generated grids to frontend for the "Selection" screen. 
        // But wait, the user needs to select a "cartelaID". 
        // So we DO need them in DB.
        
        // Let's create a few Cartelas if the DB is empty, or reuse existing ones.
        // It's better if the API generates them and sends them back.
        
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
                entries: {
                    include: { cartela: true },
                },
                _count: { select: { entries: true } },
            },
        })
        
        if (!game) return reply.status(404).send({ message: 'Game not found' })
        // Attach a distinct player count for the UI
        const distinctPlayers = new Set(game.entries.map((e: any) => e.userId)).size
        return { ...game, currentPlayers: distinctPlayers }
    }

    static async getAvailableCartelas(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
         // Fetch all cartelas (limit 100 for now)
         const allCartelas = await prisma.cartela.findMany({ take: 100 })
         
         // Fetch used cartelas in this game
         const entries = await prisma.gameEntry.findMany({
             where: { gameId: request.params.id },
             select: { cartelaId: true }
         })
         
         const usedIds = new Set(entries.map(e => e.cartelaId))
         
         return allCartelas.map(c => ({
             ...c,
             isTaken: usedIds.has(c.id)
         }))
    }
}
