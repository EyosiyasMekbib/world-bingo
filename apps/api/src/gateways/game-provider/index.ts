import type { GameProviderGateway } from './game-provider.interface.js'
import { GaseaGateway } from './gasea.gateway.js'
import { PalaceGateway } from './palace.gateway.js'
import { deploymentConfig } from '../hub/deployment-config.js'
import { RemoteGameProviderGateway } from '../hub/remote-game-provider.gateway.js'

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

// Register providers based on deployment role.
if (deploymentConfig().role === 'spoke') {
    // Spokes have no provider credentials — every call is forwarded to the hub.
    registerGameProviderGateway(new RemoteGameProviderGateway('palace'))
    registerGameProviderGateway(new RemoteGameProviderGateway('gasea'))
} else {
    // standalone + hub talk to providers directly.
    registerGameProviderGateway(new GaseaGateway())
    registerGameProviderGateway(new PalaceGateway())
}

export type { GameProviderGateway }
export * from './game-provider.interface.js'
