import { defineConfig } from 'vitest/config'

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
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/world_bingo_test?schema=public',
        },
    },
})
