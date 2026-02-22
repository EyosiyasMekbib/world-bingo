/**
 * T22 — Payment Gateway Abstraction
 *
 * A provider-agnostic interface for initiating and verifying payments.
 * Concrete implementations (Chapa, Telebirr) will be added in Tier 6 (T50, T51).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InitiatePaymentInput {
    /** Internal transaction ID used as reference */
    transactionId: string
    /** Amount in ETB */
    amount: number
    /** Payer's phone number (required by most Ethiopian gateways) */
    payerPhone: string
    /** Payer's name for receipt purposes */
    payerName?: string
    /** Short description shown on the payment page */
    description?: string
    /** URL the gateway should redirect to after payment (for web checkout) */
    returnUrl?: string
    /** URL the gateway should POST webhook events to */
    callbackUrl?: string
}

export interface PaymentResult {
    /** Whether the initiation was successful */
    success: boolean
    /** Gateway-assigned payment reference / checkout ID */
    gatewayRef?: string
    /** Checkout URL for web-redirect flows (Chapa, Telebirr USSD fallback) */
    checkoutUrl?: string
    /** Human-readable message from the gateway */
    message?: string
    /** Raw response from the gateway for debugging */
    raw?: unknown
}

export type PaymentStatusValue = 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED'

export interface PaymentStatusResult {
    status: PaymentStatusValue
    /** Gateway-assigned reference */
    gatewayRef?: string
    /** Amount confirmed by the gateway */
    confirmedAmount?: number
    /** Timestamp of the payment */
    paidAt?: Date
    /** Raw response from the gateway for debugging */
    raw?: unknown
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface PaymentGateway {
    /** Unique name of the gateway (e.g. "chapa", "telebirr", "manual") */
    readonly name: string

    /**
     * Initiate a payment (redirect the user or trigger USSD push).
     */
    initiatePayment(input: InitiatePaymentInput): Promise<PaymentResult>

    /**
     * Verify / check the status of a payment by the internal transaction ID.
     */
    verifyPayment(transactionId: string): Promise<PaymentStatusResult>

    /**
     * Handle an incoming webhook payload from the gateway.
     * Returns the internal transactionId and status.
     */
    handleWebhook(payload: unknown): Promise<{ transactionId: string; status: PaymentStatusValue }>
}
