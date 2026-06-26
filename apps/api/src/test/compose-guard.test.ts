import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Repo root is four levels up from apps/api/src/test
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

const PROD_COMPOSE_FILES = [
  'docker-compose.prod.yml',
  'docker-compose.aradabingo.yml',
  'docker-compose.betbawa.yml',
]

describe('production compose seed safety', () => {
  for (const file of PROD_COMPOSE_FILES) {
    it(`${file} never hardcodes RUN_SEED to true`, () => {
      const content = readFileSync(path.join(repoRoot, file), 'utf8')
      // Allow env-driven default (RUN_SEED: ${RUN_SEED:-false}); forbid a literal true.
      const hardcodedTrue = /RUN_SEED:\s*["']?true["']?\s*$/m.test(content)
      expect(hardcodedTrue).toBe(false)
    })
  }
})
