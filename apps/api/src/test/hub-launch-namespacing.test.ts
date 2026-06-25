import { describe, it, expect, afterEach } from 'vitest'
import { accountForLaunch } from '../routes/game-provider/account-for-launch.js'

const KEYS = ['DEPLOYMENT_ROLE', 'DEPLOYMENT_CODE', 'HUB_URL', 'HUB_SHARED_SECRET']
afterEach(() => { for (const k of KEYS) delete process.env[k] })

describe('accountForLaunch', () => {
  const uuidHex = 'a'.repeat(32)

  it('standalone returns the bare hex account', () => {
    process.env.DEPLOYMENT_ROLE = 'standalone'
    expect(accountForLaunch(uuidHex)).toBe(uuidHex)
  })

  it('hub prepends its own deployment code', () => {
    process.env.DEPLOYMENT_ROLE = 'hub'; process.env.DEPLOYMENT_CODE = 'h00'
    expect(accountForLaunch(uuidHex)).toBe('h00' + uuidHex)
  })

  it('spoke leaves it bare — the hub namespaces it', () => {
    process.env.DEPLOYMENT_ROLE = 'spoke'; process.env.DEPLOYMENT_CODE = 's01'
    process.env.HUB_URL = 'https://hub'; process.env.HUB_SHARED_SECRET = 'x'
    expect(accountForLaunch(uuidHex)).toBe(uuidHex)
  })
})
