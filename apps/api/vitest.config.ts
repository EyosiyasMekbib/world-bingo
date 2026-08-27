import { defineConfig } from 'vitest/config'
import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// Load root .env so DATABASE_URL_TEST and other vars are available
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../../.env') })

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: ['**/*.test.ts', '**/*.spec.ts', 'node_modules/', 'dist/'],
        },
        globals: true,
        setupFiles: ['./src/test/setup.ts'],
        // Run test files sequentially to avoid DB conflicts between test files
        fileParallelism: false,
        env: {
            DATABASE_URL: process.env.DATABASE_URL_TEST ?? 'postgresql://postgres:postgres@localhost:5432/world_bingo_test?schema=public',
            // `||`, not `??`: the root .env sets TELEGRAM_BOT_TOKEN to an EMPTY
            // string, which `??` happily keeps — and AuthService.telegramAuth
            // throws on a falsy token, so all five telegramAuth tests failed
            // with "Telegram login is not configured" on any machine that had
            // the var declared but blank.
            TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'test_token',
        },
    },
})
