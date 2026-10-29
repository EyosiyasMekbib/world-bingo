import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..')
const read = (...parts: string[]) => readFileSync(join(WEB, ...parts), 'utf8')

const sports = read('pages', 'sports.vue')
const chrome = read('components', 'shells', 'winner', 'Chrome.vue')
const rail = read('components', 'shells', 'winner', 'Rail.vue')

/** open() from its signature up to the request: everything that runs before it. */
const openStart = sports.indexOf('async function open()')
const requestAt = sports.indexOf("'/sportsbook/session'")
const beforeRequest = openStart >= 0 && requestAt > openStart ? sports.slice(openStart, requestAt) : ''

/** Every opening <NuxtLink ...> tag in a template, as written. */
function navLinks(source: string): string[] {
  return source.match(/<NuxtLink\b[^>]*>/g) ?? []
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

describe('sports page', () => {
  it('asks the api for a session and frames the url it returns', () => {
    expect(sports).toContain("'/sportsbook/session'")
    expect(sports).toContain('<iframe')
    expect(sports).toContain(':src="url"')
  })

  it('always sends a JSON body carrying the locale', () => {
    // An empty body with a JSON content-type makes Fastify answer 400.
    expect(sports).toMatch(/method: 'POST',\s*body: \{ lang: locale\.value \}/)
  })

  it('prompts a logged-out player instead of calling the api', () => {
    expect(sports).toContain('AuthPromptModal')
    expect(sports).toContain('v-model="showAuthPrompt"')
    // The guard returns inside open(), ahead of the request.
    expect(beforeRequest).toMatch(
      /if \(!auth\.isAuthenticated\) \{[\s\S]*?showAuthPrompt\.value = true[\s\S]*?return\s*\}/,
    )
  })

  it('is gated by the feature flag inside open(), ahead of the request and the login check', () => {
    expect(sports).toMatch(/feature_sportsbook|sportsbookEnabled/)
    // Off means off: no prompt and no request, so the flag is tested first.
    expect(beforeRequest).toMatch(/if \(!sportsbookEnabled\.value\) return\n/)
    expect(beforeRequest.indexOf('sportsbookEnabled.value')).toBeLessThan(
      beforeRequest.indexOf('auth.isAuthenticated'),
    )
  })

  it('blocks the frame from session replay, which would record its one-time src', () => {
    const frame = sports.match(/<iframe[\s\S]*?\/>/)?.[0] ?? ''
    expect(frame).toContain(':src="url"')
    expect(frame).toMatch(/\sdata-ph-block(\s|\/|$)/)
    // The attribute only helps while the plugin's blockSelector still names it.
    expect(read('plugins', '02.posthog.client.ts')).toMatch(/blockSelector:[^\n]*\[data-ph-block\]/)
  })

  it('offers a retry that asks for a fresh session', () => {
    expect(sports).toContain('@click="retry"')
    expect(sports).toMatch(/function retry\(\)[\s\S]*?void open\(\)/)
  })

  it('reports opens and failures without the session url', () => {
    expect(sports).toContain("track('sportsbook_opened')")
    expect(sports).toMatch(/track\('sportsbook_unavailable', \{ code \}\)/)
  })

  it('keeps the session url in a local ref and nowhere else', () => {
    expect(sports).toContain('const url = ref<string | null>(null)')
    // One-time, player-bound: never cached, stored, logged or sent anywhere.
    for (const sink of [
      'useState',
      'defineStore',
      'localStorage',
      'sessionStorage',
      'useCookie',
      'console.',
    ]) {
      expect(sports, sink).not.toContain(sink)
    }
    expect(sports).not.toMatch(/track\([^)]*\burl\b/)
  })

  it('is a public route, or the sign-in prompt could never show to a guest', () => {
    expect(read('middleware', 'auth.global.ts')).toMatch(/const publicPaths = \[[^\]]*'\/sports'/)
  })

  it('uses the wide shell so the frame is not squeezed between rail and aside', () => {
    expect(sports).toContain("definePageMeta({ shell: 'wide' })")
  })

  it('takes its colours from skin hooks, so a shared page never restyles arada', () => {
    const style = sports.slice(sports.indexOf('<style'))
    const colourLines = style.split('\n').filter((line) => /#[0-9a-fA-F]{3,8}\b/.test(line))
    expect(colourLines.length).toBeGreaterThan(0)
    // A literal colour is only ever the fallback inside a skin hook.
    for (const line of colourLines) expect(line).toContain('var(--skin-')
  })
})

describe('feature flag wiring', () => {
  it('defaults feature_sportsbook off', () => {
    expect(read('composables', 'useFeatureFlags.ts')).toMatch(/feature_sportsbook: false/)
  })

  it('exposes sportsbookEnabled from the shell composable', () => {
    const shell = read('composables', 'useAppShell.ts')
    expect(shell).toContain(
      'const sportsbookEnabled = computed(() => flags.value.feature_sportsbook === true)',
    )
    expect(shell).toMatch(/return \{[\s\S]*?\bsportsbookEnabled,[\s\S]*?\}/)
  })
})

describe('Winner nav', () => {
  it.each([
    ['Chrome', chrome, 'wn-tab'],
    ['Rail', rail, 'wn-rail-row'],
  ])('%s links to /sports behind sportsbookEnabled', (_, source, cls) => {
    const link = navLinks(source).find((tag) => tag.includes('to="/sports"'))
    expect(link, 'a NuxtLink to /sports').toBeDefined()
    expect(link).toContain('v-if="sportsbookEnabled"')
    expect(link).toContain(`class="${cls}"`)
    expect(source).toContain('sportsbookEnabled')
    expect(source).toMatch(/const \{[\s\S]*?\bsportsbookEnabled\b[\s\S]*?\} =\s*useAppShell\(\)/)
  })

  it('puts Sports right after Home in the icon nav and first in the rail list', () => {
    // Only the icon-nav tabs: the logo and quick links in the top bar also point at '/'.
    const tabs = navLinks(chrome)
      .filter((tag) => tag.includes('class="wn-tab"'))
      .map((tag) => tag.match(/to="([^"]+)"/)?.[1])
    expect(tabs.indexOf('/')).toBe(0)
    expect(tabs.indexOf('/sports')).toBe(1)

    const rows = navLinks(rail).map((tag) => tag.match(/to="([^"]+)"/)?.[1])
    expect(rows.indexOf('/sports')).toBe(0)
  })
})

describe('Arada', () => {
  it('has no link to /sports in any shell file', () => {
    const files = filesUnder(join(WEB, 'components', 'shells', 'arada'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('/sports')
    }
  })
})
