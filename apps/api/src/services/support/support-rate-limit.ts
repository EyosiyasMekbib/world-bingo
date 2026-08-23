import redis from '../../lib/redis'

/** The Fastify rate-limit plugin is per-route and does not see socket traffic,
 *  so support messages need their own counter. */
export const MESSAGES_PER_MINUTE = 20

export class SupportRateLimit {
  /** Returns true when the message is allowed. */
  static async checkMessage(userId: string): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000)
    const key = `support:msg:${userId}:${minute}`

    try {
      const count = await redis.incr(key)
      // Only the first increment needs a TTL — re-setting it on every
      // message would slide the window forward and never expire the key.
      if (count === 1) await redis.expire(key, 60)
      return count <= MESSAGES_PER_MINUTE
    } catch {
      // Fail open. A widget that goes silent because Redis blipped is a
      // worse outcome than an unenforced limit for one minute.
      return true
    }
  }
}
