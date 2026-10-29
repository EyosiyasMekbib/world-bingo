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

/** Every compose file that ships a browser-facing app. The staging pair is in
 *  here too: a socket URL that only breaks in production is a socket URL whose
 *  breakage staging was supposed to catch. */
const ALL_COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.prod.yml',
  'docker-compose.aradabingo.yml',
  'docker-compose.betbawa.yml',
  'docker-compose.aradabingo.staging.yml',
  'docker-compose.betbawa.staging.yml',
]

/** Pull one service's block out of a compose file: the lines from `  <name>:`
 *  up to the next top-level service key. Enough for asserting on `environment:`
 *  contents without taking a YAML parser as a test dependency. */
function serviceBlock(content: string, servicePrefix: string): string | null {
  const lines = content.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^  ${servicePrefix}[a-z0-9_-]*:\\s*$`).test(l))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

describe('compose apps can reach the socket', () => {
  // The admin inbox opens its own socket.io client at `config.public.wsUrl`,
  // which apps/admin/nuxt.config.ts defaults to http://localhost:8080 for local
  // dev. Every compose file set NUXT_PUBLIC_WS_URL for `web` and none set it for
  // `admin`, so in every deployed environment a clerk's browser tried to reach
  // port 8080 ON THE CLERK'S OWN MACHINE. It failed with "xhr poll error", and
  // the support inbox never received a queue update, an incoming message or a
  // thread — while the page itself loaded fine over the working /api proxy, so
  // it read as an empty queue rather than as a broken connection.
  for (const file of ALL_COMPOSE_FILES) {
    it(`${file} gives the admin service a NUXT_PUBLIC_WS_URL`, () => {
      const content = readFileSync(path.join(repoRoot, file), 'utf8')
      const admin = serviceBlock(content, 'admin')
      if (admin === null) return // file ships no admin service
      expect(admin).toMatch(/NUXT_PUBLIC_WS_URL:/)
    })

    it(`${file} gives the web service a NUXT_PUBLIC_WS_URL`, () => {
      const content = readFileSync(path.join(repoRoot, file), 'utf8')
      const web = serviceBlock(content, 'web')
      if (web === null) return
      expect(web).toMatch(/NUXT_PUBLIC_WS_URL:/)
    })
  }
})

describe('IGCORE sportsbook env wiring', () => {
  // Compose forwards only the variables it declares, so a var missing from the
  // api block is silently unset inside the container however Dokploy is
  // configured (the Atlas-V lesson). The simulator mints wallet credit and is
  // therefore declared in the staging file alone.
  const WINNER_COMPOSE_FILES = ['docker-compose.betbawa.yml', 'docker-compose.betbawa.staging.yml']
  const ARADA_COMPOSE_FILES = [
    'docker-compose.aradabingo.yml',
    'docker-compose.aradabingo.staging.yml',
    'docker-compose.prod.yml',
  ]

  for (const file of PROD_COMPOSE_FILES) {
    it(`IGCORE_SIMULATOR never reaches a production compose file (${file})`, () => {
      const content = readFileSync(path.join(repoRoot, file), 'utf8')
      expect(content).not.toMatch(/IGCORE_SIMULATOR/)
      expect(content).not.toMatch(/IGCORE_SIM_/)
    })
  }

  for (const file of WINNER_COMPOSE_FILES) {
    it(`both Winner compose files forward the IGCORE vars (${file})`, () => {
      const content = readFileSync(path.join(repoRoot, file), 'utf8')
      const api = serviceBlock(content, 'api')
      expect(api).not.toBeNull()
      expect(api).toMatch(/IGCORE_API_URL:/)
      expect(api).toMatch(/IGCORE_SECURITY_HASH:/)
    })
  }

  it('docker-compose.betbawa.staging.yml declares the simulator vars in the api service', () => {
    const content = readFileSync(path.join(repoRoot, 'docker-compose.betbawa.staging.yml'), 'utf8')
    const api = serviceBlock(content, 'api')
    expect(api).toMatch(/IGCORE_SIMULATOR: \$\{IGCORE_SIMULATOR:-false\}/)
    expect(api).toMatch(/IGCORE_SIM_PUBLIC_URL: \$\{IGCORE_SIM_PUBLIC_URL:-https:\/\/staging-api\.betbawa\.bet\}/)
    expect(api).toMatch(/IGCORE_SIM_CALLBACK_URL: \$\{IGCORE_SIM_CALLBACK_URL:-\}/)
  })

  for (const file of ARADA_COMPOSE_FILES) {
    it(`Arada compose files carry no IGCORE vars (${file})`, () => {
      const content = readFileSync(path.join(repoRoot, file), 'utf8')
      expect(content).not.toMatch(/IGCORE_/)
    })
  }
})

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
