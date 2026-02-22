import type {
    PaymentGateway,
    InitiatePaymentInput,
    PaymentResult,
    PaymentStatusResult,
    PaymentStatusValue,
} from './payment-gateway.interface'

/**
 * Manual Payment Gateway — the current receipt-based flow.
 *
 * "Initiate" simply returns a success with no checkout URL
 * because the user uploads a screenshot manually.
 * "Verify" always returns PENDING since verification is done by an admin.
 */
export class ManualPaymentGateway implements PaymentGateway {
    readonly name = 'manual'

    async initiatePayment(input: InitiatePaymentInput): Promise<PaymentResult> {
        // Manual flow — nothing to call externally.
        // The user uploads a receipt and the admin approves it.
        return {
            success: true,
            gatewayRef: input.transactionId,
            message: 'Manual payment — upload your receipt for admin verification.',
        }
    }

    async verifyPayment(transactionId: string): Promise<PaymentStatusResult> {
        // In the manual flow, verification is done by admin review.
        // Return PENDING; admin approve/decline changes the status.
        return {
            status: 'PENDING' as PaymentStatusValue,
            gatewayRef: transactionId,
        }
    }

    async handleWebhook(_payload: unknown): Promise<{ transactionId: string; status: PaymentStatusValue }> {
        throw new Error('Manual gateway does not support webhooks')
    }
}
