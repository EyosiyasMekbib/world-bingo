import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import {
    FirebaseAuthError,
    __resetFirebaseCertCache,
    isFirebaseAuthEnabled,
    verifyFirebaseIdToken,
} from '../lib/firebase'

/**
 * Firebase ID token verification, exercised against a self-signed key pair
 * standing in for Google's.
 *
 * The fixtures below are a throwaway RSA key and its matching certificate,
 * generated once and committed so the suite is deterministic and offline.
 * `verifyFirebaseIdToken` only ever extracts a public key from the PEM, so the
 * certificate's subject and validity dates do not matter here; the private key
 * is a test fixture and guards nothing.
 *
 * Every test stubs `fetch` — a unit test must never reach Google, and the call
 * count is itself an assertion in the caching cases at the bottom.
 */
const TEST_KID = 'test-key-1'
const PROJECT_ID = 'arada-bingo-test'

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCMYeATsawQFagX
97vlW2YGv2IUAwB17v35qC278y+w3WKQi7ALqBZ0taxxlqiCGjqlxIt/S02xCZvK
Jgx+gA/rmGa5NAKbxon8zbAJz+DyNInxf8gz7BtDBKB2UI/rURcMuuQEip9bpjrW
qoecfrhoDdWs6w/FPB4HyCDaS1f49dpFZkojI+xEvX4GyxI6IdyGpCam7hldcsA6
LlUxBMOj2sdmueeVxPk1R/pdzM7mkkkoUKEX0hxttFvPMJA8agdQP8VTxFcrkKDe
2iPXpzV0uyc6psqE83TF7JzMTCEbw8lYXvY7+0KF8p6esdPXU3uCxqd9i7Y2bJp1
JPaGwHjjAgMBAAECggEAMEG69fonBDZ1nJuX9x1mop4qeGeZwnCf1LD327qao8lO
hxLFtxQWeBM1jqx0C5k5nN9F9sGrmNaNO729oMSj9GBku3iCBwuGRqVsRMs1b/0Y
iDBdYV/h9TVDdbh26LTs3/7kwBzo7+fiJQXk7SpweLB8yd7aAnqKdjFY/cFVoepb
KRGCJnb5sEDHV5eZx802cBjxCHJt1ApVoibogiSto+8GYLZlRfUdCWQwj3bl+xv4
aYzbIZOL9LJw2B6x1sTfyRNsop0hQ6MHhwp0vHHHWE9snLrWCNrXN7hkJzwTHZcd
uBIKvCKMMnliX0Ut4aiw8voN1mZv2BDHxm5o0tgpSQKBgQDFLLZ1dG1ij6d9JEXr
d3+jKy6WEx4nROa7lHKDPdqxw/svgaAYmUdsiQDR1nhKs2czsgDg7XeyVFtjHzMH
gYsalxE9TdfkyXoJ6rVxMsKJrlLlN4RgnnRcs0LYEp5X2DYvgmKDV8ZVU74xB7Nh
NKWu/yEj+fUVy4iSP+wg+WB4KwKBgQC2Q6CM3EpG97W4bX1BW353aMAFl9XZ/SL5
GjPDtgElpUDmb5muTRqDEiMDDl4NCC/VX1fT9J6Q5A3wRDmrasd8srDd8PX59OfP
d/tE+5/FgaOAclTXY91KPGHxIz36VbQYt6GuJ7gVqqOBxPmsZy9hSCF6n2iUVSJW
3OL7HeCuKQKBgBSBsfhFQ5scla7ONvdmVkACHbY+BsTOxbB8n+xGYphaaaVnNd9Z
EbSYCx3H0Hr0badSvASoreo+G8MTW5tMPctmKsTVc763tZmSb4x2WwU2vChavcnO
sQtzGWCfjxhTxE7soJJIbrgxHXa79kwFzbWFk0zKklLR+EI9o7FKPl5BAoGANQ6+
wAKoxLv7dHK7EbmWuSAPNhGbOVgNREKyaviioNjYabx3GlxrqVgwRQV7r4OAmTam
FJeTSU56GEVkHFh7Nfu2rQUmNdtrV+Pvi4dMXWx9sjiWJhV2J9QoFtBRjHxCbyeV
s2Lwna4M5wv2Oo/XJRSgWlfpU7TsyCiJEt0BuPECgYEAk4LP/bF4xUMDdzZj9TQs
ADXZCRpvlU0AZnjb55uV5SbwFu7JVmuTBounoA79iUWkRWIbV7PGRvw2khf3ZzRh
1NKU8Wd8JMxEFcIWEZIRzOvHIArB76neULO1XsIGsOzghkZHLVdXUDbiBWLRGqan
dl0I6akCK0syUpgwTeObNNk=
-----END PRIVATE KEY-----`

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDGTCCAgGgAwIBAgIUZSDqYzuD/ZTMRJm2/+nC03YQW3kwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQc2VjdXJldG9rZW4udGVzdDAgFw0yNjA5MTYwOTIyNDFa
GA8yMTI2MDgyMzA5MjI0MVowGzEZMBcGA1UEAwwQc2VjdXJldG9rZW4udGVzdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAIxh4BOxrBAVqBf3u+VbZga/
YhQDAHXu/fmoLbvzL7DdYpCLsAuoFnS1rHGWqIIaOqXEi39LTbEJm8omDH6AD+uY
Zrk0ApvGifzNsAnP4PI0ifF/yDPsG0MEoHZQj+tRFwy65ASKn1umOtaqh5x+uGgN
1azrD8U8HgfIINpLV/j12kVmSiMj7ES9fgbLEjoh3IakJqbuGV1ywDouVTEEw6Pa
x2a555XE+TVH+l3MzuaSSShQoRfSHG20W88wkDxqB1A/xVPEVyuQoN7aI9enNXS7
JzqmyoTzdMXsnMxMIRvDyVhe9jv7QoXynp6x09dTe4LGp32LtjZsmnUk9obAeOMC
AwEAAaNTMFEwHQYDVR0OBBYEFGc3WzUmhXwdOisqCWQb4LEtH5MdMB8GA1UdIwQY
MBaAFGc3WzUmhXwdOisqCWQb4LEtH5MdMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBACOEVRNCA+B0U/Cpr3NTJCAe9BojLcRcw8dM5D/P6EZ/U/IB
ipVrWSEz7w2eN7Bnm2rn68xGKaUaeoPNzQScEujUlsTeT1JeZ2rD1VZDC1shHe8x
iLBosqeuybVEuQIBXJg4WI0M9R7zvEJEZ017akZVBL9vSNSO2ziCk1e6BsHQeJn2
eFOTSIzXY3C+B32Edqyalxh/dqRJYjmOgbcw4Vb8ccu5nTLwaemhS6HQ14pSUlSU
tQc0+rYq+xeLx4tLsxesBHZQ0Mn4fzSM1Zj9HfobIph2BsyodIT2VFpTK/1JQH7H
mibag19lH21FkBDQgmxWgzckd4ySKjFnku4ShYk=
-----END CERTIFICATE-----`

