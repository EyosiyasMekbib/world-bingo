// Temporary verification: upload via storage.ts, serve via the same static
// block as index.ts, in NODE_ENV=production. Deleted after verification.
import Fastify from 'fastify'
import staticFiles from '@fastify/static'
import path from 'path'
import fs from 'fs'
import { uploadFile } from './src/lib/storage.ts'

process.env.NODE_ENV = 'production'
process.env.STORAGE_PROVIDER = 'local'

const server = Fastify()

// Exact copy of the (fixed) registration block in src/index.ts
const uploadsDir = path.resolve(process.cwd(), 'uploads')
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true })
}
await server.register(staticFiles, {
    root: uploadsDir,
    prefix: '/uploads/',
})

// 1x1 transparent PNG
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
)

const result = await uploadFile(png, 'receipt.png', 'image/png')
console.log('uploaded url:', result.url)

await server.listen({ port: 18099, host: '127.0.0.1' })

const res = await fetch(`http://127.0.0.1:18099${result.url}`)
console.log('GET', result.url, '->', res.status, res.headers.get('content-type'))
const body = Buffer.from(await res.arrayBuffer())
console.log('bytes match:', body.equals(png))

fs.unlinkSync(path.join(uploadsDir, result.filename))
await server.close()
process.exit(res.status === 200 && body.equals(png) ? 0 : 1)
