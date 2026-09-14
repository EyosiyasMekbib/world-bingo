import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: '/api' } }))
vi.stubGlobal('$fetch', vi.fn())

import { useProviderGamesStore, type ProviderGame } from './provider-games'

const palaceGame: ProviderGame = {
  gameCode: '533',
  gameName: 'Some Slot',
  categoryCode: 'SLOTS',
  imageSquare: null,
  imageLandscape: null,
  vendorCode: 'palace:15',
  providerCode: 'palace',
}
const atlasvGame: ProviderGame = {
  gameCode: 'aviator',
  gameName: 'Aviator',
  categoryCode: 'CRASH',
  imageSquare: null,
  imageLandscape: null,
  vendorCode: null,
  providerCode: 'atlasv',
}
const providers = [
  { id: 'p1', code: 'palace', name: 'Palace Casino', status: 'ACTIVE', currency: 'ETB' },
  { id: 'p2', code: 'atlasv', name: 'Atlas-V', status: 'ACTIVE', currency: 'ETB' },
]

describe('provider-games store — hydrateLobby', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('adopts the lobby default provider when none is selected yet', () => {
    const store = useProviderGamesStore()
    store.hydrateLobby({
      providers,
      activeProviderCode: 'palace',
      categories: ['SLOTS', 'CRASH'],
      games: [palaceGame, atlasvGame],
      gamesTotal: 2,
    })
    expect(store.activeProviderCode).toBe('palace')
    expect(store.games.map((g) => `${g.providerCode}:${g.gameCode}`)).toEqual(['palace:533', 'atlasv:aviator'])
  })

  it('keeps a provider already selected on /games, while taking the merged games', () => {
    const store = useProviderGamesStore()
    store.activeProviderCode = 'atlasv' // chosen earlier on /games
    store.hydrateLobby({
      providers,
      activeProviderCode: 'palace',
      categories: ['SLOTS', 'CRASH'],
      games: [palaceGame, atlasvGame],
      gamesTotal: 2,
    })
    expect(store.activeProviderCode).toBe('atlasv')
    // Every row keeps its own provider, so launches never depend on the selection.
    expect(store.games.map((g) => g.providerCode)).toEqual(['palace', 'atlasv'])
  })

  it('keeps the current provider when the lobby reports none', () => {
    const store = useProviderGamesStore()
    store.activeProviderCode = 'palace'
    store.hydrateLobby({ providers: [], activeProviderCode: null, categories: [], games: [], gamesTotal: 0 })
    expect(store.activeProviderCode).toBe('palace')
  })
})
