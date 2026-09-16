import { describe, it, expect } from 'vitest'
import { DeclineTransactionSchema, DEPOSIT_REJECTION_REASON_LABELS } from './index'
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
