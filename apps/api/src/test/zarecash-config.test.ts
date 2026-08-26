import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { zarecashConfig, isZareCashEnabled } from '../gateways/payment/zarecash/config'

const ORIGINAL = { ...process.env }

describe('zarecashConfig', () => {
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('ZARECASH_')) delete process.env[k]
  })
  afterEach(() => {
    process.env = { ...ORIGINAL }
  })

  it('is disabled by default', () => {
    expect(isZareCashEnabled()).toBe(false)
  })

  it('reads a full configuration', () => {
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_BASE_URL = 'https://api.zarecash.com/'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    process.env.ZARECASH_MODE = 'test'
    const cfg = zarecashConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.baseUrl).toBe('https://api.zarecash.com') // trailing slash stripped
    expect(cfg.apiKey).toBe('pk_test_ABC')
    expect(cfg.mode).toBe('test')
    expect(cfg.timeoutMs).toBe(10000)
  })

  it('throws when enabled without an api key', () => {
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    expect(() => zarecashConfig()).toThrow(/ZARECASH_API_KEY/)
  })

  it('throws when enabled without a webhook secret', () => {
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    expect(() => zarecashConfig()).toThrow(/ZARECASH_WEBHOOK_SECRET/)
  })

  it('rejects an unknown mode', () => {
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    process.env.ZARECASH_MODE = 'staging'
    expect(() => zarecashConfig()).toThrow(/ZARECASH_MODE/)
  })
})
