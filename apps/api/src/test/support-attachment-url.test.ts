import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isSafeAttachmentUrl } from '../services/support/attachment-url.js'

// The allowlist is read from process.env on every call (not cached at
// module load), specifically so each test below can set exactly the env it
// needs without bleeding into the next. Snapshot and restore the whole
// object rather than deleting individual keys, so a test that forgets to
// clean up still can't leak into another.
const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  delete process.env.MINIO_ENDPOINT
  delete process.env.GCS_BUCKET
  delete process.env.SUPPORT_ATTACHMENT_HOSTS
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('isSafeAttachmentUrl', () => {
  it('accepts a relative /uploads/ path (local storage shape)', () => {
    expect(isSafeAttachmentUrl('/uploads/1234-abcd.png')).toBe(true)
  })

  describe('default (no storage host configured)', () => {
    it('rejects any absolute URL when the allowlist is empty — the safe default', () => {
      expect(isSafeAttachmentUrl('https://storage.googleapis.com/bucket/receipts/x.png')).toBe(
        false,
      )
      expect(isSafeAttachmentUrl('http://minio.internal:9000/receipts/x.png')).toBe(false)
      expect(isSafeAttachmentUrl('https://example.com/x.png')).toBe(false)
    })
  })

  describe('exact-host allowlist', () => {
    it('accepts an absolute URL on an exactly-matching allowed host', () => {
      process.env.SUPPORT_ATTACHMENT_HOSTS = 'storage.googleapis.com'
      expect(isSafeAttachmentUrl('https://storage.googleapis.com/bucket/receipts/x.png')).toBe(true)
    })

    it('rejects a subdomain of an allowed host', () => {
      process.env.SUPPORT_ATTACHMENT_HOSTS = 'storage.googleapis.com'
      expect(isSafeAttachmentUrl('https://sub.storage.googleapis.com/x.png')).toBe(false)
    })

    it('rejects a host that merely starts with an allowed host as a substring prefix', () => {
      process.env.SUPPORT_ATTACHMENT_HOSTS = 'storage.googleapis.com'
      expect(isSafeAttachmentUrl('https://evilstorage.googleapis.com/x.png')).toBe(false)
    })

    it('rejects a host that merely ends with an allowed host as a substring suffix', () => {
      process.env.SUPPORT_ATTACHMENT_HOSTS = 'storage.googleapis.com'
      expect(isSafeAttachmentUrl('https://storage.googleapis.com.evil.com/x.png')).toBe(false)
    })

    it('rejects a userinfo spoof — the allowed host as userinfo, an attacker host as the real host', () => {
      process.env.SUPPORT_ATTACHMENT_HOSTS = 'storage.googleapis.com'
      // `new URL()` parses `.host` as `evil.com` here; `storage.googleapis.com`
      // is only the (ignored) userinfo/username portion of the authority.
      expect(isSafeAttachmentUrl('https://storage.googleapis.com@evil.com/x')).toBe(false)
    })

    it('is case-insensitive on the host', () => {
      process.env.SUPPORT_ATTACHMENT_HOSTS = 'Storage.GoogleAPIs.com'
      expect(isSafeAttachmentUrl('https://STORAGE.googleapis.COM/x.png')).toBe(true)
    })
  })

  describe('configuration sources', () => {
    it('honours SUPPORT_ATTACHMENT_HOSTS as a comma-separated, trimmed, empty-dropping list', () => {
      process.env.SUPPORT_ATTACHMENT_HOSTS = ' cdn.example.com ,, other.example.com,'
      expect(isSafeAttachmentUrl('https://cdn.example.com/x.png')).toBe(true)
      expect(isSafeAttachmentUrl('https://other.example.com/x.png')).toBe(true)
      expect(isSafeAttachmentUrl('https://unrelated.example.com/x.png')).toBe(false)
    })

    it('honours the host of MINIO_ENDPOINT when set', () => {
      process.env.MINIO_ENDPOINT = 'https://minio.internal:9000'
      expect(isSafeAttachmentUrl('https://minio.internal:9000/receipts/x.png')).toBe(true)
      // A different port is a different `.host` and must not match.
      expect(isSafeAttachmentUrl('https://minio.internal:9001/receipts/x.png')).toBe(false)
    })

    it('parses MINIO_ENDPOINT with new URL() rather than string-slicing it', () => {
      // A trailing slash or path on the endpoint must not defeat host
      // extraction — new URL().host ignores everything past the authority.
      process.env.MINIO_ENDPOINT = 'http://minio.internal/'
      expect(isSafeAttachmentUrl('http://minio.internal/receipts/x.png')).toBe(true)
    })

    it('adds storage.googleapis.com only when GCS_BUCKET is set', () => {
      expect(isSafeAttachmentUrl('https://storage.googleapis.com/bucket/x.png')).toBe(false)
      process.env.GCS_BUCKET = 'world-bingo-receipts'
      expect(isSafeAttachmentUrl('https://storage.googleapis.com/bucket/x.png')).toBe(true)
    })
  })

  describe('scheme rejection (must keep working regardless of host allowlisting)', () => {
    it('rejects a javascript: URL', () => {
      expect(isSafeAttachmentUrl('javascript:alert(1)')).toBe(false)
    })

    it('rejects a data: URL', () => {
      expect(isSafeAttachmentUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    })

    it('rejects a javascript: URL regardless of case', () => {
      expect(isSafeAttachmentUrl('JaVaScRiPt:alert(1)')).toBe(false)
    })

    // The case a naive `url.startsWith('/uploads/')` OR-ed with a naive
    // `url.includes('http')` check would get wrong in the other direction:
    // this string does not literally start with "/uploads/" (it starts with
    // "javascript:"), so the relative-path branch must not be fooled into
    // matching on the substring that appears later in the string.
    it('rejects javascript:/uploads/x.png — the string that defeats naive prefix matching', () => {
      expect(isSafeAttachmentUrl('javascript:/uploads/x.png')).toBe(false)
    })

    it('rejects a vbscript: URL', () => {
      expect(isSafeAttachmentUrl('vbscript:msgbox(1)')).toBe(false)
    })

    it('rejects a protocol-relative //host URL', () => {
      expect(isSafeAttachmentUrl('//evil.com/x.png')).toBe(false)
    })

    it('rejects an empty string', () => {
      expect(isSafeAttachmentUrl('')).toBe(false)
    })

    it('rejects unparseable garbage', () => {
      expect(isSafeAttachmentUrl('not a url at all')).toBe(false)
    })
  })
})
