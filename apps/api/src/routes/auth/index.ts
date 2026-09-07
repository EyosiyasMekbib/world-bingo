import { createHash } from 'crypto'
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { LoginSchema, RegisterSchema, RefreshTokenSchema, LogoutSchema, ChangePasswordSchema, TelegramAuthSchema } from '@world-bingo/shared-types'
import { AuthController } from '../../controllers'
import zodToJsonSchema from 'zod-to-json-schema'
import { rateLimitKey } from '../../lib/rate-limit-key'

const authRoutes: FastifyPluginAsync = async (fastify) => {
    // Independent per-IP ceiling for /auth/refresh, built with
    // `fastify.createRateLimit(...)` — NOT `fastify.rateLimit(...)`, which is
    // what an earlier attempt at this fix used and which silently disables
    // the per-token budget below it.
    //
    // @fastify/rate-limit decorates both `rateLimit` and `createRateLimit`
    // from the same `onRoute`-time setup (index.js:128-140):
    //   fastify.decorate('createRateLimit', (options) => {
    //     const args = createLimiterArgs(pluginComponent, globalParams, options)
    //     return (req) => applyRateLimit.apply(this, args.concat(req))
    //   })
    //   fastify.decorate('rateLimit', (options) => {
    //     const args = createLimiterArgs(pluginComponent, globalParams, options)
    //     return rateLimitRequestHandler(...args)
    //   })
    // `createLimiterArgs` (index.js:190-199) builds every limiter's
    // component with `Object.create(pluginComponent)`, so EVERY limiter —
    // the global one, this route's per-token one, and anything built with
    // either decorator — descends from and shares one `pluginComponent`,
    // and therefore one `rateLimitRan` Symbol (index.js:110-113,126).
    // `rateLimitRequestHandler` (index.js:277-285) uses that shared symbol
    // as a once-per-request guard:
    //   function rateLimitRequestHandler (pluginComponent, params) {
    //     const { rateLimitRan } = pluginComponent
    //     return async (req, res) => {
    //       if (req[rateLimitRan]) { return }
    //       req[rateLimitRan] = true
    //       ...
    // A second `fastify.rateLimit(...)` wired as this route's `onRequest`
    // hook runs before the route's own `preValidation` per-token limiter,
    // sets that flag first, and the per-token limiter — built the same way,
    // sharing the same flag — then returns on its very first line without
    // ever calling `applyRateLimit`, so it stops counting anything.
    // `createRateLimit` never touches `rateLimitRan` at all: it hands back
    // a bare `(req) => applyRateLimit(...)`, and `applyRateLimit`
    // (index.js:213-275) only computes and returns the limit result — no
    // read or write of the flag anywhere in it. A checker built this way can
    // run alongside the route's own limiter without shadowing it.
    const checkIpCeiling = fastify.createRateLimit({
        // 240/min, not 120: a redeploy makes every client's stored session
        // 401 and refresh at once, and a large carrier NAT reconnecting
        // after an outage arrives as one burst — neither of those must trip
        // this ceiling.
        max: 240,
        timeWindow: '1 minute',
        // The same IP key the pre-existing global 100/min limiter falls back
        // to for anonymous traffic (see lib/rate-limit-key.ts and the
        // registration of `@fastify/rate-limit` in index.ts) — that limiter
        // keys on a VERIFIED user id whenever a valid bearer token is
        // present, and only drops to this key otherwise. Refresh calls carry
        // no bearer token, so this route is always on the fallback.
        // `req.ip` with `trustProxy: true` resolves to the LEFTMOST
        // `x-forwarded-for` hop. Traefik *appends* its own hop
        // rather than replacing the header, so that leftmost entry is
        // whatever the client itself sent as `X-Forwarded-For` — an
        // attacker can put anything there, including a fresh value on every
        // request, which defeats this key entirely. So, honestly: this
        // ceiling is NOT a defence against a determined attacker who spoofs
        // the header (an attacker rotating both the refresh token AND the
        // XFF value per request sees zero 429s from it, same as before this
        // fix). It only guards against an accidental request storm or
        // unsophisticated abuse that doesn't bother spoofing the header.
        // Real hardening — pinning the trusted hop count for the actual
        // production proxy topology (Dokploy/Traefik, possibly also
        // Cloudflare, none of which is established here) and re-keying off
        // it — is a follow-up, and it must cover the pre-existing global
        // limiter's own anonymous fallback too, which shares this weakness.
        // A 429 from this ceiling is no longer session-fatal either way:
        // the web store treats 429 as transient and keeps the session.
        keyGenerator: (req: any) =>
            rateLimitKey({
                userId: null,
                forwardedFor: req.headers['x-forwarded-for'] as string | undefined,
                ip: req.ip,
            }),
    })

    async function refreshIpCeiling(req: FastifyRequest, reply: FastifyReply) {
        const result = await checkIpCeiling(req)
        // `=== true`/`=== false`, not a plain truthiness check: this
        // package's tsconfig runs with `strict: false` (no
        // `strictNullChecks`), and without it a bare `if (result.isAllowed)`
        // does not narrow this discriminated union at all — every property
        // access below would still see the full `isAllowed: true | false`
        // type and fail to compile.
        if (result.isAllowed === true) return

        // Mirrors @fastify/rate-limit's own `rateLimitRequestHandler`: every
        // non-allowlisted request gets the informational headers, and only a
        // request that is actually over the limit (`isExceeded`) gets
        // `retry-after` plus the 429 body.
        reply.header('x-ratelimit-limit', result.max)
        reply.header('x-ratelimit-remaining', result.remaining)
        reply.header('x-ratelimit-reset', result.ttlInSeconds)
        if (result.isExceeded === false) return

        reply.header('retry-after', result.ttlInSeconds)
        return reply.code(429).send({
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please slow down.',
        })
    }

    // Strict rate limit for auth endpoints to prevent brute-force
    fastify.post('/register', {
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(RegisterSchema),
        },
        handler: AuthController.register,
    })

    fastify.post('/login', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(LoginSchema),
        },
        handler: AuthController.login,
    })

    fastify.post('/admin/login', {
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(LoginSchema),
        },
        handler: AuthController.adminLogin,
    })

    fastify.post('/refresh', {
        config: {
            rateLimit: {
                max: 20,
                timeWindow: '1 minute',
                // @fastify/rate-limit's default hook is 'onRequest', which runs
                // before Fastify parses the body — req.body would always be
                // undefined there and this keyGenerator would silently fall back
                // to `ip:...` for every request. Move just this route's rate
                // limit to 'preValidation' (after parsing, before the schema
                // check) so it can actually key on the token. This does not
                // touch the global limiter's hook phase.
                hook: 'preValidation',
                // Per device, not per IP: a shared carrier address must not put
                // every player on one 20/min budget. A 429 here used to read to
                // the client as a lost session, but the web store now treats
                // 429 as transient and keeps the session — so this budget only
                // needs to protect the device, not avoid ever being hit.
                keyGenerator: (req: any) => {
                    const token = req.body?.refreshToken
                    return typeof token === 'string' && token.length > 0
                        ? `rt:${createHash('sha256').update(token).digest('hex')}`
                        : `ip:${(req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip}`
                },
            },
        },
        // A route carrying its own `config.rateLimit` gets ONLY that hook —
        // @fastify/rate-limit's `onRoute` listener adds the global limiter's
        // hook exclusively in its `else if (globalParams.global)` branch,
        // which never runs once `routeOptions.config.rateLimit` is set (see
        // node_modules/.pnpm/@fastify+rate-limit@10.3.0/node_modules/@fastify/rate-limit/index.js).
        // So the per-token budget above is this route's ENTIRE defence: an
        // attacker who mints a fresh random token on every request lands in a
        // brand-new bucket each time and is never throttled by it, and every
        // such request still costs a SHA-256 plus an indexed lookup.
        //
        // `refreshIpCeiling` (defined above, built with
        // `fastify.createRateLimit(...)`) is a second, independent limiter
        // that restores an IP-keyed backstop without shadowing the per-token
        // budget above it — see the long comment on `checkIpCeiling` for why
        // `fastify.rateLimit(...)` (the earlier, wrong attempt at this) can't
        // be used here.
        onRequest: refreshIpCeiling,
        schema: {
            body: zodToJsonSchema(RefreshTokenSchema),
        },
        handler: AuthController.refresh,
    })

    fastify.post('/logout', {
        schema: {
            body: zodToJsonSchema(LogoutSchema),
        },
        handler: AuthController.logout,
    })

    fastify.get('/me', {
        preValidation: [fastify.authenticate],
        handler: AuthController.me,
    })

    fastify.post('/change-password', {
        preValidation: [fastify.authenticate],
        config: {
            rateLimit: {
                max: 5,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(ChangePasswordSchema),
        },
        handler: AuthController.changePassword,
    })

    fastify.post('/telegram', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute',
            },
        },
        schema: {
            body: zodToJsonSchema(TelegramAuthSchema),
        },
        handler: AuthController.telegramLogin,
    })
}

export default authRoutes

