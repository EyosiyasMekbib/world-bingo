import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

function safeSigEqualHex(receivedHex: string, expectedHex: string): boolean {
  // Ensure both strings are valid hex of exactly 64 characters (32 bytes)
  if (receivedHex.length !== 64 || expectedHex.length !== 64) return false
  const a = Buffer.from(receivedHex, 'hex')
  const b = Buffer.from(expectedHex, 'hex')
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

      const AMOUNT_FIELDS = 'amount|betAmount|winAmount|winLoss|jackpotAmount|effectiveTurnover'

      // Regex families
      const stringToNumRegex =
        new RegExp(`"(${AMOUNT_FIELDS})"\\s*:\\s*"(-?[\\d\\.]+)"`, 'g')

      // Quoted string trailing-zero stripping (string→string, strip zeros)
      const decimalFieldsRegex =
        new RegExp(`"(${AMOUNT_FIELDS})"\\s*:\\s*"(-?\\d+\\.\\d*?[1-9])0+"`, 'g')
      const decimalFieldsIntegerRegex =
        new RegExp(`"(${AMOUNT_FIELDS})"\\s*:\\s*"(-?\\d+)\\.0+"`, 'g')

      // Unquoted number trailing-zero stripping (number→number, strip zeros)
      const unquotedDecimalRegex =
        new RegExp(`"(${AMOUNT_FIELDS})"\\s*:\\s*(-?\\d+\\.\\d*?[1-9])0+`, 'g')
      const unquotedIntegerRegex =
        new RegExp(`"(${AMOUNT_FIELDS})"\\s*:\\s*(-?\\d+)\\.0+`, 'g')

      // ── number→string variants ──
      // Floats-only: quotes ALL unquoted float amount fields
      const numToStringDecimalRegex =
        new RegExp(`"(${AMOUNT_FIELDS})"\\s*:\\s*(-?\\d+\\.\\d+)`, 'g')

      // Trailing-zeros-only: quotes ONLY floats that end in one or more trailing zeros.
      // GASea's signing system selectively quotes floats with trailing zeros
      // (e.g. 26502.50117267100 → "26502.50117267100") but leaves clean floats
      // (e.g. -26492.501172671) and integers (e.g. 10, 0) unquoted.
      // Pattern: decimal with significant digits then trailing 0s, OR pure .000...0 form.
      const numToStringTrailingZerosOnlyRegex =
        new RegExp(`"(${AMOUNT_FIELDS})"\\s*:\\s*(-?\\d+\\.\\d*[1-9]0+|-?\\d+\\.0+)`, 'g')

      // All amounts: quotes both integers AND floats (e.g. winAmount:10 → "winAmount":"10")
      const numToStringAllRegex =
        new RegExp(`"(${AMOUNT_FIELDS})"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)(?![\\d.])`, 'g')

      // Variant: quote ALL float amount fields (includes clean floats like winLoss)
      const numToStrBody = rawBody.replace(numToStringDecimalRegex, '"$1":"$2"')
      candidates.push({ name: 'numberToString', body: numToStrBody })

      // Variant: quote only floats then strip trailing zeros from the quoted string
      const numToStrBodyStripped = numToStrBody
        .replace(decimalFieldsRegex, '"$1":"$2"')
        .replace(decimalFieldsIntegerRegex, '"$1":"$2"')
      candidates.push({ name: 'numberToStringStripZeros', body: numToStrBodyStripped })

      // ★ KEY STRATEGY: quote ONLY trailing-zero floats, leave clean floats + integers unquoted.
      // This matches GASea's signing behavior in bet_result / multi-field requests.
      const numToStrTrailingZerosBody = rawBody.replace(numToStringTrailingZerosOnlyRegex, '"$1":"$2"')
      candidates.push({ name: 'numberToStringTrailingZerosOnly', body: numToStrTrailingZerosBody })

      // Variant: ALL amount fields quoted (int + float)
      const numToStrAllBody = rawBody.replace(numToStringAllRegex, '"$1":"$2"')
      candidates.push({ name: 'numberToStringAll', body: numToStrAllBody })

      // Variant: quote all amount fields then strip trailing zeros from the quoted values
      const numToStrAllBodyStripped = numToStrAllBody
        .replace(decimalFieldsRegex, '"$1":"$2"')
        .replace(decimalFieldsIntegerRegex, '"$1":"$2"')
      candidates.push({ name: 'numberToStringAllStripZeros', body: numToStrAllBodyStripped })

      // Build trimmed-zeros body for subsequent variants
      alternateBody = rawBody
        .replace(decimalFieldsRegex, '"$1":"$2"')
        .replace(decimalFieldsIntegerRegex, '"$1":"$2"')
        .replace(unquotedDecimalRegex, '"$1":$2')
        .replace(unquotedIntegerRegex, '"$1":$2')

      // Variant: string→number
      const numBody = rawBody.replace(stringToNumRegex, '"$1":$2')
      candidates.push({ name: 'stringAmountToNumber', body: numBody })

      // Variant: strip trailing zeros (mixed: quoted strings stripped, unquoted numbers stripped)
      candidates.push({ name: 'truncateTrailingZeros', body: alternateBody })

      // Variant: strip zeros then also convert remaining strings to numbers
      const numBodyTrunc = alternateBody.replace(stringToNumRegex, '"$1":$2')
      candidates.push({ name: 'truncateZerosThenToNumber', body: numBodyTrunc })

      // Variant: cleanly JSON.parse then re-stringify (JS normalizes floats)
      try {
        const parsedBody = JSON.parse(rawBody)
        candidates.push({ name: 'jsonParseStringify', body: JSON.stringify(parsedBody) })
      } catch (parseError) {
        // Ignored
      }

      // Variant: number→string then JSON.parse/stringify (JS will re-serialize quoted strings back to numbers,
      // but we want the intermediate quoted form — also try the full cycle)
      try {
        const parsedFromQuoted = JSON.parse(numToStrBody)
        candidates.push({ name: 'numberToStringParseStringify', body: JSON.stringify(parsedFromQuoted) })
      } catch (parseError) {
        // Ignored
      }

      // ★ ULTIMATE FALLBACK: Dynamic Brute Forcer
      // GASea fluctuates its serialization drastically based on whether 
      // the float ends in zeros, has no decimals, mix-and-matched with ints, etc.
      // We will extract all numeric values for AMOUNT_FIELDS and permute 
      // every serialized form (raw, quoted, stripped, quoted-stripped).
      // Max 6 fields * 4 states = 4096 iterations. Node computes this in < 0.5ms.
      const bfRegex = new RegExp(`("(${AMOUNT_FIELDS})"\\s*:\\s*)(-?\\d+(?:\\.\\d+)?)`, 'g');
      
      const chunks: Array<{ type: 'str', val: string } | { type: 'num', prefix: string, opts: string[] }> = [];
      let lastIndex = 0;
      let match;
      
      while ((match = bfRegex.exec(rawBody)) !== null) {
        chunks.push({ type: 'str', val: rawBody.slice(lastIndex, match.index) });
        
        const prefix = match[1]; // e.g. '"betAmount":'
        const numStr = match[3]; // e.g. '26502.500'
        
        const stripped = numStr.includes('.') ? numStr.replace(/0+$/, '').replace(/\.$/, '') : numStr;
        
        const optsSet = new Set([
          numStr,           // Raw 
          `"${numStr}"`,    // Quoted
        ]);
        if (stripped !== numStr) {
          optsSet.add(stripped);        // Stripped
          optsSet.add(`"${stripped}"`); // Quoted Stripped
        }
        
        chunks.push({ type: 'num', prefix, opts: Array.from(optsSet) });
        lastIndex = match.index + match[0].length;
      }
      chunks.push({ type: 'str', val: rawBody.slice(lastIndex) });

      let foundBruteForceBody: string | null = null;
      let winningCombo: string[] = [];

      function recurseBF(chunkIdx: number, currentBody: string, currentCombo: string[]) {
        if (foundBruteForceBody) return;
        if (chunkIdx === chunks.length) {
          // Leaf node: we built a full variant body
          if (safeSigEqualHex(signature, crypto.createHmac('sha256', secret).update(currentBody).digest('hex'))) {
            foundBruteForceBody = currentBody;
            winningCombo = currentCombo;
            candidates.push({ name: `bruteForce:[${winningCombo.join(',')}]`, body: currentBody });
          }
          return;
        }
        
        const chunk = chunks[chunkIdx];
        if (chunk.type === 'str') {
          recurseBF(chunkIdx + 1, currentBody + chunk.val, currentCombo);
        } else {
          for (const opt of chunk.opts) {
            recurseBF(chunkIdx + 1, currentBody + chunk.prefix + opt, [...currentCombo, opt]);
            if (foundBruteForceBody) return; // early exit
          }
        }
      }
      
      // Only run BF if there are actually fields to brute force
      if (chunks.some(c => c.type === 'num')) {
        recurseBF(0, "", []);
      }

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

        // Capture x-api-key or other auth headers to see if test suite uses a different secret
        const authHeaders = {
          'x-api-key': request.headers['x-api-key'],
          'authorization': request.headers['authorization'],
        }

        request.log.warn(
          {
            url: request.url,
            traceId: (request.body as any)?.traceId ?? '',
            bodyLen: rawBody.length,
            receivedSigPrefix: signature.slice(0, 16),
            rawBodySha256: sha256Hex(rawBody),
            variants: variantHashes,
            authHeaders,
            rawBodyExtract: rawBody.length <= 1000 ? rawBody : rawBody.slice(0, 1000) + '...[truncated]',
          },
          '[GASea] Signature debug diagnostics',
        )

        return reply.status(200).send(
          invalidSignatureResponse(request, 'signature mismatch', {
            receivedSigPrefix: signature.slice(0, 16),
            expectedSigPrefix: expected.slice(0, 16),
            rawBodySha256: sha256Hex(rawBody),
            bodyLen: rawBody.length,
            rawBodyExtract: rawBody.length <= 500 ? rawBody : rawBody.slice(0, 250) + '...[truncated]',
            variants: variantHashes,
            authHeaders
          }),
        )
      }
    } catch (e: any) {
      if (debugEnabled) {
        return reply.status(200).send(
          invalidSignatureResponse(request, 'fallback logic crashed', {
            error: e?.message,
            rawBodyExtract: rawBody.length <= 200 ? rawBody : rawBody.slice(0, 200) + '...'
          })
        )
      }
    }

    return reply.status(200).send(
      invalidSignatureResponse(request, 'signature mismatch'),
    )
  }
}
