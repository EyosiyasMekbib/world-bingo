import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB

export interface UploadResult {
    url: string
    filename: string
    size: number
    mimetype: string
}

/**
 * Validates a file before upload.
 * Throws if the file type or size is invalid.
 */
export function validateFile(mimetype: string, size: number): void {
    if (!ALLOWED_MIME_TYPES.includes(mimetype)) {
        throw new Error(`Invalid file type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`)
    }
    if (size > MAX_FILE_SIZE) {
        throw new Error('File too large. Maximum size is 5MB.')
    }
}

/**
 * Uploads a file buffer, returning a URL to access it.
 * Switches between local filesystem (dev) and GCS (prod) based on env var.
 */
export async function uploadFile(
    buffer: Buffer,
    originalFilename: string,
    mimetype: string,
): Promise<UploadResult> {
    const size = buffer.byteLength
    validateFile(mimetype, size)

    const provider = process.env.STORAGE_PROVIDER ?? 'local'

    if (provider === 'gcs') {
        return uploadToGcs(buffer, originalFilename, mimetype)
    }

    return uploadToLocal(buffer, originalFilename, mimetype)
}

// ─── Local Filesystem (Dev) ──────────────────────────────────────────────────

async function uploadToLocal(
    buffer: Buffer,
    originalFilename: string,
    mimetype: string,
): Promise<UploadResult> {
    const uploadsDir = path.resolve(process.cwd(), 'uploads')

    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true })
    }

    const ext = path.extname(originalFilename) || mimeToExt(mimetype)
    const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`
    const filePath = path.join(uploadsDir, uniqueName)

    await fs.promises.writeFile(filePath, buffer)

    const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:8080'
    const url = `${baseUrl}/uploads/${uniqueName}`

    return { url, filename: uniqueName, size: buffer.byteLength, mimetype }
}

// ─── Google Cloud Storage (Prod) ─────────────────────────────────────────────

async function uploadToGcs(
    buffer: Buffer,
    originalFilename: string,
    mimetype: string,
): Promise<UploadResult> {
    // Dynamically import to avoid requiring the package in dev
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gcs = await import('@google-cloud/storage' as any).catch(() => {
        throw new Error(
            '@google-cloud/storage is not installed. Run: pnpm add @google-cloud/storage',
        )
    }) as any

    const bucketName = process.env.GCS_BUCKET
    const projectId = process.env.GCS_PROJECT_ID

    if (!bucketName || !projectId) {
        throw new Error('GCS_BUCKET and GCS_PROJECT_ID must be set when STORAGE_PROVIDER=gcs')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = new (gcs.Storage as any)({ projectId })
    const bucket = storage.bucket(bucketName)

    const ext = path.extname(originalFilename) || mimeToExt(mimetype)
    const uniqueName = `receipts/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`

    const file = bucket.file(uniqueName)
    await file.save(buffer, { contentType: mimetype, resumable: false })

    // Return a signed URL valid for 7 days
    const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    })

    return { url: signedUrl, filename: uniqueName, size: buffer.byteLength, mimetype }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mimeToExt(mimetype: string): string {
    const map: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
    }
    return map[mimetype] ?? ''
}
