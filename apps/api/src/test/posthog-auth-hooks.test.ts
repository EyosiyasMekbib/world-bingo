import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { AuthService } from '../services/auth.service'
import type { TelegramAuthDto } from '@world-bingo/shared-types'

function makeTelegramPayload(overrides: Partial<Omit<TelegramAuthDto, 'hash'>> = {}): TelegramAuthDto {
    const base = {
        id: 8800001,
        first_name: 'Hook',
        auth_date: Math.floor(Date.now() / 1000),
        ...overrides,
    }
    const dataCheckString = Object.entries(base)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    const secretKey = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN ?? 'test_token').digest()
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
    return { ...base, hash }
}

beforeEach(() => vi.clearAllMocks())

describe('AuthService PostHog hooks', () => {
    it('register emits user_registered with person props and no PII', async () => {
        const { user } = await AuthService.register({
            username: 'ph_reg',
            phone: '+251977000001',
            password: 'password123',
        })
        expect(captureEvent).toHaveBeenCalledTimes(1)
        const [id, event, props, opts] = captureEvent.mock.calls[0]
        expect(id).toBe(user.id)
        expect(event).toBe('user_registered')
        expect(props).toEqual({ signup_method: 'phone', referred: false })
        expect(opts.set).toEqual({
            serial: user.serial,
            signup_method: 'phone',
            referred: false,
            created_at: new Date(user.createdAt).toISOString(),
        })
        expect(JSON.stringify(captureEvent.mock.calls[0])).not.toContain('+251977000001')
    })

    it('login emits user_logged_in', async () => {
        const { user } = await AuthService.register({
            username: 'ph_login',
            phone: '+251977000002',
            password: 'password123',
        })
        captureEvent.mockClear()
        await AuthService.login({ identifier: 'ph_login', password: 'password123' })
        expect(captureEvent).toHaveBeenCalledWith(user.id, 'user_logged_in', { signup_method: 'phone' })
    })

    it('first Telegram auth emits user_registered, the second user_logged_in', async () => {
        const { user } = await AuthService.telegramAuth(makeTelegramPayload())
        expect(captureEvent).toHaveBeenCalledWith(
            user.id,
            'user_registered',
            { signup_method: 'telegram', referred: false },
            expect.objectContaining({ set: expect.objectContaining({ signup_method: 'telegram' }) }),
        )
        captureEvent.mockClear()
        await AuthService.telegramAuth(makeTelegramPayload())
        expect(captureEvent).toHaveBeenCalledWith(user.id, 'user_logged_in', { signup_method: 'telegram' })
    })
})
