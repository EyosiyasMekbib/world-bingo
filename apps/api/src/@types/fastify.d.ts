import { FastifyInstance } from 'fastify'

declare module 'fastify' {
    interface FastifyInstance {
        authenticate: (request: any, reply: any) => Promise<void>
        requireAdmin: (request: any, reply: any) => Promise<void>
        requireSuperAdmin: (request: any, reply: any) => Promise<void>
        requireAdminOrClerk: (request: any, reply: any) => Promise<void>
    }
}
