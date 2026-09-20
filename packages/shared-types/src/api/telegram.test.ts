import { describe, it, expect } from 'vitest'
import { TelegramNotifyPatchSchema, PasswordResetConsumeSchema } from './index'

describe('TelegramNotifyPatchSchema', () => {
    it('accepts a boolean notifyEnabled', () => {
        expect(TelegramNotifyPatchSchema.safeParse({ notifyEnabled: true }).success).toBe(true)
        expect(TelegramNotifyPatchSchema.safeParse({ notifyEnabled: false }).success).toBe(true)
    })

    it('rejects a missing or non-boolean value', () => {
        expect(TelegramNotifyPatchSchema.safeParse({}).success).toBe(false)
        expect(TelegramNotifyPatchSchema.safeParse({ notifyEnabled: 'yes' }).success).toBe(false)
    })
})

describe('PasswordResetConsumeSchema', () => {
    it('accepts a real-shaped token and a password of at least 6 chars', () => {
        expect(
            PasswordResetConsumeSchema.safeParse({
                token: 'a'.repeat(32),
                newPassword: 'secret1',
            }).success,
        ).toBe(true)
    })

    it('rejects a short token — the link would never have been minted with one', () => {
        expect(
            PasswordResetConsumeSchema.safeParse({ token: 'short', newPassword: 'secret1' }).success,
        ).toBe(false)
    })

    it('rejects a password under 6 characters, same floor as registration', () => {
        expect(
            PasswordResetConsumeSchema.safeParse({ token: 'a'.repeat(32), newPassword: '123' }).success,
        ).toBe(false)
    })
})
