import { describe, it, expect, afterEach, vi } from 'vitest'
import {
    signIgcoreBody,
    verifyIgcoreSignature,
} from '../gateways/igcore/igcore-signature.js'
import { igcoreConfig, igcoreConfigured } from '../gateways/igcore/igcore-config.js'

const SECRET = 'test-secret'

describe('IGCORE callback signature', () => {
    it("signs the spec's way", () => {
        const body = '{"transaction_id":"t1","action":"bet","user_id":"89470","currency":"ETB","amount":25}'
        expect(signIgcoreBody(body, SECRET)).toBe(
            '45b686a5454d69c503e8240e3dbc52ce60550e47292d3ce914d1411278e02b10',
        )
    })

    it('signs a Buffer and the same string to the same digest', () => {
        const body = '{"amount":25}'
        expect(signIgcoreBody(Buffer.from(body), SECRET)).toBe(signIgcoreBody(body, SECRET))
    })

    it('verifies raw bytes, not a re-serialisation', () => {
        const raw = '{ "amount": 25.0, "name": "Ābebe" }'
        const header = signIgcoreBody(raw, SECRET)
        expect(verifyIgcoreSignature(Buffer.from(raw), header, SECRET)).toBe(true)
        const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw)))
        expect(verifyIgcoreSignature(reserialised, header, SECRET)).toBe(false)
    })

    it('rejects a wrong header, a different-length header, a missing header and an empty secret', () => {
        const raw = Buffer.from('{"amount":25}')
        const good = signIgcoreBody(raw, SECRET)
        const wrong = (good[0] === 'a' ? 'b' : 'a') + good.slice(1)
        expect(verifyIgcoreSignature(raw, wrong, SECRET)).toBe(false)
        expect(verifyIgcoreSignature(raw, good.slice(0, 32), SECRET)).toBe(false)
        expect(verifyIgcoreSignature(raw, undefined, SECRET)).toBe(false)
        expect(verifyIgcoreSignature(raw, signIgcoreBody(raw, ''), '')).toBe(false)
    })
})

describe('IGCORE config', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('is not configured with defaults', () => {
        vi.stubEnv('IGCORE_API_URL', '')
        vi.stubEnv('IGCORE_USERNAME', '')
        vi.stubEnv('IGCORE_PASSWORD', '')
        vi.stubEnv('IGCORE_SECURITY_HASH', '')
        expect(igcoreConfigured()).toBe(false)
    })

    it('is configured once the four required vars are set', () => {
        vi.stubEnv('IGCORE_API_URL', 'https://igcore.example.test')
        vi.stubEnv('IGCORE_USERNAME', 'u')
        vi.stubEnv('IGCORE_PASSWORD', 'p')
        vi.stubEnv('IGCORE_SECURITY_HASH', 's')
        expect(igcoreConfigured()).toBe(true)
    })

    it('is not configured when any one required var is empty', () => {
        vi.stubEnv('IGCORE_API_URL', 'https://igcore.example.test')
        vi.stubEnv('IGCORE_USERNAME', 'u')
        vi.stubEnv('IGCORE_PASSWORD', '')
        vi.stubEnv('IGCORE_SECURITY_HASH', 's')
        expect(igcoreConfigured()).toBe(false)
    })

    it('falls back to the documented defaults, including for empty-string vars', () => {
        for (const name of [
            'IGCORE_API_VERSION',
            'IGCORE_CURRENCY',
            'IGCORE_DEFAULT_LANG',
            'IGCORE_MAX_WIN_AMOUNT',
            'IGCORE_MAX_TICKET_PAYOUT',
            'IGCORE_CALLBACK_DEBUG',
            'IGCORE_SIMULATOR',
        ]) {
            vi.stubEnv(name, '')
        }
        const cfg = igcoreConfig()
        expect(cfg.apiVersion).toBe('1.0.0')
        expect(cfg.currency).toBe('ETB')
        expect(cfg.defaultLang).toBe('en')
        expect(cfg.maxWinAmount).toBe(1_000_000)
        expect(cfg.maxTicketPayout).toBe(1_000_000)
        expect(cfg.callbackDebug).toBe(false)
        expect(cfg.simulator).toBe(false)
    })

    it('reads the environment on every call', () => {
        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '500')
        expect(igcoreConfig().maxWinAmount).toBe(500)
        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '750')
        expect(igcoreConfig().maxWinAmount).toBe(750)
    })

    it('lets 0 disable each cap', () => {
        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '0')
        vi.stubEnv('IGCORE_MAX_TICKET_PAYOUT', '0')
        const cfg = igcoreConfig()
        expect(cfg.maxWinAmount).toBe(0)
        expect(cfg.maxTicketPayout).toBe(0)
    })

    it.each(['abc', '-5', '  ', 'Infinity'])('falls back to the default for the unusable cap %j', (bad) => {
        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', bad)
        vi.stubEnv('IGCORE_MAX_TICKET_PAYOUT', bad)
        const cfg = igcoreConfig()
        expect(cfg.maxWinAmount).toBe(1_000_000)
        expect(cfg.maxTicketPayout).toBe(1_000_000)
    })

    it('derives the simulator URLs from PORT and API_BASE_URL', () => {
        vi.stubEnv('PORT', '9090')
        vi.stubEnv('API_BASE_URL', 'https://api.example.test')
        vi.stubEnv('IGCORE_SIM_PUBLIC_URL', '')
        vi.stubEnv('IGCORE_SIM_CALLBACK_URL', '')
        const cfg = igcoreConfig()
        expect(cfg.simCallbackUrl).toBe('http://127.0.0.1:9090/v1/igcore')
        expect(cfg.simPublicUrl).toBe('https://api.example.test')
    })

    it('lets explicit simulator URLs win', () => {
        vi.stubEnv('IGCORE_SIM_PUBLIC_URL', 'https://pub.example.test')
        vi.stubEnv('IGCORE_SIM_CALLBACK_URL', 'http://cb.example.test/v1/igcore')
        const cfg = igcoreConfig()
        expect(cfg.simPublicUrl).toBe('https://pub.example.test')
        expect(cfg.simCallbackUrl).toBe('http://cb.example.test/v1/igcore')
    })

    it('parses the boolean flags', () => {
        vi.stubEnv('IGCORE_CALLBACK_DEBUG', 'true')
        vi.stubEnv('IGCORE_SIMULATOR', 'true')
        const cfg = igcoreConfig()
        expect(cfg.callbackDebug).toBe(true)
        expect(cfg.simulator).toBe(true)
    })
})
