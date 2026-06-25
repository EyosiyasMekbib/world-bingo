import { describe, it, expect } from 'vitest'
import { decideCallbackRoute } from '../gateways/hub/route-callback.js'
import type { DeploymentConfig } from '../gateways/hub/deployment-config.js'

const hubCfg: DeploymentConfig = {
  role: 'hub',
  code: 'h00',
  spokes: new Map([['s01', { code: 's01', baseUrl: 'https://s01', secret: 'sec1' }]]),
  hubUrl: '',
  hubSecret: '',
}

describe('decideCallbackRoute', () => {
  it("routes the hub's own account locally with the prefix stripped", () => {
    const r = decideCallbackRoute(hubCfg, 'h00' + 'a'.repeat(32))
    expect(r).toEqual({ kind: 'local', account: 'a'.repeat(32) })
  })

  it('routes a spoke account to that spoke with the prefix stripped', () => {
    const r = decideCallbackRoute(hubCfg, 's01' + 'b'.repeat(32))
    expect(r).toEqual({ kind: 'forward', account: 'b'.repeat(32), spoke: hubCfg.spokes.get('s01') })
  })

  it('returns unknown for an unregistered deployment code', () => {
    const r = decideCallbackRoute(hubCfg, 'zzz' + 'c'.repeat(32))
    expect(r.kind).toBe('unknown')
  })

  it('standalone always routes locally without stripping', () => {
    const std: DeploymentConfig = {
      role: 'standalone',
      code: '',
      spokes: new Map(),
      hubUrl: '',
      hubSecret: '',
    }
    const r = decideCallbackRoute(std, 'a'.repeat(32))
    expect(r).toEqual({ kind: 'local', account: 'a'.repeat(32) })
  })
})
