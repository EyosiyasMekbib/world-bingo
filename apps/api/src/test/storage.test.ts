import { describe, it, expect } from 'vitest'
import { validateFile, uploadFile } from '../lib/storage'
import fs from 'fs'
import path from 'path'

describe('Storage Module (T16)', () => {
    describe('validateFile', () => {
        it('should accept valid JPEG', () => {
            expect(() => validateFile('image/jpeg', 1024)).not.toThrow()
        })

        it('should accept valid PNG', () => {
            expect(() => validateFile('image/png', 2048)).not.toThrow()
        })

        it('should accept valid WebP', () => {
            expect(() => validateFile('image/webp', 512)).not.toThrow()
        })

        it('should reject invalid mime type', () => {
            expect(() => validateFile('application/pdf', 1024)).toThrow('Invalid file type')
        })

        it('should reject file exceeding 5MB', () => {
            const sixMB = 6 * 1024 * 1024
            expect(() => validateFile('image/jpeg', sixMB)).toThrow('File too large')
        })

        it('should accept file exactly at 5MB limit', () => {
            const fiveMB = 5 * 1024 * 1024
            expect(() => validateFile('image/jpeg', fiveMB)).not.toThrow()
        })
    })

    describe('uploadFile (local)', () => {
        const testUploadsDir = path.resolve(process.cwd(), 'uploads')

        it('should upload a file to the local filesystem and return a URL', async () => {
            const buffer = Buffer.from('fake-image-data')
            const result = await uploadFile(buffer, 'test-receipt.jpg', 'image/jpeg')

            expect(result.url).toContain('/uploads/')
            expect(result.url).toContain('.jpg')
            expect(result.mimetype).toBe('image/jpeg')
            expect(result.size).toBe(buffer.byteLength)
            expect(result.filename).toBeTruthy()

            // Verify the file was actually written
            const filePath = path.join(testUploadsDir, result.filename)
            expect(fs.existsSync(filePath)).toBe(true)

            // Clean up
            fs.unlinkSync(filePath)
        })

        it('should reject upload with invalid mime type', async () => {
            const buffer = Buffer.from('not-an-image')
            await expect(
                uploadFile(buffer, 'malware.exe', 'application/octet-stream'),
            ).rejects.toThrow('Invalid file type')
        })
    })
})
