/**
 * Method routing and configuration.
 *
 * `MethodConfigSource` is the seam described in the spec: today the collection
 * account is mirrored by hand into PaymentMethod.merchantAccount, because
 * ZareCash exposes no GET /v1/methods. When that endpoint ships, add a remote
 * source here and change the export below — nothing else moves.
 */

import prisma from '../../../lib/prisma.js'

export interface CollectionAccount {
  receiverName: string | null
  account: string | null
}

export interface ResolvedMethod {
  code: string
  name: string
  gateway: string
  /** The methodCode ZareCash expects. Falls back to our own code. */
  gatewayMethodCode: string
  collectionAccount: CollectionAccount
}

export interface MethodConfigSource {
  resolve(code: string): Promise<ResolvedMethod | null>
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number; value: ResolvedMethod | null }>()

/** Mirrored source: reads the account an operator typed into our own admin panel. */
class MirroredMethodConfigSource implements MethodConfigSource {
  async resolve(code: string): Promise<ResolvedMethod | null> {
    const row = await prisma.paymentMethod.findUnique({ where: { code } })
    if (!row) return null
    return {
      code: row.code,
      name: row.name,
      gateway: row.gateway ?? 'manual',
      gatewayMethodCode: row.gatewayMethodCode ?? row.code,
      collectionAccount: { receiverName: row.merchantName, account: row.merchantAccount },
    }
  }
}

const source: MethodConfigSource = new MirroredMethodConfigSource()

export async function resolveMethod(
  code: string | null | undefined,
): Promise<ResolvedMethod | null> {
  if (!code) return null
  const hit = cache.get(code)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const value = await source.resolve(code)
  cache.set(code, { at: Date.now(), value })
  return value
}

export async function isZareCashMethod(code: string | null | undefined): Promise<boolean> {
  const m = await resolveMethod(code)
  return m?.gateway === 'zarecash'
}

/** Test seam, and the hook an admin-side config change should call. */
export function clearMethodCache(): void {
  cache.clear()
}
