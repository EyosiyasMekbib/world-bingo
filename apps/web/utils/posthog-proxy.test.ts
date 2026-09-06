import { describe, it, expect } from 'vitest'
import { resolveIngestTarget, stripSensitiveHeaders, STRIPPED_HEADERS } from './posthog-proxy'

const TARGETS = {
  ingest: 'https://eu.i.posthog.com',
  assets: 'https://eu-assets.i.posthog.com',
}

describe('stripSensitiveHeaders', () => {
  it('drops the cookie that carries the persisted auth store', () => {
    // Exactly what h3's getProxyRequestHeaders hands over today: `cookie` is
    // not in its ignore list, and the auth store persists to a cookie.
    const forwarded = stripSensitiveHeaders({
      cookie:
        'auth=%7B%22token%22%3A%22eyJhbGciOi...%22%2C%22user%22%3A%7B%22phone%22%3A%22%2B251911...%22%7D%7D',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
      referer: 'https://arada.example/play/123',
    })

    expect(Object.keys(forwarded)).not.toContain('cookie')
    expect(Object.keys(forwarded)).not.toContain('authorization')
    expect(JSON.stringify(forwarded)).not.toContain('eyJhbGciOi')
    expect(forwarded).toEqual({
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0',
      referer: 'https://arada.example/play/123',
    })
  })

  it('matches header names case-insensitively', () => {
    const forwarded = stripSensitiveHeaders({
      Cookie: 'auth=x',
      AUTHORIZATION: 'Bearer y',
      Accept: 'application/json',
    })
    expect(Object.keys(forwarded)).toEqual(['Accept'])
  })

  it('drops undefined values so the result is fetch-safe', () => {
    expect(stripSensitiveHeaders({ 'content-type': undefined, 'x-keep': 'yes' })).toEqual({
      'x-keep': 'yes',
    })
  })

  it('strips nothing else', () => {
    expect([...STRIPPED_HEADERS]).toEqual(['cookie', 'authorization'])
  })
})

describe('resolveIngestTarget', () => {
  it('sends /ingest/static/** to the assets host', () => {
    expect(resolveIngestTarget('/ingest/static/array.js', TARGETS)).toBe(
      'https://eu-assets.i.posthog.com/static/array.js',
    )
    expect(resolveIngestTarget('/ingest/static/recorder.js?v=2', TARGETS)).toBe(
      'https://eu-assets.i.posthog.com/static/recorder.js?v=2',
    )
  })

  it('sends everything else to the ingest host', () => {
    expect(resolveIngestTarget('/ingest/e', TARGETS)).toBe('https://eu.i.posthog.com/e')
    expect(resolveIngestTarget('/ingest/e/?ip=1&_=1730000000', TARGETS)).toBe(
      'https://eu.i.posthog.com/e/?ip=1&_=1730000000',
    )
    expect(resolveIngestTarget('/ingest/s/', TARGETS)).toBe('https://eu.i.posthog.com/s/')
    expect(resolveIngestTarget('/ingest/decide/?v=3', TARGETS)).toBe(
      'https://eu.i.posthog.com/decide/?v=3',
    )
  })

  it('does not mistake a path that merely starts with "static" for the assets host', () => {
    expect(resolveIngestTarget('/ingest/staticky', TARGETS)).toBe(
      'https://eu.i.posthog.com/staticky',
    )
  })

  it('handles the bare prefix and a trailing slash on the target', () => {
    expect(resolveIngestTarget('/ingest', TARGETS)).toBe('https://eu.i.posthog.com/')
    expect(
      resolveIngestTarget('/ingest/e', { ingest: 'https://eu.i.posthog.com/', assets: '' }),
    ).toBe('https://eu.i.posthog.com/e')
  })
})
