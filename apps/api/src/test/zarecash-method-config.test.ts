import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: { paymentMethod: { findUnique: vi.fn() } },
}))

import prisma from '../lib/prisma'
import {
  resolveMethod,
  isZareCashMethod,
  clearMethodCache,
} from '../gateways/payment/zarecash/method-config'

describe('method routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearMethodCache()
  })

  it('returns null for an unknown method code', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue(null)
    expect(await resolveMethod('nope')).toBeNull()
    expect(await isZareCashMethod('nope')).toBe(false)
  })

  it('reports a manual method as not zarecash', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'cbe',
      name: 'CBE',
      gateway: 'manual',
      gatewayMethodCode: null,
      merchantAccount: '1000',
      merchantName: 'Us',
    })
    expect(await isZareCashMethod('cbe')).toBe(false)
  })

  it('reports an opted-in method as zarecash', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'telebirr',
      name: 'TeleBirr',
      gateway: 'zarecash',
      gatewayMethodCode: 'telebirr',
      merchantAccount: '0911552200',
      merchantName: 'ZareCash Merchant',
    })
    expect(await isZareCashMethod('telebirr')).toBe(true)
    const m = await resolveMethod('telebirr')
    expect(m?.gatewayMethodCode).toBe('telebirr')
    expect(m?.collectionAccount).toEqual({
      receiverName: 'ZareCash Merchant',
      account: '0911552200',
    })
  })

  it('falls back to the local code when gatewayMethodCode is unset', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'telebirr',
      name: 'TeleBirr',
      gateway: 'zarecash',
      gatewayMethodCode: null,
      merchantAccount: '0911',
      merchantName: null,
    })
    expect((await resolveMethod('telebirr'))?.gatewayMethodCode).toBe('telebirr')
  })

  it('falls back to the local code when gatewayMethodCode is an empty string', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'telebirr',
      name: 'TeleBirr',
      gateway: 'zarecash',
      gatewayMethodCode: '',
      merchantAccount: '0911',
      merchantName: null,
    })
    expect((await resolveMethod('telebirr'))?.gatewayMethodCode).toBe('telebirr')
  })

  it('falls back to the local code when gatewayMethodCode is whitespace-only', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'telebirr',
      name: 'TeleBirr',
      gateway: 'zarecash',
      gatewayMethodCode: '   ',
      merchantAccount: '0911',
      merchantName: null,
    })
    expect((await resolveMethod('telebirr'))?.gatewayMethodCode).toBe('telebirr')
  })

  it('caches within the TTL and refetches after clearing', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'telebirr',
      name: 'TeleBirr',
      gateway: 'zarecash',
      gatewayMethodCode: 'telebirr',
      merchantAccount: '0911',
      merchantName: 'ZC',
    })
    await resolveMethod('telebirr')
    await resolveMethod('telebirr')
    expect((prisma as any).paymentMethod.findUnique).toHaveBeenCalledTimes(1)
    clearMethodCache()
    await resolveMethod('telebirr')
    expect((prisma as any).paymentMethod.findUnique).toHaveBeenCalledTimes(2)
  })

  it('treats a null method code as manual', async () => {
    expect(await isZareCashMethod(null)).toBe(false)
    expect((prisma as any).paymentMethod.findUnique).not.toHaveBeenCalled()
  })
})
