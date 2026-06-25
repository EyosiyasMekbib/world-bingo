import { describe, it, expect } from 'vitest'
import {
  namespaceAccount,
  parseNamespacedAccount,
  isValidDeploymentCode,
} from '../gateways/hub/namespace.js'

describe('namespace', () => {
  const code = 's01'
  const acct = 'a'.repeat(32) // 32-hex style

  it('round-trips an account through namespace + parse', () => {
    const ns = namespaceAccount(code, acct)
    expect(ns).toBe('s01' + acct)
    expect(parseNamespacedAccount(ns)).toEqual({ depCode: 's01', account: acct })
  })

  it('rejects an invalid deployment code', () => {
    expect(isValidDeploymentCode('s01')).toBe(true)
    expect(isValidDeploymentCode('S1')).toBe(false) // wrong length + uppercase
    expect(isValidDeploymentCode('s_1')).toBe(false) // non-alphanumeric
    expect(() => namespaceAccount('S1', acct)).toThrow(/deployment code/i)
  })

  it('rejects a namespaced account that would exceed 40 chars', () => {
    expect(() => namespaceAccount(code, 'x'.repeat(38))).toThrow(/40/)
  })

  it('throws when parsing a string shorter than the prefix', () => {
    expect(() => parseNamespacedAccount('s0')).toThrow(/too short/i)
  })
})
