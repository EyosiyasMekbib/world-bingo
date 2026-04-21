import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

function safeSigEqualHex(receivedHex: string, expectedHex: string): boolean {
  const a = Buffer.from(receivedHex, 'utf8')
  const b = Buffer.from(expectedHex, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function invalidSignatureResponse(
  request: FastifyRequest,
  problem: string,
  debug?: Record<string, unknown>,
) {
  const response: Record<string, unknown> = {
    traceId: (request.body as any)?.traceId ?? '',
    status: 'SC_INVALID_SIGNATURE',
  }

  if (debug && process.env.GASEA_SIGNATURE_DEBUG === 'true') {
    response.debug = {
      problem,
      ...debug,
    }
  }

  return response
}

/**
 * Resolve API_SECRET lazily so dotenv.config() has a chance to run first
 * (ESM evaluates imports before the importing module body).
 */
let _secret: string | null = null
function getSecret(): string {
  if (!_secret) {
    const s = (process.env.GASEA_API_SECRET ?? '').trim()
    if (!s) {
      // Do NOT cache empty — re-read on every call until the env var is set
      console.warn('[GASea] WARNING: GASEA_API_SECRET is empty — all signature checks will fail')
      return ''
    }
    _secret = s
  }
  return _secret
}

/**
 * Fastify preHandler that verifies the X-Signature header sent by GASea on
 * every wallet callback.
 *
 * Per GASea Seamless Wallet API v3.1.0: X-Signature = HMAC-SHA256(secret, rawBody).
 * The entire request body (including token) is signed.
 *
 * rawBody is set by the custom content type parser in wallet.ts.
 * All responses are HTTP 200 — GASea interprets non-200 as a network failure.
 */
export async function verifyGaseaSignature(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  let signature = request.headers['x-signature']

  if (!signature || typeof signature !== 'string') {
    request.log.warn('[GASea] Missing X-Signature header on %s', request.url)
    return reply.status(200).send(
      invalidSignatureResponse(request, 'missing x-signature header'),
    )
  }

  // Normalize signature format (some gateways might append spaces or uppercase it)
  signature = signature.trim().toLowerCase()

  const rawBody: string | undefined = (request as any).rawBody
  if (!rawBody) {
    request.log.error(
      '[GASea] rawBody not set on %s — content type parser did not fire',
      request.url,
    )
    return reply.status(200).send(
      invalidSignatureResponse(request, 'raw body not captured'),
    )
  }

  const secret = getSecret()
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const debugEnabled = process.env.GASEA_SIGNATURE_DEBUG === 'true'

  // Constant-time comparison to prevent timing attacks
  if (!safeSigEqualHex(signature, expected)) {
    request.log.warn(
      '[GASea] Signature mismatch on %s | received=%s expected=%s bodyLen=%d',
      request.url,
      signature,
      expected,
      rawBody.length,
    )

    // As a fallback for 8.06.02, attempt parsing with trailing 0 stripped off numbers if they look like strings
    // This is a temporary hack for GASea sometimes rounding decimal values in their signature generation

    let alternateBody = rawBody
    try {
      const candidates: Array<{ name: string; body: string }> = [{ name: 'raw', body: rawBody }]

      // GASea testing servers inconsistently format numeric fields before signing (sometimes stripping trailing zeros or quotes).
      // This regex targets all the decimal properties we know GASea uses: amount, betAmount, winAmount, winLoss, jackpotAmount, effectiveTurnover
      const decimalFieldsRegex =
        /"(amount|betAmount|winAmount|winLoss|jackpotAmount|effectiveTurnover)"\s*:\s*"(-?\d+\.\d*?[1-9])0+"/g
      const decimalFieldsIntegerRegex =
        /"(amount|betAmount|winAmount|winLoss|jackpotAmount|effectiveTurnover)"\s*:\s*"(-?\d+)\.0+"/g
      const stringToNumRegex =
        /"(amount|betAmount|winAmount|winLoss|jackpotAmount|effectiveTurnover)"\s*:\s*"(-?[\d\.]+)"/g

      // Also handle unquoted variations just in case GASea generated the signature with trailing zeros truncated on unquoted numbers
      const unquotedDecimalRegex =
        /"(amount|betAmount|winAmount|winLoss|jackpotAmount|effectiveTurnover)"\s*:\s*(-?\d+\.\d*?[1-9])0+/g
      const unquotedIntegerRegex =
        /"(amount|betAmount|winAmount|winLoss|jackpotAmount|effectiveTurnover)"\s*:\s*(-?\d+)\.0+/g

      alternateBody = alternateBody.replace(decimalFieldsRegex, '"$1":"$2"')
      alternateBody = alternateBody.replace(decimalFieldsIntegerRegex, '"$1":"$2"')
      alternateBody = alternateBody.replace(unquotedDecimalRegex, '"$1":$2')
      alternateBody = alternateBody.replace(unquotedIntegerRegex, '"$1":$2')

      // Try formatting as integer / float instead of string
      const numBody = rawBody.replace(stringToNumRegex, '"$1":$2')
      candidates.push({ name: 'stringAmountToNumber', body: numBody })

      // Try formatting with string zeros truncated
      candidates.push({ name: 'truncateTrailingZeros', body: alternateBody })

      // Try number format but with truncated 0s
      const numBodyTrunc = alternateBody.replace(stringToNumRegex, '"$1":$2')
      candidates.push({ name: 'truncateZerosThenToNumber', body: numBodyTrunc })

      // Try fallback where GASea may have signed a cleanly parsed and re-stringified JSON
      // (Javascript JSON.stringify inherently formats numbers as short as possible, matching many engines)
      const parsedBody = JSON.parse(rawBody)
      candidates.push({ name: 'jsonParseStringify', body: JSON.stringify(parsedBody) })

      for (const candidate of candidates) {
        const expectedCandidate = crypto
          .createHmac('sha256', secret)
          .update(candidate.body)
          .digest('hex')

        if (safeSigEqualHex(signature, expectedCandidate)) {
          if (candidate.name !== 'raw') {
            request.log.info(
              '[GASea] Signature accepted via fallback=%s on %s',
              candidate.name,
              request.url,
            )
          }
          return // Valid
        }
      }

      if (debugEnabled) {
        const variantHashes = candidates.map((candidate) => ({
          strategy: candidate.name,
          bodySha256: sha256Hex(candidate.body),
          expectedSigPrefix: crypto
            .createHmac('sha256', secret)
            .update(candidate.body)
            .digest('hex')
            .slice(0, 16),
        }))

        request.log.warn(
          {
            url: request.url,
            traceId: (request.body as any)?.traceId ?? '',
            bodyLen: rawBody.length,
            receivedSigPrefix: signature.slice(0, 16),
            rawBodySha256: sha256Hex(rawBody),
            variants: variantHashes,
          },
          '[GASea] Signature debug diagnostics',
        )

        return reply.status(200).send(
          invalidSignatureResponse(request, 'signature mismatch', {
            receivedSigPrefix: signature.slice(0, 16),
            expectedSigPrefix: expected.slice(0, 16),
            rawBodySha256: sha256Hex(rawBody),
            bodyLen: rawBody.length,
            variants: variantHashes,
          }),
        )
      }
    } catch (e) {}

    return reply.status(200).send(
      invalidSignatureResponse(request, 'signature mismatch'),
    )
  }
}
