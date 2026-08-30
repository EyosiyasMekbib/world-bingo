import Redis from 'ioredis'

/** The Fastify rate-limit plugin is per-route and does not see socket traffic,
 *  so support messages need their own counter. */
export const MESSAGES_PER_MINUTE = 20

/**
 * A dedicated client rather than the shared `lib/redis.ts` one.
 *
 * The shared client is plain ioredis defaults — `enableOfflineQueue: true`,
 * `maxRetriesPerRequest: 20`, exponential backoff — which is exactly right for
 * game state and the countdown workers: they want a command issued during a
 * two-second reconnect to be queued and delivered, not lost. But this counter
 * is the FIRST thing `support:send` awaits, and under those settings a Redis
 * blip makes `incr` neither resolve nor reject for tens of seconds, so every
 * message the widget sends hangs instead of failing into the catch below.
 *
 * `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` make a down Redis
 * reject immediately, which turns a total outage into an unenforced limit for
 * its duration instead of a support widget that has stopped sending. A
 * `Promise.race` timeout would not do this: the original command would stay
 * pending and stay queued, so a sustained outage would grow the offline queue
 * without bound.
 */
const limiterRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
})

// ioredis emits 'error' on an unreachable server; without a listener Node
// treats it as an unhandled 'error' event and takes the process down.
limiterRedis.on('error', (err) => {
  console.error('[SupportRateLimit] Redis error:', err.message)
})

export class SupportRateLimit {
  /** Returns true when the message is allowed. */
  static async checkMessage(userId: string): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000)
    const key = `support:msg:${userId}:${minute}`

    try {
      const count = await limiterRedis.incr(key)
      // Only the first increment needs a TTL — re-setting it on every
      // message would slide the window forward and never expire the key.
      if (count === 1) await limiterRedis.expire(key, 60)
      return count <= MESSAGES_PER_MINUTE
    } catch {
      // Fail open. A widget that goes silent because Redis blipped is a
      // worse outcome than an unenforced limit for one minute.
      return true
    }
  }
}
