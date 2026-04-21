import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

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
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }

    // Normalize signature format (some gateways might append spaces or uppercase it)
    signature = signature.trim().toLowerCase()

    const rawBody: string | undefined = (request as any).rawBody
    if (!rawBody) {
        request.log.error('[GASea] rawBody not set on %s — content type parser did not fire', request.url)
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }

    const secret = getSecret()
    const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex')

    // Constant-time comparison to prevent timing attacks
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        request.log.warn(
            '[GASea] Signature mismatch on %s | received=%s expected=%s bodyLen=%d',
            request.url, signature, expected, rawBody.length,
        )
        
        // As a fallback for 8.06.02, attempt parsing with trailing 0 stripped off numbers if they look like strings
        // This is a temporary hack for GASea sometimes rounding decimal values in their signature generation
        
        let alternateBody = rawBody;
        try {
            const bodyObj = JSON.parse(rawBody);
            // GASea incorrectly stringifies amounts like "11614.99882734100" but seems to sign them as numeric `11614.998827341` when generating X-Signature or conversely, signs the JSON differently.
            // Check if we can produce the correct signature by removing trailing zeros from string number representations
            alternateBody = rawBody.replace(/"amount"\s*:\s*"(\d+\.\d*?[1-9])0+"/g, '"amount":"$1"');
            alternateBody = alternateBody.replace(/"amount"\s*:\s*"(\d+)\.0+"/g, '"amount":"$1"');
            
            // Try formatting as integer / float instead of string
            const numBody = rawBody.replace(/"amount"\s*:\s*"([\d\.]+)"/g, '"amount":$1');
            const exp2 = crypto.createHmac('sha256', secret).update(numBody).digest('hex')
            if (crypto.timingSafeEqual(sigBuf, Buffer.from(exp2))) {
                return; // Valid!
            }

            // Also try formatting with string zeros truncated
            const exp3 = crypto.createHmac('sha256', secret).update(alternateBody).digest('hex')
            if (crypto.timingSafeEqual(sigBuf, Buffer.from(exp3))) {
                return; // Valid!
            }
            
            // What if it is number format but with truncated 0s
            const numBodyTrunc = alternateBody.replace(/"amount"\s*:\s*"([\d\.]+)"/g, '"amount":$1');
            const exp4 = crypto.createHmac('sha256', secret).update(numBodyTrunc).digest('hex')
            if (crypto.timingSafeEqual(sigBuf, Buffer.from(exp4))) {
                return; // Valid!
            }
        } catch(e) {}
        
        return reply.status(200).send({
            traceId: (request.body as any)?.traceId ?? '',
            status: 'SC_INVALID_SIGNATURE',
        })
    }
}
