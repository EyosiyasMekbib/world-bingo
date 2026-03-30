import type { GameProviderGateway } from './game-provider.interface.js'
import { GaseaGateway } from './gasea.gateway.js'

const registry = new Map<string, GameProviderGateway>()

export function registerGameProviderGateway(gateway: GameProviderGateway): void {
    registry.set(gateway.providerCode, gateway)
}

export function getGameProviderGateway(code: string): GameProviderGateway {
    const gw = registry.get(code)
    if (!gw) throw new Error(`Game provider gateway not found: ${code}`)
    return gw
}

export function listGameProviderGateways(): GameProviderGateway[] {
    return [...registry.values()]
}

// Register built-in providers
registerGameProviderGateway(new GaseaGateway())

export type { GameProviderGateway }
export * from './game-provider.interface.js'
