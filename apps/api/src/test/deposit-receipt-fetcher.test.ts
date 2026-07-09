import { describe, it, expect } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import {
  classifyReceiptResponse,
  buildAgent,
  spkiPin,
  checkSpkiPin,
  parsePins,
} from '../services/deposit-verification/receipt-fetcher'

// Throwaway self-signed certs (CN=transactioninfo.ethiotelecom.et), generated offline.
// GENUINE is the "real" host key; ATTACKER is a different key = forgery attempt.
const GENUINE_PEM = `-----BEGIN CERTIFICATE-----
MIIDNTCCAh2gAwIBAgIUQS21SgZZkB8a+fzWY1K1URXVkjQwDQYJKoZIhvcNAQEL
BQAwKjEoMCYGA1UEAwwfdHJhbnNhY3Rpb25pbmZvLmV0aGlvdGVsZWNvbS5ldDAe
Fw0yNjA3MDgxODQ0MDlaFw0zNjA3MDUxODQ0MDlaMCoxKDAmBgNVBAMMH3RyYW5z
YWN0aW9uaW5mby5ldGhpb3RlbGVjb20uZXQwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQC8JssRUxUL+ucDAUorAWkvbiKc/+qGHkUsYpRxrURURP5JVA9i
07l9NhRsjytBWAjEry4Sa91xQiRSoONNQY0Q9T2murjlX3ZF3biIso35IvHK++GS
McJweAh/LVXtdMQ0Idj36zQ4gaqMa+FFvs7AfiCnWoJl2ojpe88sHPzYL+bvhJqR
qx6A7rmAcTsmbOrMvteGsoaj5vNqo1rUoZROQoGhJGTu7sQYeImaeXUZdW3HuX/t
OoEn/9V1WLscOtBtds9xouqr9k0CJxUnJ5vpCu7aafpb3mj/G5pRW5t4Z+ZiPxr/
YfWTkEuPapijU4Cv6fliSu8dLVpgy+MWf3lBAgMBAAGjUzBRMB0GA1UdDgQWBBQV
I8Ko1mzwiDkHL0ZFBr8R51D60DAfBgNVHSMEGDAWgBQVI8Ko1mzwiDkHL0ZFBr8R
51D60DAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAtC0CN0jX1
0zsqatOAzK/IOgwzqaT0toBTosnTyRdhdQRVlTLXjbFYccAwAE2APjg2skAZ1H/e
WdUbPvbJw3zvJOvP+rRyeUMb2ixpwUwbro4TfgirdXZXwWC2KNJAvjK83DFociFI
PkGNaPr+MbL8BFlxq341MU1xHpHOoP3RNIfEUtYufI8pEpXLoMgWTowvrq8lCFq/
qoJK1IsMee7+Z8MzjGgB7wMZHTINGxToDVeXkbsPK01S9T/L8gVWnaobc/oWrnKx
RUqeuNk3RThQnWeoZwjl493m5XpudcudEhz91oQ3Luzlf3AyuwDC1NLZmgTltVNS
HmNrFBOCjxLh
-----END CERTIFICATE-----`
const ATTACKER_PEM = `-----BEGIN CERTIFICATE-----
MIIDNTCCAh2gAwIBAgIUAqSp/AAMZshb6T5BKZLr8wLVmsowDQYJKoZIhvcNAQEL
BQAwKjEoMCYGA1UEAwwfdHJhbnNhY3Rpb25pbmZvLmV0aGlvdGVsZWNvbS5ldDAe
Fw0yNjA3MDgxODQ0MDlaFw0zNjA3MDUxODQ0MDlaMCoxKDAmBgNVBAMMH3RyYW5z
YWN0aW9uaW5mby5ldGhpb3RlbGVjb20uZXQwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQDQj8JllJctmSjBp1mdAp4mYbfpORtPFXIYvxkNXB5TfAMHBVXJ
LyKhfnUhSnUwohcZ0vCPThXQSu2d2Tu4PWQNyDNtxFiaNi6ZPIP/fWNxDbWHMKmi
KKBF2+l2nV6+iAgWA8ByysDw72OuELBMs/mMpK57ec+8Azed5ollZCAm3fr4XYAS
qbkq24xHRp37c5p/WoutDEtIUcPR83zJTpS+zxz9BuV2Q/9kFYOXccj0b/RP0TGY
PMQ6SWkqV//wte4/+5wdZMtEkafKXPoB+tRsQ7LdGfWSnnWtrumie5OxIbQRvJbw
dfFuVS2AWD81yFMt/K6or2IyYLqZLD7+VN4pAgMBAAGjUzBRMB0GA1UdDgQWBBQT
W2HiJ6P6xxnI4wgqn056cUPacDAfBgNVHSMEGDAWgBQTW2HiJ6P6xxnI4wgqn056
cUPacDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA42OiiIVA0
8qwJ//BN0+rPzmnSEAwQP1O7n2tUeJccPWCg+WvWsi7oE15xgjwMHCF1pIdgh2Cs
aRrz6/jk0fametr5qt3DQYHa4nhXfTv+TkvslfVDgglBZBIgBvqk6a8Ux+fAX+tY
JsdI9mZVzZqhLRBCnJlGPXSsIbSkTmjPIzxHd6wgdluCdGqJTVn0YyAzAO2nk6IQ
Dk7iZKQSAa2x+a4RDzWgIYaDxfXTlk19f3nm6g0Z8u3YsGQUZ0PQSDnN+8b9pr/U
wuB/J6dvT44N+JHwd4axv+zg73WuxkCT0iWKcWX3MZLIAy3uFScfP3larXI3h5ef
zgoBxIZR2e+I
-----END CERTIFICATE-----`
const GENUINE_SPKI = '9BShxdA7MPV6rRx93DAxai4fPQm5hBtA/VSWRofZHKc='
const ATTACKER_SPKI = 'FF2RIA0QFgQymfv0hy262YA4Vjariyzbo8UO4g95Vws='
const genuineDer = new X509Certificate(GENUINE_PEM).raw
const attackerDer = new X509Certificate(ATTACKER_PEM).raw

