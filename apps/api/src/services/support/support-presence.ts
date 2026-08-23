import redis from '../../lib/redis'

/** Set of staff user ids with a live support socket, across all API instances. */
const KEY = 'support:agents:online'

export class SupportPresence {
  static async markOnline(agentId: string): Promise<void> {
    await redis.sadd(KEY, agentId)
  }

  static async markOffline(agentId: string): Promise<void> {
    await redis.srem(KEY, agentId)
  }

  /**
   * Whether anyone is on shift. Drives the contact fallback: escalating with
   * nobody online must hand the player a phone number, not silence.
   */
  static async anyOnline(): Promise<boolean> {
    return (await redis.scard(KEY)) > 0
  }
}
