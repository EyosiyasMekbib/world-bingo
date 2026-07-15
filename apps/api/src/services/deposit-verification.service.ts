import prisma from '../lib/prisma'
import { getQueue, QUEUE_NAMES } from '../lib/queue'
import { getVerifier } from './deposit-verification/registry'
import { evaluate } from './deposit-verification/decision-engine'
import { normalizeName } from './deposit-verification/matching'
import {
  isUnavailable,
  type DepositVerifier,
  type ExpectedDeposit,
  type VerifyConfig,
  type ParsedReceipt,
} from './deposit-verification/types'

/** Thrown to the worker so it can pause the queue and retry without burning an attempt. */
export class RateLimitSignal extends Error {
  constructor() {
    super('deposit verification rate limited')
    this.name = 'RateLimitSignal'
  }
}

type RunStatus = 'PENDING' | 'AUTO_CREDITED' | 'MANUAL_REQUIRED' | 'UNAVAILABLE'

async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await prisma.siteSetting.findUnique({ where: { key } })
  return row?.value ?? fallback
}

export class DepositVerificationService {
  static async loadConfig(): Promise<{ enabled: boolean } & VerifyConfig> {
    const [enabled, maxAmount, maxAge, requirePayer] = await Promise.all([
      getSetting('deposit_auto_verify_enabled', 'false'),
      getSetting('deposit_auto_verify_max_amount', '0'),
      getSetting('deposit_auto_verify_max_age_hours', '0'),
      getSetting('deposit_auto_verify_require_payer_match', 'false'),
    ])
    return {
      enabled: enabled === 'true',
      maxAutoAmount: Number(maxAmount) || 0,
      maxAgeHours: Number(maxAge) || 0,
      requirePayerMatch: requirePayer === 'true',
      now: new Date(),
    }
  }

  static async enqueue(transactionId: string): Promise<void> {
    try {
      await getQueue(QUEUE_NAMES.DEPOSIT_VERIFICATION).add('verify', { transactionId })
    } catch (err) {
      // Enqueue failures must never break deposit submission — the deposit still goes to manual.
      console.error('[DepositVerification] enqueue failed:', (err as Error).message)
    }
  }

