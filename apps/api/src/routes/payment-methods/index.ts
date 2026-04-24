import { FastifyPluginAsync } from 'fastify'
import prisma from '../../lib/prisma'

const paymentMethodRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /payment-methods?type=DEPOSIT|WITHDRAWAL
  // Returns enabled payment methods, optionally filtered by type
  fastify.get('/', async (req, reply) => {
    const { type } = req.query as { type?: string }
    const where: any = { enabled: true }
    if (type === 'DEPOSIT' || type === 'WITHDRAWAL') {
      where.type = type
    }
    const methods = await prisma.paymentMethod.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        merchantAccount: true,
        instructions: true,
        icon: true,
        sortOrder: true,
      },
    })
    return methods
  })
}

export default paymentMethodRoutes
