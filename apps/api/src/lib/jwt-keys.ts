import * as dotenv from 'dotenv'
dotenv.config()

// Resolve JWT keys: prefer base64-encoded (safe for .env files), fall back to raw
function resolveJwtKey(base64EnvVar: string, rawEnvVar: string): string {
    const b64 = process.env[base64EnvVar]
    if (b64) return Buffer.from(b64, 'base64').toString('utf-8')
    const raw = process.env[rawEnvVar]
    if (raw) return raw.replace(/\\n/g, '\n')
    return ''
}

export const jwtPrivateKey = resolveJwtKey('JWT_PRIVATE_KEY_BASE64', 'JWT_PRIVATE_KEY')
export const jwtPublicKey = resolveJwtKey('JWT_PUBLIC_KEY_BASE64', 'JWT_PUBLIC_KEY')
