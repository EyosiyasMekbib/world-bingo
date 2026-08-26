import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import Fastify from 'fastify'

vi.mock('../lib/prisma', () => ({
  default: { zareCashEvent: { create: vi.fn() } },
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
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(BODY) },
    })
    expect(res.statusCode).toBe(200)
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
