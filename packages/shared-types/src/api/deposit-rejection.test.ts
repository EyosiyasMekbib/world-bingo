import { describe, it, expect } from 'vitest'
import {
    DeclineTransactionSchema,
    DEPOSIT_REJECTION_REASON_LABELS,
    DEPOSIT_REJECTION_NEXT_STEP,
    STATUS_CATEGORY_LABELS,
} from './index'
import { DepositRejectionReason } from '../enums'

describe('DeclineTransactionSchema', () => {
    it('accepts a coded reason without a note', () => {
        expect(DeclineTransactionSchema.safeParse({ reason: 'AMOUNT_MISMATCH' }).success).toBe(true)
    })

    it('requires a note for OTHER, reported on the note field', () => {
        const res = DeclineTransactionSchema.safeParse({ reason: 'OTHER' })
        expect(res.success).toBe(false)
        expect(res.error?.issues[0].path).toEqual(['note'])
    })

    it('does not count a whitespace-only note for OTHER', () => {
        expect(DeclineTransactionSchema.safeParse({ reason: 'OTHER', note: '   ' }).success).toBe(false)
    })

    it('accepts OTHER with a note', () => {
        expect(
            DeclineTransactionSchema.safeParse({ reason: 'OTHER', note: 'Paid to the wrong merchant' }).success,
        ).toBe(true)
    })

    it('rejects an unknown reason', () => {
        expect(DeclineTransactionSchema.safeParse({ reason: 'BLURRY' }).success).toBe(false)
    })

    it('accepts a note-only or empty body — withdrawals still send just a note', () => {
        expect(DeclineTransactionSchema.safeParse({ note: 'Invalid account' }).success).toBe(true)
        expect(DeclineTransactionSchema.safeParse({}).success).toBe(true)
    })

    it('rejects a note over 500 characters', () => {
        expect(DeclineTransactionSchema.safeParse({ reason: 'OTHER', note: 'x'.repeat(501) }).success).toBe(false)
    })
})

describe('DEPOSIT_REJECTION_REASON_LABELS', () => {
    it('has a non-empty label for every reason', () => {
        for (const reason of Object.values(DepositRejectionReason)) {
            expect(DEPOSIT_REJECTION_REASON_LABELS[reason]).toMatch(/\S/)
        }
    })
})

describe('DEPOSIT_REJECTION_NEXT_STEP', () => {
    it('has a non-empty next step for every reason', () => {
        for (const reason of Object.values(DepositRejectionReason)) {
            expect(DEPOSIT_REJECTION_NEXT_STEP[reason]).toMatch(/\S/)
        }
    })
})

describe('STATUS_CATEGORY_LABELS', () => {
    it('covers every category AccountStatusService can write', () => {
        // Mirrors AccountStatusService.STATUS_CATEGORIES — kept as a literal
        // list rather than an import so this package never depends on the API.
        const categories = ['RECEIPT_FRAUD', 'CHARGEBACK', 'BONUS_ABUSE', 'MULTI_ACCOUNT', 'OTHER']
        for (const category of categories) {
            expect(STATUS_CATEGORY_LABELS[category]).toMatch(/\S/)
        }
    })
})
