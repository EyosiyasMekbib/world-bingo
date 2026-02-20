import jwt from 'jsonwebtoken'

export function verifyJwt(token: string) {
    const secret = process.env.JWT_SECRET || 'super-secret-key-change-in-prod'
    return jwt.verify(token, secret) as { id: string, username: string, role: string }
}
