import { describe, it, expect } from 'vitest'
import {
    getPaymentGateway,
    registerPaymentGateway,
    listPaymentGateways,
} from '../gateways/payment'
import type { PaymentGateway, InitiatePaymentInput, PaymentResult, PaymentStatusResult, PaymentStatusValue } from '../gateways/payment'

describe('Payment Gateway Abstraction (T22)', () => {
    describe('ManualPaymentGateway (default)', () => {
        it('should be registered by default', () => {
            const names = listPaymentGateways()
            expect(names).toContain('manual')
        })

        it('should resolve the manual gateway', () => {
            const gw = getPaymentGateway('manual')
            expect(gw.name).toBe('manual')
        })

        it('should resolve manual gateway when no name is provided', () => {
            const gw = getPaymentGateway()
            expect(gw.name).toBe('manual')
        })

        it('initiatePayment should return success with no checkout URL', async () => {
            const gw = getPaymentGateway('manual')
            const result = await gw.initiatePayment({
                transactionId: 'tx-123',
                amount: 500,
                payerPhone: '+251911000000',
            })

            expect(result.success).toBe(true)
            expect(result.gatewayRef).toBe('tx-123')
            expect(result.checkoutUrl).toBeUndefined()
        })

        it('verifyPayment should return PENDING', async () => {
            const gw = getPaymentGateway('manual')
            const status = await gw.verifyPayment('tx-123')

            expect(status.status).toBe('PENDING')
        })

        it('handleWebhook should throw (not supported)', async () => {
            const gw = getPaymentGateway('manual')
            await expect(gw.handleWebhook({})).rejects.toThrow('does not support webhooks')
        })
    })

    describe('Registry', () => {
        it('should throw for unregistered gateway', () => {
            expect(() => getPaymentGateway('nonexistent')).toThrow('not registered')
        })

        it('should register and resolve a custom gateway', async () => {
            const mockGateway: PaymentGateway = {
                name: 'test-gateway',
                async initiatePayment(input: InitiatePaymentInput): Promise<PaymentResult> {
                    return { success: true, gatewayRef: 'mock-ref', checkoutUrl: 'https://pay.test/checkout' }
                },
                async verifyPayment(txId: string): Promise<PaymentStatusResult> {
                    return { status: 'COMPLETED' as PaymentStatusValue, gatewayRef: 'mock-ref' }
                },
                async handleWebhook(payload: unknown) {
                    return { transactionId: 'tx-1', status: 'COMPLETED' as PaymentStatusValue }
                },
            }

            registerPaymentGateway(mockGateway)

            const gw = getPaymentGateway('test-gateway')
            expect(gw.name).toBe('test-gateway')

            const result = await gw.initiatePayment({
                transactionId: 'tx-1',
                amount: 100,
                payerPhone: '+251911000000',
            })
            expect(result.checkoutUrl).toBe('https://pay.test/checkout')

            const status = await gw.verifyPayment('tx-1')
            expect(status.status).toBe('COMPLETED')

            const names = listPaymentGateways()
            expect(names).toContain('test-gateway')
        })
    })
})
