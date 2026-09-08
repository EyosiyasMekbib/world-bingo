import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Exercises the shell script the Docker build runs after `nuxt build`. A stub
// posthog-cli on POSTHOG_CLI_BIN records what it was called with, so the test
// pins the contract: upload only with a key AND a project id, never fail the
// build, always strip .map files.

const SCRIPT = resolve(__dirname, 'posthog-sourcemaps.sh')

let root: string
let dir: string
let stub: string
let stubOut: string

function seedOutput() {
  dir = join(root, '_nuxt')
  mkdirSync(dir)
  writeFileSync(join(dir, 'a.js'), 'console.log("a")\n')
  writeFileSync(join(dir, 'a.js.map'), '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}')
  writeFileSync(join(dir, 'b.js'), 'console.log("b")\n')
  writeFileSync(join(dir, 'b.js.map'), '{"version":3,"sources":["b.ts"],"mappings":"AAAA"}')
  writeFileSync(join(dir, 'c.js'), 'console.log("c")\n')
}

function run(env: Record<string, string> = {}, args: string[] = [dir]) {
  const res = spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      POSTHOG_CLI_BIN: stub,
      POSTHOG_CLI_SECRET_FILE: join(root, 'no-such-secret'),
      STUB_OUT: stubOut,
      ...env,
    },
  })
  return { status: res.status, out: res.stdout, err: res.stderr }
}

function stubCalled() {
  return existsSync(`${stubOut}.args`)
}
function stubArgs() {
  return readFileSync(`${stubOut}.args`, 'utf8').trim().split('\n')
}
function stubEnv() {
  return Object.fromEntries(
    readFileSync(`${stubOut}.env`, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  )
}
function remainingMaps() {
  return ['a.js.map', 'b.js.map'].filter((f) => existsSync(join(dir, f)))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ph-sm-'))
  seedOutput()
  stubOut = join(root, 'stub')
  stub = join(root, 'posthog-cli')
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$@" > "$STUB_OUT.args"',
      'env | grep "^POSTHOG_CLI_" | sort > "$STUB_OUT.env"',
      'exit "${STUB_EXIT:-0}"',
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('posthog-sourcemaps.sh', () => {
  it('without a key: skips the upload, strips maps, leaves chunks alone, exits 0', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/skipping upload/)
    expect(stubCalled()).toBe(false)
    expect(remainingMaps()).toEqual([])
    expect(readFileSync(join(dir, 'a.js'), 'utf8')).toBe('console.log("a")\n')
    expect(existsSync(join(dir, 'c.js'))).toBe(true)
  })

  it('with a key but no project id: skips the upload', () => {
    const r = run({ POSTHOG_CLI_API_KEY: 'phx_key' })
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/POSTHOG_CLI_PROJECT_ID unset/)
    expect(stubCalled()).toBe(false)
    expect(remainingMaps()).toEqual([])
  })

  it('with key + project id: runs `sourcemap process` on the dir, then strips maps', () => {
    const r = run({ POSTHOG_CLI_API_KEY: 'phx_key', POSTHOG_CLI_PROJECT_ID: '267450' })
    expect(r.status).toBe(0)
    expect(stubCalled()).toBe(true)
    expect(stubArgs()).toEqual([
      '--host',
      'https://eu.posthog.com',
      'sourcemap',
      'process',
      '--directory',
      dir,
    ])
    const env = stubEnv()
    // Both spellings: @posthog/cli 0.18 reads API_KEY/PROJECT_ID, older
    // releases read TOKEN/ENV_ID.
    expect(env.POSTHOG_CLI_API_KEY).toBe('phx_key')
    expect(env.POSTHOG_CLI_TOKEN).toBe('phx_key')
    expect(env.POSTHOG_CLI_PROJECT_ID).toBe('267450')
    expect(env.POSTHOG_CLI_ENV_ID).toBe('267450')
    expect(r.out).toMatch(/upload done/)
    expect(remainingMaps()).toEqual([])
  })

  it('honours POSTHOG_CLI_HOST', () => {
    run({
      POSTHOG_CLI_API_KEY: 'phx_key',
      POSTHOG_CLI_PROJECT_ID: '1',
      POSTHOG_CLI_HOST: 'https://us.posthog.com',
    })
    expect(stubArgs().slice(0, 2)).toEqual(['--host', 'https://us.posthog.com'])
  })

  it('reads the key from the BuildKit secret file when the env var is empty', () => {
    const secret = join(root, 'secret')
    writeFileSync(secret, 'phx_from_file\n')
    run({ POSTHOG_CLI_SECRET_FILE: secret, POSTHOG_CLI_PROJECT_ID: '267450' })
    expect(stubCalled()).toBe(true)
    expect(stubEnv().POSTHOG_CLI_API_KEY).toBe('phx_from_file')
  })

  it('a failed upload does not fail the build, and maps are still stripped', () => {
    const r = run({
      POSTHOG_CLI_API_KEY: 'phx_key',
      POSTHOG_CLI_PROJECT_ID: '267450',
      STUB_EXIT: '3',
    })
    expect(r.status).toBe(0)
    expect(r.err).toMatch(/UPLOAD FAILED \(exit 3\)/)
    expect(remainingMaps()).toEqual([])
  })

  it('with no maps to upload: says so and does not call the CLI', () => {
    rmSync(join(dir, 'a.js.map'))
    rmSync(join(dir, 'b.js.map'))
    const r = run({ POSTHOG_CLI_API_KEY: 'phx_key', POSTHOG_CLI_PROJECT_ID: '267450' })
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/no \.map files/)
    expect(stubCalled()).toBe(false)
  })

  it('rejects a missing or non-existent directory with exit 2', () => {
    expect(run({}, []).status).toBe(2)
    expect(run({}, [join(root, 'nope')]).status).toBe(2)
  })
})
