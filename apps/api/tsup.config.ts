import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  // Bundle everything into a single file so relative imports are never an issue
  bundle: true,
  // Keep source maps for debugging
  sourcemap: true,
  // Clean dist before each build
  clean: true,
  // Do NOT minify – keeps stack traces readable
  minify: false,
  // Split is false so we get a single dist/index.js
  splitting: false,
  // Bundle workspace packages alongside the app code; keep everything else external
  noExternal: ['@world-bingo/game-logic', '@world-bingo/shared-types'],
  // redlock is CJS-only and uses dynamic require – keep it external so Node loads it natively
  external: ['redlock'],
  // Shim __dirname / __filename for ESM
  shims: true,
  // Generate .d.ts files (useful for monorepo type checking)
  dts: false,
  // Pass tsconfig
  tsconfig: './tsconfig.json',
})