/** A second key pair: "signed by someone else", and the key-rotation case. */
const otherKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const OTHER_PRIVATE_KEY = otherKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

function signToken(payload: Record<string, unknown> = {}, options: jwt.SignOptions = {}) {
    const now = Math.floor(Date.now() / 1000)
    return jwt.sign(
        {
            iss: `https://securetoken.google.com/${PROJECT_ID}`,
            aud: PROJECT_ID,
            sub: 'firebase-uid-1',
            auth_time: now - 10,
            iat: now - 10,
            exp: now + 3600,
            phone_number: '+251911234567',
            firebase: { identities: { phone: ['+251911234567'] }, sign_in_provider: 'phone' },
            ...payload,
        },
        TEST_PRIVATE_KEY,
        { algorithm: 'RS256', header: { alg: 'RS256', kid: TEST_KID }, ...options },
    )
}

/** Stubs the certificate endpoint. Returns the spy so callers can count fetches. */
function stubCerts(keys: Record<string, string> = { [TEST_KID]: TEST_CERT }, maxAge = 3600) {
    const fetchSpy = vi.fn(async () => ({
        ok: true,
        json: async () => keys,
        headers: new Headers({ 'cache-control': `public, max-age=${maxAge}` }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
}

async function expectRejection(promise: Promise<unknown>, code: string, statusCode?: number) {
    await expect(promise).rejects.toBeInstanceOf(FirebaseAuthError)
    const err: FirebaseAuthError = await promise.then(
        () => { throw new Error('expected a rejection') },
        (e) => e as FirebaseAuthError,
    )
    expect(err.code).toBe(code)
    if (statusCode !== undefined) expect(err.statusCode).toBe(statusCode)
    return err
}

describe('verifyFirebaseIdToken', () => {
    const originalProjectId = process.env.FIREBASE_PROJECT_ID

    beforeEach(() => {
        process.env.FIREBASE_PROJECT_ID = PROJECT_ID
        __resetFirebaseCertCache()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        if (originalProjectId === undefined) delete process.env.FIREBASE_PROJECT_ID
        else process.env.FIREBASE_PROJECT_ID = originalProjectId
    })

    it('accepts a token this project signed, and reads the phone out of the claims', async () => {
        stubCerts()

        const claims = await verifyFirebaseIdToken(signToken())

        expect(claims.uid).toBe('firebase-uid-1')
        expect(claims.phoneNumber).toBe('+251911234567')
        expect(claims.signInProvider).toBe('phone')
    })

    // The feature is env-gated per brand: a deployment with no project id must
    // refuse with 503 (retryable, "not set up here"), never 401 ("your code was
    // wrong") — nothing else in the API changes.
    it('refuses with 503 when the deployment has no project configured', async () => {
        delete process.env.FIREBASE_PROJECT_ID
        stubCerts()

        expect(isFirebaseAuthEnabled()).toBe(false)
        await expectRejection(verifyFirebaseIdToken(signToken()), 'firebase_not_configured', 503)
    })

    // aud/iss are what scope a token to ONE brand. Google's signing keys are
    // shared by every Firebase project on earth, so without these two checks a
    // token minted by anyone's project would sign a player in here.
    it('rejects a token issued for another Firebase project', async () => {
        stubCerts()
        const foreign = signToken({
            aud: 'someone-elses-project',
            iss: 'https://securetoken.google.com/someone-elses-project',
        })

        await expectRejection(verifyFirebaseIdToken(foreign), 'firebase_token_invalid', 401)
    })

    it('rejects a token whose issuer is not Google', async () => {
        stubCerts()

        await expectRejection(
            verifyFirebaseIdToken(signToken({ iss: `https://evil.example/${PROJECT_ID}` })),
            'firebase_token_invalid',
        )
    })

    it('rejects an expired token', async () => {
        stubCerts()
        const now = Math.floor(Date.now() / 1000)

        await expectRejection(
            verifyFirebaseIdToken(signToken({ iat: now - 7200, exp: now - 3600 })),
            'firebase_token_invalid',
        )
    })

    it('rejects a token signed by a key that is not Google\'s', async () => {
        stubCerts()
        const forged = jwt.sign({ sub: 'firebase-uid-1' }, OTHER_PRIVATE_KEY, {
            algorithm: 'RS256',
            audience: PROJECT_ID,
            issuer: `https://securetoken.google.com/${PROJECT_ID}`,
            header: { alg: 'RS256', kid: TEST_KID },
            expiresIn: '1h',
        })

        await expectRejection(verifyFirebaseIdToken(forged), 'firebase_token_invalid')
    })

    // The two classic JWT forgeries: drop the signature, or sign symmetrically
    // with the public key as the secret. Both are refused before any signature
    // check, on the header alone.
    it('rejects an unsigned token', async () => {
        stubCerts()
        const unsigned = jwt.sign({ sub: 'firebase-uid-1', aud: PROJECT_ID }, '', { algorithm: 'none' })

        await expectRejection(verifyFirebaseIdToken(unsigned), 'firebase_token_invalid')
    })

    it('rejects an HS256 token signed with the public certificate as the secret', async () => {
        stubCerts()
        const now = Math.floor(Date.now() / 1000)
        // Algorithm confusion: the "secret" is the certificate itself, which is
        // public. A verifier that trusted the token's own `alg` would check an
        // HMAC with the key it was about to use as an RSA public key, and this
        // would pass.
        const confused = jwt.sign(
            {
                iss: `https://securetoken.google.com/${PROJECT_ID}`,
                aud: PROJECT_ID,
                sub: 'firebase-uid-1',
                exp: now + 3600,
                phone_number: '+251911234567',
                firebase: { sign_in_provider: 'phone' },
            },
            TEST_CERT,
            { algorithm: 'HS256', header: { alg: 'HS256', kid: TEST_KID } },
        )

        await expectRejection(verifyFirebaseIdToken(confused), 'firebase_token_invalid')
    })

    it('rejects a token with no key id', async () => {
        stubCerts()

        await expectRejection(
            verifyFirebaseIdToken(signToken({}, { header: { alg: 'RS256' } })),
            'firebase_token_invalid',
        )
    })

    it('rejects a token whose sign-in happened in the future', async () => {
        stubCerts()
        const now = Math.floor(Date.now() / 1000)

        await expectRejection(
            verifyFirebaseIdToken(signToken({ auth_time: now + 3600 })),
            'firebase_token_invalid',
        )
    })

    it('rejects gibberish', async () => {
        stubCerts()

        await expectRejection(verifyFirebaseIdToken('not-a-jwt'), 'firebase_token_invalid')
    })

    it('caches the certificate set across verifications', async () => {
        const fetchSpy = stubCerts()

        await verifyFirebaseIdToken(signToken())
        await verifyFirebaseIdToken(signToken())
        await verifyFirebaseIdToken(signToken())

        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    // An unknown kid is what a key rotation looks like — but it is also what
    // unlimited forged tokens look like, so the refresh is floored at one a
    // minute. Without that floor each junk token would cost a request to Google.
    it('does not re-fetch Google\'s keys for every unknown key id', async () => {
        const fetchSpy = stubCerts()
        const strangerKid = signToken({}, { header: { alg: 'RS256', kid: 'unknown-kid' } })

        await expectRejection(verifyFirebaseIdToken(strangerKid), 'firebase_token_invalid')
        await expectRejection(verifyFirebaseIdToken(strangerKid), 'firebase_token_invalid')
        await expectRejection(verifyFirebaseIdToken(strangerKid), 'firebase_token_invalid')

        // One cold-cache load. The refresh the first unknown kid would trigger
        // is inside the floor, so it never happens again for the next two.
        expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    // Google's keys stay valid for weeks after they stop being advertised, so a
    // blip fetching them must not log everyone out.
    it('keeps verifying from a stale cache when Google cannot be reached', async () => {
        const fetchSpy = stubCerts(undefined, 0)
        await verifyFirebaseIdToken(signToken())

        fetchSpy.mockImplementation(async () => {
            throw new Error('network down')
        })

        const claims = await verifyFirebaseIdToken(signToken())
        expect(claims.uid).toBe('firebase-uid-1')
    })

    // A cold cache is the one case with nothing to fall back on. 503, not 401:
    // the player's code was fine, this server just cannot check it.
    it('refuses with 503 when the keys cannot be fetched at all', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

        await expectRejection(verifyFirebaseIdToken(signToken()), 'firebase_keys_unavailable', 503)
    })

    it('refuses with 503 when the certificate endpoint answers with an error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 500,
            json: async () => ({}),
            headers: new Headers(),
        })))

        await expectRejection(verifyFirebaseIdToken(signToken()), 'firebase_keys_unavailable', 503)
    })
})
