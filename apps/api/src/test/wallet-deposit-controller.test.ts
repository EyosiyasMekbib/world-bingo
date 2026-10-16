import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'

vi.mock('../services', () => ({
  WalletService: { initiateDeposit: vi.fn() },
}))
vi.mock('../lib/storage', () => ({
  uploadFile: vi.fn().mockResolvedValue({ url: 'https://files.test/receipt.png' }),
  validateFile: vi.fn(),
}))
vi.mock('../services/event.service.js', () => ({
  EventService: { record: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../services/bonus-grant-query.service', () => ({ BonusGrantQueryService: {} }))
vi.mock('../services/zarecash-checkout.service.js', () => ({ ZareCashCheckoutService: {} }))

import { WalletService } from '../services'
import { WalletController } from '../controllers/wallet.controller'
import { mapErrorToResponse } from '../lib/error-handler'

const BOUNDARY = 'walletDepositTestBoundary'
const headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }

function receiptDeposit(amount: string): Buffer {
  const field = (name: string, value: string) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  return Buffer.concat([
    Buffer.from(
      field('amount', amount) +
        field('transactionId', 'TLB12345') +
        field('senderName', 'Abebe') +
        field('senderAccount', '0911234567') +
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="receipt"; filename="r.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from(`\r\n` + field('methodCode', 'telebirr') + `--${BOUNDARY}--\r\n`),
  ])
}

async function buildApp() {
  const app = Fastify({ logger: false })
  app.setErrorHandler(mapErrorToResponse)
  await app.register(multipart)
  app.post(
    '/wallet/deposit',
    {
      preHandler: async (req: any) => {
        req.user = { id: 'user-1' }
      },
    },
    WalletController.deposit,
  )
  await app.ready()
  return app
}

describe('POST /wallet/deposit (receipt upload)', () => {
  beforeEach(() => vi.clearAllMocks())

  // Winner takes deposits from 50 ETB. The floor is the deployment's
  // min_deposit_amount, which WalletService.initiateDeposit enforces; the
  // controller used to reject anything under 200 before it got there.
  it('hands an amount under 200 to WalletService instead of rejecting it', async () => {
    ;(WalletService.initiateDeposit as any).mockResolvedValue({ id: 'tx-1', amount: 50 })
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/deposit',
      headers,
      payload: receiptDeposit('50'),
    })

    expect(res.statusCode).toBe(201)
    expect(WalletService.initiateDeposit).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ amount: 50, methodCode: 'telebirr' }),
    )
  })

  // The deposit form shows `data.error` first. The app's default error mapping
  // puts the error's class name there ("Error"), which would hide the floor.
  it('returns the brand floor WalletService reports as the error text', async () => {
    ;(WalletService.initiateDeposit as any).mockRejectedValue(
      Object.assign(new Error('Minimum deposit amount is 50 Birr'), { statusCode: 400 }),
    )
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/deposit',
      headers,
      payload: receiptDeposit('49'),
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Minimum deposit amount is 50 Birr')
    expect(WalletService.initiateDeposit).toHaveBeenCalledWith('user-1', expect.objectContaining({ amount: 49 }))
  })

  it('still rejects a missing or non-positive amount', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/deposit',
      headers,
      payload: receiptDeposit('0'),
    })

    expect(res.statusCode).toBe(400)
    expect(WalletService.initiateDeposit).not.toHaveBeenCalled()
  })
})
