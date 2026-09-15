// Node 25 shadows jsdom's localStorage with an inert global; same polyfill as store/auth.test.ts.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const existing = (globalThis as Record<string, any>)[name]
  if (!existing || typeof existing.clear !== 'function') {
    const store = new Map<string, string>()
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: unknown) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size
        },
      },
    })
  }
}

import { describe, it, expect, beforeEach } from 'vitest'
import { recallSenderName, rememberSenderName, SENDER_NAME_KEY } from './deposit'

beforeEach(() => localStorage.clear())

describe('sender name memory', () => {
  it('recalls nothing on a fresh browser', () => {
    expect(recallSenderName()).toBe('')
  })

  it('recalls the trimmed name from the last submitted deposit', () => {
    rememberSenderName('  Abebe Kebede ')
    expect(recallSenderName()).toBe('Abebe Kebede')
  })

  it('does not overwrite a remembered name with a blank one', () => {
    rememberSenderName('Abebe')
    rememberSenderName('   ')
    expect(localStorage.getItem(SENDER_NAME_KEY)).toBe('Abebe')
  })

  it('never throws when storage access throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      expect(recallSenderName()).toBe('')
      expect(() => rememberSenderName('Abebe')).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as Record<string, unknown>).localStorage
    }
  })
})
