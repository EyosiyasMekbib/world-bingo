import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ZareCashClient } from '../gateways/payment/zarecash/client'
import { ZareCashError } from '../gateways/payment/zarecash/types'

const CFG = {
  enabled: true,
  baseUrl: 'https://zc.test',
  apiKey: 'pk_test_ABC',
  webhookSecret: 'whsec',
  mode: 'test' as const,
  timeoutMs: 5000,
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('ZareCashClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends the api key and idempotency key on a deposit', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        id: 'dp_1',
        status: 'APPROVED',
        playerRef: 'u1',
        mode: 'test',
        statedAmount: 500,
        approvedAmount: 500,
        amount: 500,
        receiptRef: 'ABC',
        verdict: 'CLEAN_MATCH',
      }),
    )
    const client = new ZareCashClient(CFG)
    const res = await client.createDeposit(
      { playerRef: 'u1', amount: 500, methodCode: 'telebirr', receiptRef: 'ABC' },
      'dep_tx1',
    )

    expect(res.id).toBe('dp_1')
    expect(res.approvedAmount).toBe(500)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://zc.test/v1/deposits')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('pk_test_ABC')
    expect(init.headers['Idempotency-Key']).toBe('dep_tx1')
    expect(JSON.parse(init.body)).toEqual({
      playerRef: 'u1',
      amount: 500,
      methodCode: 'telebirr',
      receiptRef: 'ABC',
    })
  })

  it('maps duplicate_receipt to a permanent ZareCashError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: 'duplicate_receipt', message: 'Transaction ID already used' }),
    )
    const client = new ZareCashClient(CFG)
    await expect(
      client.createDeposit(
        { playerRef: 'u1', amount: 500, methodCode: 'telebirr', receiptRef: 'ABC' },
        'dep_tx1',
      ),
    ).rejects.toMatchObject({ code: 'duplicate_receipt', status: 409, permanent: true })
  })

  it('treats withdrawal_pending as NOT permanent', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: 'withdrawal_pending', message: 'open payout' }),
    )
    const client = new ZareCashClient(CFG)
    await expect(
      client.createWithdrawal(
        { playerRef: 'u1', amount: 500, methodCode: 'telebirr', destinationAccount: '0911' },
        'wd_tx1',
      ),
    ).rejects.toMatchObject({ code: 'withdrawal_pending', permanent: false })
  })

  it('surfaces retryAfterSeconds on 429', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        429,
        { error: 'rate_limited', message: 'slow down', retryAfterSeconds: 42 },
        { 'retry-after': '42' },
      ),
    )
    const client = new ZareCashClient(CFG)
    await expect(client.getFloat()).rejects.toMatchObject({
      code: 'rate_limited',
      permanent: false,
      retryAfterSeconds: 42,
    })
  })

  it('treats a 500 as retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'server_error', message: 'boom' }))
    const client = new ZareCashClient(CFG)
    await expect(client.getFloat()).rejects.toMatchObject({ permanent: false, status: 500 })
  })

  it('wraps a network failure as a retryable error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new ZareCashClient(CFG)
    await expect(client.getFloat()).rejects.toMatchObject({
      code: 'network_error',
      permanent: false,
    })
  })

  it('omits undefined optional fields from the withdrawal body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, {
        id: 'wd_1',
        state: 'pending',
        playerRef: 'u1',
        amount: 500,
        destinationAccount: '0911',
        destinationName: null,
        settlementRef: null,
      }),
    )
    const client = new ZareCashClient(CFG)
    await client.createWithdrawal(
      { playerRef: 'u1', amount: 500, methodCode: 'telebirr', destinationAccount: '0911' },
      'wd_tx1',
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      playerRef: 'u1',
      amount: 500,
      methodCode: 'telebirr',
      destinationAccount: '0911',
    })
  })

  /**
   * Final-review Important 4 / deferred minor T4. `request()` returned
   * `null as T` for a 2xx with an empty or unparseable body, and every caller
   * then acted on a lie. `assertMode` read `float.mode` off that null OUTSIDE the
   * try wrapping getFloat(), so a truncated 200 threw a TypeError — inside
   * index.ts's exit-on-throw block, taking the entire API down over a payment
   * provider's bad response. Fail here, at the source.
   */
  describe('a 2xx with no usable body', () => {
    it('raises a retryable ZareCashError instead of returning null for getFloat', async () => {
      // A fresh Response per call — a body can only be consumed once.
      fetchMock.mockImplementation(async () => new Response('', { status: 200 }))
      const client = new ZareCashClient(CFG)

      await expect(client.getFloat()).rejects.toBeInstanceOf(ZareCashError)
      await expect(client.getFloat()).rejects.toMatchObject({
        code: 'invalid_response',
        permanent: false,
      })
    })

    it('raises on an unparseable (truncated) 200 body', async () => {
      fetchMock.mockResolvedValue(
        new Response('{"mode":"te', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
      const client = new ZareCashClient(CFG)
      await expect(client.getFloat()).rejects.toMatchObject({ code: 'invalid_response' })
    })

    it('raises on an empty body from a mutating call too', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 201 }))
      const client = new ZareCashClient(CFG)
      await expect(
        client.createWithdrawal(
          { playerRef: 'u1', amount: 500, methodCode: 'telebirr', destinationAccount: '0911' },
          'wd_tx1',
        ),
      ).rejects.toMatchObject({ code: 'invalid_response' })
    })

    it('still tolerates an empty body on freeze/unfreeze, whose response we never read', async () => {
      fetchMock.mockImplementation(async () => new Response('', { status: 200 }))
      const client = new ZareCashClient(CFG)
      await expect(client.freezePlayer('u1', 'fraud review')).resolves.toBeNull()
      await expect(client.unfreezePlayer('u1', 'cleared')).resolves.toBeNull()
    })

    it('still surfaces a non-2xx as its own error, not invalid_response', async () => {
      fetchMock.mockResolvedValue(new Response('', { status: 503 }))
      const client = new ZareCashClient(CFG)
      await expect(client.getFloat()).rejects.toMatchObject({ code: 'http_503' })
    })
  })

  it('reads float without an idempotency key', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        mode: 'test',
        balance: 1000,
        reserved: 0,
        available: 1000,
        lowFloatThreshold: 100,
        queuedWithdrawals: 0,
      }),
    )
    const client = new ZareCashClient(CFG)
    const f = await client.getFloat()
    expect(f.mode).toBe('test')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://zc.test/v1/float')
    expect(init.headers['Idempotency-Key']).toBeUndefined()
  })
})