describe('classifyReceiptResponse', () => {
  it('flags a 429 as RATE_LIMITED', () => {
    const r = classifyReceiptResponse(429, 'application/json', '{"success":false,"message":"Rate limit exceeded"}')
    expect(r).toEqual({ kind: 'unavailable', reason: 'RATE_LIMITED' })
  })
  it('flags a JSON rate-limit body even on 200', () => {
    const r = classifyReceiptResponse(
      200,
      'application/json',
      '{"success":false,"message":"Rate limit exceeded. Please try again later."}',
    )
    expect(r).toEqual({ kind: 'unavailable', reason: 'RATE_LIMITED' })
  })
  it('treats 5xx as UNREACHABLE', () => {
    expect(classifyReceiptResponse(503, 'text/html', 'oops')).toEqual({ kind: 'unavailable', reason: 'UNREACHABLE' })
  })
  it('treats 404 as NOT_FOUND', () => {
    expect(classifyReceiptResponse(404, 'text/html', 'nope')).toEqual({ kind: 'unavailable', reason: 'NOT_FOUND' })
  })
  it('returns html for a 200 text/html receipt', () => {
    const r = classifyReceiptResponse(200, 'text/html', '<html>receipt</html>')
    expect(r).toEqual({ kind: 'html', html: '<html>receipt</html>' })
  })
})

describe('buildAgent', () => {
  it('returns a plain https agent when no proxy is set', () => {
    const a = buildAgent(undefined)
    expect(a).toBeInstanceOf(require('node:https').Agent)
    expect(a).not.toBeInstanceOf(HttpsProxyAgent)
    expect(a).not.toBeInstanceOf(SocksProxyAgent)
  })
  it('uses an HTTPS proxy agent for http(s):// proxies', () => {
    expect(buildAgent('http://user:pass@1.2.3.4:8080')).toBeInstanceOf(HttpsProxyAgent)
  })
  it('uses a SOCKS proxy agent for socks:// proxies', () => {
    expect(buildAgent('socks5://1.2.3.4:1080')).toBeInstanceOf(SocksProxyAgent)
  })
})

describe('spkiPin', () => {
  it('derives the sha256/base64 SPKI pin from a DER cert', () => {
    expect(spkiPin(genuineDer)).toBe(GENUINE_SPKI)
    expect(spkiPin(attackerDer)).toBe(ATTACKER_SPKI)
  })
})

describe('parsePins', () => {
  it('splits, trims and drops empties', () => {
    expect(parsePins(` ${GENUINE_SPKI} , ${ATTACKER_SPKI} ,`)).toEqual([GENUINE_SPKI, ATTACKER_SPKI])
  })
  it('returns [] for empty/undefined', () => {
    expect(parsePins('')).toEqual([])
    expect(parsePins(undefined)).toEqual([])
  })
})

describe('checkSpkiPin', () => {
  it('passes through when no pins are configured (legacy/shadow mode)', () => {
    // empty pin set = unpinned: accept any cert (this is the ONLY safe-for-shadow path)
    expect(checkSpkiPin(attackerDer, [])).toEqual({ ok: true })
  })
  it('accepts a cert whose SPKI matches a configured pin', () => {
    expect(checkSpkiPin(genuineDer, [GENUINE_SPKI])).toEqual({ ok: true })
  })
  it('accepts when the matching pin is anywhere in the allowed set (rotation)', () => {
    expect(checkSpkiPin(genuineDer, [ATTACKER_SPKI, GENUINE_SPKI])).toEqual({ ok: true })
  })
  it('REJECTS a forged cert (different key, same CN) when a pin is set', () => {
    expect(checkSpkiPin(attackerDer, [GENUINE_SPKI])).toEqual({ ok: false, got: ATTACKER_SPKI })
  })
})
