import { isValidDeploymentCode } from './namespace.js'

export type DeploymentRole = 'standalone' | 'hub' | 'spoke'

export interface SpokeEntry { code: string; baseUrl: string; secret: string }

export interface DeploymentConfig {
  role: DeploymentRole
  code: string                 // '' when standalone
  spokes: Map<string, SpokeEntry> // hub only
  hubUrl: string               // spoke only
  hubSecret: string            // spoke only
}

export function loadDeploymentConfig(): DeploymentConfig {
  const role = (process.env.DEPLOYMENT_ROLE ?? 'standalone') as DeploymentRole
  if (role === 'standalone') {
    return { role, code: '', spokes: new Map(), hubUrl: '', hubSecret: '' }
  }

  const code = (process.env.DEPLOYMENT_CODE ?? '').trim()
  if (!isValidDeploymentCode(code)) {
    throw new Error(`DEPLOYMENT_CODE "${code}" is invalid (need 3 lowercase alphanumeric chars) for role=${role}`)
  }

  const spokes = new Map<string, SpokeEntry>()
  if (role === 'hub') {
    const raw = process.env.HUB_DEPLOYMENTS ?? '[]'
    let arr: SpokeEntry[]
    try { arr = JSON.parse(raw) } catch { throw new Error('HUB_DEPLOYMENTS is not valid JSON') }
    for (const s of arr) {
      if (!isValidDeploymentCode(s.code) || !s.baseUrl || !s.secret) {
        throw new Error(`HUB_DEPLOYMENTS entry invalid: ${JSON.stringify(s)}`)
      }
      spokes.set(s.code, { code: s.code, baseUrl: s.baseUrl.replace(/\/$/, ''), secret: s.secret })
    }
  }

  const hubUrl = (process.env.HUB_URL ?? '').replace(/\/$/, '')
  const hubSecret = process.env.HUB_SHARED_SECRET ?? ''
  if (role === 'spoke' && (!hubUrl || !hubSecret)) {
    throw new Error('role=spoke requires HUB_URL and HUB_SHARED_SECRET')
  }

  return { role, code, spokes, hubUrl, hubSecret }
}

/** Memoized singleton for app runtime. */
let _cfg: DeploymentConfig | null = null
export function deploymentConfig(): DeploymentConfig {
  if (!_cfg) _cfg = loadDeploymentConfig()
  return _cfg
}

/** Test helper: clears the memoized singleton so env changes take effect. */
export function resetDeploymentConfigForTests(): void {
  _cfg = null
}
