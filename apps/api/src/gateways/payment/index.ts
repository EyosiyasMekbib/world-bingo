import type { PaymentGateway } from './payment-gateway.interface'
import { ManualPaymentGateway } from './manual.gateway'

/**
 * Payment Gateway Registry
 *
 * Register concrete gateway implementations and resolve by name.
 * Default gateway is "manual" (receipt-upload flow).
 */

const registry = new Map<string, PaymentGateway>()

// Register the default manual gateway
registry.set('manual', new ManualPaymentGateway())

/**
 * Register a payment gateway implementation.
 */
export function registerPaymentGateway(gateway: PaymentGateway): void {
    registry.set(gateway.name, gateway)
}

/**
 * Get a payment gateway by name. Falls back to "manual" if not found.
 */
export function getPaymentGateway(name?: string): PaymentGateway {
    const key = name ?? 'manual'
    const gateway = registry.get(key)
    if (!gateway) {
        throw new Error(`Payment gateway "${key}" is not registered. Available: ${[...registry.keys()].join(', ')}`)
    }
    return gateway
}

/**
 * List all registered gateway names.
 */
export function listPaymentGateways(): string[] {
    return [...registry.keys()]
}

// Re-export types
export type { PaymentGateway, InitiatePaymentInput, PaymentResult, PaymentStatusResult, PaymentStatusValue } from './payment-gateway.interface'
