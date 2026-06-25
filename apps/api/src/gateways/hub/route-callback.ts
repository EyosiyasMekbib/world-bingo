import type { DeploymentConfig, SpokeEntry } from './deployment-config.js'
import { parseNamespacedAccount } from './namespace.js'

export type CallbackRoute =
  | { kind: 'local'; account: string }
  | { kind: 'forward'; account: string; spoke: SpokeEntry }
  | { kind: 'unknown'; account: string }

/** Pure decision: given the raw provider account, where does this callback go? */
export function decideCallbackRoute(cfg: DeploymentConfig, rawAccount: string): CallbackRoute {
  if (cfg.role !== 'hub') return { kind: 'local', account: rawAccount }

  let depCode: string, account: string
  try { ({ depCode, account } = parseNamespacedAccount(rawAccount)) }
  catch { return { kind: 'unknown', account: rawAccount } }

  if (depCode === cfg.code) return { kind: 'local', account }
  const spoke = cfg.spokes.get(depCode)
  if (spoke) return { kind: 'forward', account, spoke }
  return { kind: 'unknown', account }
}
