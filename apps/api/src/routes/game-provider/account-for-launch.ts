import { loadDeploymentConfig } from '../../gateways/hub/deployment-config.js'
import { namespaceAccount } from '../../gateways/hub/namespace.js'

/**
 * The account string sent upstream at launch.
 * - hub: prefixed with the hub's own code so its callbacks route locally.
 * - spoke: bare — the hub injects the spoke's code from the authenticated header.
 * - standalone: bare (unchanged behaviour).
 */
export function accountForLaunch(bareAccount: string): string {
  const cfg = loadDeploymentConfig()
  return cfg.role === 'hub' ? namespaceAccount(cfg.code, bareAccount) : bareAccount
}
