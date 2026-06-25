import type {
  GameProviderGateway,
  GameListResult,
  LaunchGameParams,
  TransactionDetail,
  TransactionListResult,
  Vendor,
} from '../game-provider/game-provider.interface.js'
import { deploymentConfig } from './deployment-config.js'
import { signBody, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from './hub-auth.js'

/** Spoke-side gateway: forwards every call to the hub's internal provider API. */
export class RemoteGameProviderGateway implements GameProviderGateway {
  constructor(readonly providerCode: string) {}

  private async call<T>(method: string, params: unknown): Promise<T> {
    const cfg = deploymentConfig()
    const body = JSON.stringify({ providerCode: this.providerCode, method, params })
    const res = await fetch(`${cfg.hubUrl}/v1/hub/provider`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [DEPLOYMENT_HEADER]: cfg.code,
        [SIGNATURE_HEADER]: signBody(cfg.hubSecret, body),
      },
      body,
    })
    if (!res.ok) throw new Error(`hub provider call failed: HTTP ${res.status}`)
    const json = (await res.json()) as {
      ok: boolean
      result?: T
      error?: { message: string; code?: string; palaceCode?: number }
    }
    if (!json.ok) {
      const e: any = new Error(json.error?.message ?? 'hub provider error')
      e.code = json.error?.code
      e.palaceCode = json.error?.palaceCode
      throw e
    }
    return json.result as T
  }

  getVendors(currency: string, language: string) {
    return this.call<Vendor[]>('getVendors', { args: [currency, language] })
  }
  getGames(vendorCode: string, page: number, pageSize: number, currency: string, language: string) {
    return this.call<GameListResult>('getGames', {
      args: [vendorCode, page, pageSize, currency, language],
    })
  }
  getGameUrl(params: LaunchGameParams) {
    return this.call<{ gameUrl: string; token: string }>('getGameUrl', params)
  }
  terminateSession(username: string) {
    return this.call<void>('terminateSession', { username })
  }
  getTransactions(fromTime: number, toTime: number, page: number) {
    return this.call<TransactionListResult>('getTransactions', { args: [fromTime, toTime, page] })
  }
  getTransactionDetail(betId: string, fromTime: number, toTime: number) {
    return this.call<TransactionDetail>('getTransactionDetail', { args: [betId, fromTime, toTime] })
  }
}