  static async runVerification(
    transactionId: string,
    deps: { verifier?: DepositVerifier } = {},
  ): Promise<{ status: RunStatus; reasons: string[] }> {
    const config = await this.loadConfig()
    if (!config.enabled) return { status: 'PENDING', reasons: [] }

    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })
    if (!tx || tx.status !== 'PENDING_REVIEW' || !tx.paymentTransactionId) {
      return { status: 'PENDING', reasons: [] }
    }

    const verifier = deps.verifier ?? getVerifier(tx.note)
    if (!verifier) return { status: 'PENDING', reasons: [] }

    const parsed = await verifier.verify(tx.paymentTransactionId)

    if (isUnavailable(parsed)) {
      if (parsed.unavailable === 'RATE_LIMITED') throw new RateLimitSignal()
      await this.write(transactionId, 'UNAVAILABLE', null, [parsed.unavailable], null)
      return { status: 'UNAVAILABLE', reasons: [parsed.unavailable] }
    }

    return this.evaluatePersistCredit(transactionId, tx, parsed, config, { allowCredit: true })
  }

  /**
   * On-demand verification from receipt markup supplied by an approver's browser
   * (which egresses from Ethiopia and can reach the receipt host directly), instead
   * of a server-side fetch. Runs the SAME parse → evaluate → persist → credit pipeline
   * as {@link runVerification}. Crediting still honours the operator's toggle
   * (`allowCredit = config.enabled`) and the auto-credit cap, so shadow mode
   * (disabled, or cap 0) shows the verdict without moving money.
   *
   * Returns the decision plus the parsed fields for immediate display in the UI.
   */
  static async verifyFromHtml(
    transactionId: string,
    html: string,
    deps: { verifier?: DepositVerifier } = {},
  ): Promise<{ status: RunStatus; reasons: string[]; parsed: ParsedReceipt | null }> {
    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })
    if (!tx || tx.status !== 'PENDING_REVIEW') {
      return { status: 'PENDING', reasons: ['NOT_PENDING'], parsed: null }
    }
    if (!tx.paymentTransactionId) {
      return { status: 'PENDING', reasons: ['NO_REFERENCE'], parsed: null }
    }

    const verifier = deps.verifier ?? getVerifier(tx.note)
    if (!verifier) return { status: 'PENDING', reasons: ['NO_VERIFIER'], parsed: null }

    const parsed = verifier.parse(html)
    if (isUnavailable(parsed)) {
      await this.write(transactionId, 'UNAVAILABLE', null, [parsed.unavailable], null)
      return { status: 'UNAVAILABLE', reasons: [parsed.unavailable], parsed: null }
    }

    const config = await this.loadConfig()
    const res = await this.evaluatePersistCredit(transactionId, tx, parsed, config, {
      allowCredit: config.enabled,
    })
    return { ...res, parsed }
  }

  /**
   * Shared tail: match the parsed receipt against the expected deposit + active
   * accounts, apply the payer gate, persist the verification row, and credit when
   * the match is clean and crediting is allowed. Used by both the background worker
   * ({@link runVerification}) and the on-demand approver path ({@link verifyFromHtml}).
   */
  private static async evaluatePersistCredit(
    transactionId: string,
    tx: { amount: unknown; paymentTransactionId: string | null; senderName: string | null },
    parsed: ParsedReceipt,
    config: VerifyConfig,
    opts: { allowCredit: boolean },
  ): Promise<{ status: RunStatus; reasons: string[] }> {
    const activeAccounts = (
      await prisma.paymentMethod.findMany({
        where: { type: 'DEPOSIT', enabled: true, autoVerify: true },
        select: { merchantName: true, merchantAccount: true },
      })
    )
      .filter((m) => m.merchantName && m.merchantAccount)
      .map((m) => ({ name: m.merchantName as string, account: m.merchantAccount as string }))

    const expected: ExpectedDeposit = {
      statedAmount: Number(tx.amount),
      paymentTransactionId: tx.paymentTransactionId as string,
      activeAccounts,
    }

    const decision = evaluate(parsed, expected, config)

    // Orchestration-level payer gate: compares the receipt payer to the player's entered senderName.
    if (
      config.requirePayerMatch &&
      decision.decision === 'AUTO_CREDIT' &&
      tx.senderName &&
      parsed.payerName &&
      normalizeName(tx.senderName) !== normalizeName(parsed.payerName)
    ) {
      decision.decision = 'MANUAL'
      decision.creditAmount = null
      decision.reasons = ['PAYER_MISMATCH']
    }

    if (opts.allowCredit && decision.decision === 'AUTO_CREDIT' && decision.creditAmount !== null) {
      await this.write(transactionId, 'AUTO_CREDITED', 'AUTO_CREDIT', decision.reasons, parsed)
      const { WalletService } = await import('./wallet.service')
      await WalletService.approveDeposit(transactionId, decision.creditAmount)
      return { status: 'AUTO_CREDITED', reasons: decision.reasons }
    }

    // Clean match but crediting withheld (shadow / disabled): surface it as a clean
    // match awaiting a human, not a mismatch.
    if (decision.decision === 'AUTO_CREDIT') {
      await this.write(transactionId, 'MANUAL_REQUIRED', 'AUTO_CREDIT', decision.reasons, parsed)
      return { status: 'MANUAL_REQUIRED', reasons: decision.reasons }
    }

    await this.write(transactionId, 'MANUAL_REQUIRED', 'MANUAL', decision.reasons, parsed)
    return { status: 'MANUAL_REQUIRED', reasons: decision.reasons }
  }

  private static async write(
    transactionId: string,
    status: 'AUTO_CREDITED' | 'MANUAL_REQUIRED' | 'UNAVAILABLE',
    decision: string | null,
    reasons: string[],
    parsed: ParsedReceipt | null,
  ): Promise<void> {
    const data = {
      status,
      decision,
      decisionReasons: reasons,
      receiverName: parsed?.receiverName ?? null,
      receiverNumberMasked: parsed?.receiverNumberMasked ?? null,
      settledAmount: parsed?.settledAmount ?? null,
      totalPaid: parsed?.totalPaid ?? null,
      receiptStatus: parsed?.status ?? null,
      receiptNumber: parsed?.receiptNumber ?? null,
      receiptTime: parsed?.receiptTime ?? null,
      payerName: parsed?.payerName ?? null,
      payerNumberMasked: parsed?.payerNumberMasked ?? null,
      rawSnapshot: parsed ? (parsed as unknown as object) : undefined,
    }
    await prisma.depositVerification.upsert({
      where: { transactionId },
      create: { transactionId, ...data, attempts: 1 },
      update: { ...data, attempts: { increment: 1 } },
    })
  }
}
