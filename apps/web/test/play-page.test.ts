import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGES = join(__dirname, '..', 'pages')
const play = readFileSync(join(PAGES, 'play', '[providerCode]', '[gameCode].vue'), 'utf8')

describe('play page', () => {
  it('drives its states from the load reducer', () => {
    expect(play).toContain("from '~/utils/provider-load'")
  })

  it('keys the iframe by attempt so a retry replaces it', () => {
    expect(play).toMatch(/<iframe[\s\S]*?:key="load\.attempt"/)
  })

  it('offers a retry and reports timeouts and retries', () => {
    expect(play).toContain('@click="retry"')
    expect(play).toContain("track('provider_game_load_timeout'")
    expect(play).toContain("track('provider_game_retry'")
  })

  it('splits api time from frame time on provider_game_loaded', () => {
    expect(play).toMatch(/msToUrl: Math\.round\(next\.urlAt! - next\.startedAt\)/)
  })

  it('ignores a launch answer that belongs to an earlier attempt', () => {
    expect(play).toContain('attempt !== load.value.attempt')
  })

  it('drives the overlay from showsOverlay, so a dismissed load unmounts it', () => {
    expect(play).toContain('const showOverlay = computed(() => !choosing.value && showsOverlay(load.value))')
    // v-if, not v-show: an overlay left in the DOM would still sit over the frame.
    expect(play).toMatch(/<div v-if="showOverlay" class="play-state play-state--overlay"/)
  })

  it('offers "Show game anyway" beside retry once the load can be dismissed', () => {
    expect(play).toContain('const dismissible = computed(() => canDismiss(load.value))')
    expect(play).toMatch(/<button v-if="dismissible"[^>]*@click="dismissOverlay"/)
    expect(play).toContain("t('providers.showGameAnyway')")
    expect(play).toContain("track('provider_game_load_dismissed'")
  })

  it('asks for real or bonus before launching when the player holds bonus', () => {
    expect(play).toContain("from '~/utils/spend-choice'")
    expect(play).toContain('if (needsSpendChoice(auth.wallet)) choosing.value = true')
    expect(play).toContain('else beginLaunch()')
    expect(play).toMatch(/<SpendAccountPicker[\s\S]*?v-if="choosing && auth\.wallet"[\s\S]*?@choose="chooseAccount"/)
  })

  it('switches the spend account before the launch, and stays on the picker if that fails', () => {
    const choose = play.slice(play.indexOf('async function chooseAccount'), play.indexOf('function onFrameLoad'))
    expect(choose).toContain("'/wallet/spend-account', { method: 'PATCH', body: { account } }")
    expect(choose.indexOf("'/wallet/spend-account'")).toBeLessThan(choose.indexOf('beginLaunch()'))
    expect(choose).toMatch(/catch \{\s*spendError\.value = t\('providers\.switchFailed'\)\s*return/)
    expect(choose).toContain("track('provider_spend_account_chosen'")
  })

  it('does not ask again on retry', () => {
    const retry = play.slice(play.indexOf('function retry()'), play.indexOf('function dismissOverlay'))
    expect(retry).not.toContain('choosing')
  })

  it('has the picker strings in both locales', () => {
    for (const locale of ['en', 'am']) {
      const json = JSON.parse(
        readFileSync(join(__dirname, '..', 'i18n', 'locales', `${locale}.json`), 'utf8'),
      )
      for (const key of ['playWith', 'realBalance', 'bonusBalance', 'bonusWinsNote', 'switchFailed', 'startGame', 'emptyBalance']) {
        const label = json.providers?.[key]
        expect(typeof label === 'string' && label.trim().length > 0, `${locale}.${key}`).toBe(true)
      }
    }
  })

  it('has the "Show game anyway" label in both locales', () => {
    for (const locale of ['en', 'am']) {
      const json = JSON.parse(
        readFileSync(join(__dirname, '..', 'i18n', 'locales', `${locale}.json`), 'utf8'),
      )
      const label = json.providers?.showGameAnyway
      expect(typeof label === 'string' && label.trim().length > 0, locale).toBe(true)
    }
  })
})

describe('/games tab', () => {
  const games = readFileSync(join(PAGES, 'games', 'index.vue'), 'utf8')
  const store = readFileSync(join(__dirname, '..', 'store', 'provider-games.ts'), 'utf8')

  it('launches through the play page, not a full-page jump to the provider', () => {
    expect(games).not.toContain('window.location.href = url')
    expect(games).toContain(
      'const href = `/play/${launchProviderFor(game, providerStore.activeProviderCode)}/${game.gameCode}`',
    )
    expect(games).toContain('onPlayTap(href)')
    expect(games).toContain('return navigateTo(href)')
  })

  it('no longer carries the store launch action', () => {
    expect(store).not.toContain('launchGame(')
    expect(store).not.toMatch(/\blaunching\b/)
  })
})

describe('tap-to-page measurement', () => {
  it.each([
    ['lobby', 'index.vue'],
    ['category', 'games/[category].vue'],
    ['search', 'search.vue'],
    ['games tab', 'games/index.vue'],
  ])('%s marks the tap on its way into /play', (_, rel) => {
    expect(readFileSync(join(PAGES, rel), 'utf8')).toContain('onPlayTap(')
  })

  it('the play page reports msFromTap on provider_game_view', () => {
    expect(play).toMatch(/track\('provider_game_view', \{[^}]*msFromTap/)
  })
})
