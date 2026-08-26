import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import Fastify from 'fastify'

vi.mock('../lib/prisma', () => ({
  default: { zareCashEvent: { create: vi.fn(), findUnique: vi.fn() } },
}))
const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', () => ({
  getQueue: () => ({ add }),
  QUEUE_NAMES: { ZARECASH_EVENT: 'zarecash-event' },
}))

import prisma from '../lib/prisma'
import zarecashWebhookRoute from '../routes/zarecash/webhook'

const SECRET = 'whsec_test'

async function build() {
  const app = Fastify()
  await app.register(zarecashWebhookRoute, { prefix: '/v1/zarecash/webhook' })
  return app
}

function signed(body: string, secret = SECRET, tOverride?: number) {
  const t = tOverride ?? Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

const BODY = JSON.stringify({ id: 'evt_1', type: 'deposit.approved', created: 1, data: { id: 'dp_1' } })

describe('POST /v1/zarecash/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = SECRET
  })

  it('accepts a valid delivery, persists it, and enqueues processing', async () => {
    ;(prisma as any).zareCashEvent.create.mockResolvedValue({ id: 'evt_1' })
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(BODY) },
    })
    expect(res.statusCode).toBe(200)
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledWith({
      data: { id: 'evt_1', type: 'deposit.approved', payload: JSON.parse(BODY) },
    })
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_1' })
    await app.close()
  })

  it('rejects a bad signature without touching the database', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(BODY, 'wrong_secret') },
    })
    expect(res.statusCode).toBe(401)
    expect((prisma as any).zareCashEvent.create).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a missing signature header', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('returns 200 on redelivery without re-enqueuing', async () => {
    ;(prisma as any).zareCashEvent.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    )
    // Already processed — no reason to touch the queue again.
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue({ id: 'evt_1', processedAt: new Date() })
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(BODY) },
    })
    expect(res.statusCode).toBe(200)
    expect(add).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns 200 and re-enqueues on redelivery of an event that was inserted but never processed', async () => {
    ;(prisma as any).zareCashEvent.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    )
    // Row exists (a prior delivery got as far as the insert) but processedAt is
    // still null — the enqueue never happened (crash, Redis blip, etc). The
    // redelivery must not be dropped on the floor.
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue({ id: 'evt_1', processedAt: null })
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(BODY) },
    })
    expect(res.statusCode).toBe(200)
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_1' })
    await app.close()
  })

  it('accepts a delivery whose JSON payload smuggles its own __rawBody field, verifying against the real bytes', async () => {
    // The attacker (or just a coincidentally-named field) puts a "__rawBody" key
    // in the actual JSON payload. The real signature is computed over the real
    // wire bytes, so it still verifies — and the smuggled field must not leak
    // into the persisted envelope.
    const bodyWithDecoyField = JSON.stringify({
      id: 'evt_2', type: 'deposit.approved', created: 1, data: { id: 'dp_2' },
      __rawBody: 'attacker-supplied-nonsense',
    })
    ;(prisma as any).zareCashEvent.create.mockResolvedValue({ id: 'evt_2' })
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: bodyWithDecoyField,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(bodyWithDecoyField) },
    })
    expect(res.statusCode).toBe(200)
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledWith({
      data: {
        id: 'evt_2',
        type: 'deposit.approved',
        payload: { id: 'evt_2', type: 'deposit.approved', created: 1, data: { id: 'dp_2' } },
      },
    })
    await app.close()
  })

  it('rejects a spliced signature that smuggles __rawBody in the payload', async () => {
    // A genuinely-signed body (and its real, valid signature) that an attacker
    // has captured off the wire.
    const genuineBody = JSON.stringify({ id: 'evt_3', type: 'deposit.approved', created: 1, data: { id: 'dp_3' } })
    const genuineSignature = signed(genuineBody)

    // The attacker splices the genuine body's bytes into a "__rawBody" field of
    // a NEW payload carrying a forged event, and replays the genuine signature
    // header alongside it. Pre-fix, the route's content-type parser let this
    // decoy field win over the real captured bytes, so verification would run
    // against `genuineBody` (which matches `genuineSignature`) while the forged
    // id/type/data sailed through untouched.
    const splicedBody = JSON.stringify({
      id: 'evt_4', type: 'withdrawal.approved', created: 2, data: { id: 'wd_4' },
      __rawBody: genuineBody,
    })

    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: splicedBody,
      headers: { 'content-type': 'application/json', 'pmv2-signature': genuineSignature },
    })
    expect(res.statusCode).toBe(401)
    expect((prisma as any).zareCashEvent.create).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects an envelope with no id', async () => {
    const bad = JSON.stringify({ type: 'deposit.approved', data: {} })
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: bad,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(bad) },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
