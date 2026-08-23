import { describe, it, expect } from 'vitest'
import { isSafeAttachmentUrl } from '../services/support/attachment-url.js'

describe('isSafeAttachmentUrl', () => {
  it('accepts a relative /uploads/ path (local storage shape)', () => {
    expect(isSafeAttachmentUrl('/uploads/1234-abcd.png')).toBe(true)
  })

  it('accepts an absolute https:// URL (GCS/MinIO shape)', () => {
    expect(isSafeAttachmentUrl('https://storage.googleapis.com/bucket/receipts/x.png')).toBe(true)
  })

  it('accepts an absolute http:// URL', () => {
    expect(isSafeAttachmentUrl('http://minio.internal:9000/receipts/x.png')).toBe(true)
  })

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
