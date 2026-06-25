import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadDeploymentConfig } from '../gateways/hub/deployment-config.js'

const KEYS = [
  'DEPLOYMENT_ROLE',
  'DEPLOYMENT_CODE',
  'HUB_DEPLOYMENTS',
  'HUB_URL',
  'HUB_SHARED_SECRET',
]
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('deployment-config', () => {
  it('defaults to standalone with no env', () => {
    expect(loadDeploymentConfig().role).toBe('standalone')
  })

  it('parses a hub config with a spoke registry', () => {
    process.env.DEPLOYMENT_ROLE = 'hub'
    process.env.DEPLOYMENT_CODE = 'h00'
    process.env.HUB_DEPLOYMENTS = JSON.stringify([
      { code: 's01', baseUrl: 'https://s01', secret: 'sec1' },
    ])
    const cfg = loadDeploymentConfig()
    expect(cfg.role).toBe('hub')
    expect(cfg.code).toBe('h00')
    expect(cfg.spokes.get('s01')).toEqual({ code: 's01', baseUrl: 'https://s01', secret: 'sec1' })
  })

  it('parses a spoke config', () => {
    process.env.DEPLOYMENT_ROLE = 'spoke'
    process.env.DEPLOYMENT_CODE = 's01'
    process.env.HUB_URL = 'https://hub'
    process.env.HUB_SHARED_SECRET = 'sec1'
    const cfg = loadDeploymentConfig()
    expect(cfg.role).toBe('spoke')
    expect(cfg.hubUrl).toBe('https://hub')
    expect(cfg.hubSecret).toBe('sec1')
  })

  it('throws when a non-standalone role has an invalid code', () => {
    process.env.DEPLOYMENT_ROLE = 'spoke'
    process.env.DEPLOYMENT_CODE = 'BAD'
    expect(() => loadDeploymentConfig()).toThrow(/DEPLOYMENT_CODE/)
  })

  it('throws on an unrecognized DEPLOYMENT_ROLE', () => {
    process.env.DEPLOYMENT_ROLE = 'huub'
    expect(() => loadDeploymentConfig()).toThrow(/DEPLOYMENT_ROLE/)
  })
})
