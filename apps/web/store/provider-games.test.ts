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
}
const providers = [
  { id: 'p1', code: 'palace', name: 'Palace Casino', status: 'ACTIVE', currency: 'ETB' },
  { id: 'p2', code: 'atlasv', name: 'Atlas-V', status: 'ACTIVE', currency: 'ETB' },
]

describe('provider-games store — hydrateLobby', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('adopts the lobby provider together with its games, replacing an earlier selection', () => {
    const store = useProviderGamesStore()
    store.activeProviderCode = 'atlasv' // chosen earlier on /games
    store.hydrateLobby({ providers, activeProviderCode: 'palace', categories: ['SLOTS'], games: [palaceGame], gamesTotal: 1 })
    expect(store.activeProviderCode).toBe('palace')
    expect(store.games.map((g) => g.gameCode)).toEqual(['533'])
  })

  it('keeps the current provider when the lobby reports none', () => {
    const store = useProviderGamesStore()
    store.activeProviderCode = 'palace'
    store.hydrateLobby({ providers: [], activeProviderCode: null, categories: [], games: [], gamesTotal: 0 })
    expect(store.activeProviderCode).toBe('palace')
  })
})
