import { FastifyInstance } from 'fastify'

declare module 'fastify' {
    interface FastifyInstance {
        authenticate: (request: any, reply: any) => Promise<void>
        requireAdmin: (request: any, reply: any) => Promise<void>
        requireSuperAdmin: (request: any, reply: any) => Promise<void>
        requireAdminOrClerk: (request: any, reply: any) => Promise<void>
        /** Refuses anything other than AccountStatus.ACTIVE. Runs after authenticate. */
        requireActiveAccount: (request: any, reply: any) => Promise<void>
    }
}

/**
 * The access-token payload, as `auth.controller` signs it.
 *
 * Without this `request.user` is `@fastify/jwt`'s default
 * `string | object | Buffer`, so every `request.user.id` is a type error — which
 * is why so many call sites carry a `@ts-ignore` or an `as any`. Declaring the
 * payload once types all of them.
 */
declare module '@fastify/jwt' {
    interface FastifyJWT {
        user: { id: string; role: string }
    }
}
