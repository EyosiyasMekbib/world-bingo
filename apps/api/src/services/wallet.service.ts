import prisma from '../lib/prisma'
import { DepositDto, TransactionType, PaymentStatus, NotificationType, AccountStatus } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'
import { ReferralService } from './referral.service'
import { wbDepositsTotal, wbWithdrawalsTotal } from '../lib/metrics'
import { DepositVerificationService } from './deposit-verification.service'
import { BonusService } from './bonus.service'
import { DepositBonusService } from './deposit-bonus.service'
import { PayerIdentityService, FIRST_DEPOSIT_PAYER_LOCK_CLASSID, type SharedPayerMatch } from './payer-identity.service'
import { isZareCashMethod } from '../gateways/payment/zarecash/method-config'
import { getQueue, QUEUE_NAMES, ZARECASH_WITHDRAWAL_ATTEMPTS } from '../lib/queue'
import { reportError } from '../lib/sentry'
import { captureEvent } from '../lib/posthog'
import { emitDepositApproved, hoursBetween, withdrawalMethodFromNote } from '../lib/posthog-events'

/**
 * Player-facing expiry wording. Bonus windows are lived in Addis time (see
 * lib/bonus-period), so a UTC rendering would be off by three hours and put a
 * late-evening expiry on the wrong day.
 */
function formatAddisTime(at: Date): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Addis_Ababa',
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(at)
}

/**
 * The referral reward credits the REFERRER's realBalance and writes a
 * referralReward row, so a silent failure here is an unpaid referrer with no
 * trace of the debt anywhere. It runs post-commit and must stay best-effort —
 * the deposit is already durable and cannot be unwound over it — so reporting
 * loudly is the only thing left that makes the miss recoverable by a human.
 */
function reportReferralRewardFailure(err: unknown, userId: string, transactionId: string): void {
    console.error(
        '[WalletService] referral first-deposit reward failed for user %s after deposit %s:',
        userId,
        transactionId,
        (err as Error)?.message,
    )
    reportError(err, { service: 'wallet', phase: 'referral-first-deposit-bonus', userId, transactionId })
}

export class WalletService {
    static async getBalance(userId: string) {
        const wallet = await prisma.wallet.findUnique({
            where: { userId },
        })
        if (!wallet) throw new Error('Wallet not found')
        return wallet
    }

    static async setSpendAccount(userId: string, account: 'REAL' | 'BONUS') {
        return prisma.wallet.update({ where: { userId }, data: { spendAccount: account } })
    }

    static async initiateDeposit(userId: string, data: DepositDto) {
        const [minRow, maxRow] = await Promise.all([
            prisma.siteSetting.findUnique({ where: { key: 'min_deposit_amount' } }),
            prisma.siteSetting.findUnique({ where: { key: 'max_deposit_amount' } }),
        ])
        const minDeposit = minRow ? Number(minRow.value) : 10
        const maxDeposit = maxRow ? Number(maxRow.value) : 50000
        if (data.amount < minDeposit) {
            throw Object.assign(new Error(`Minimum deposit amount is ${minDeposit} Birr`), { statusCode: 400 })
        }
        if (data.amount > maxDeposit) {
            throw Object.assign(new Error(`Maximum deposit amount is ${maxDeposit} Birr`), { statusCode: 400 })
        }

        // Normalize so dedup is case-insensitive (e.g. "ABC123" == "abc123")
        const paymentTransactionId = data.transactionId?.trim().toUpperCase()

        // Reject duplicate payment transaction IDs
        if (paymentTransactionId) {
            const existing = await prisma.transaction.findUnique({
                where: { paymentTransactionId },
            })
            if (existing) {
                throw Object.assign(new Error('Transaction ID already used'), { statusCode: 409 })
            }
        }

        // Route to ZareCash when the method has opted in; otherwise keep the
        // manual flow untouched, including local auto-verification. Resolved
        // BEFORE the insert so the routing decision can be recorded on the row.
        const routeToZareCash = await isZareCashMethod(data.methodCode)

        // Create a pending transaction
        const transaction = await prisma.transaction.create({
            data: {
                userId,
                type: TransactionType.DEPOSIT,
                amount: data.amount,
                status: PaymentStatus.PENDING_REVIEW, // Needs admin approval
                receiptUrl: data.receiptUrl,
                paymentTransactionId,
                senderName: data.senderName,
                senderAccount: data.senderAccount,
                ...(data.methodCode ? { note: data.methodCode } : {}),
                ...(routeToZareCash ? { gateway: 'zarecash' } : {}),
            },
        })
        void captureEvent(userId, 'deposit_submitted', {
            amount: Number(data.amount),
            method: data.methodCode ?? null,
            gateway: routeToZareCash ? 'zarecash' : 'manual',
            tx_id: transaction.id,
        })
        if (routeToZareCash) {
            // Submit on a queue, not inline: it buys retries for free, and it
            // keeps wallet.service from importing zarecash.service (which imports
            // WalletService back — a cycle that leaves one of them undefined at
            // module init). A failed submit leaves the deposit PENDING_REVIEW,
            // which is a safe state: no money has moved.
            //
            // The row is COMMITTED by the time we get here, and
            // `paymentTransactionId` is unique — so letting a Redis blip surface
            // as a 500 would burn the receipt permanently: the player's retry hits
            // the duplicate check and 409s "Transaction ID already used", with an
            // orphaned PENDING_REVIEW row behind it and no job to submit it. Both
            // sibling paths already refuse to do that (the manual path's
            // DepositVerificationService.enqueue swallows; the withdrawal enqueue
            // was hardened the same way). Report and continue — a human can still
            // approve the row.
            try {
                await getQueue(QUEUE_NAMES.ZARECASH_DEPOSIT).add('submit', { transactionId: transaction.id })
            } catch (err) {
                console.error('[WalletService] failed to enqueue ZareCash deposit submit:', (err as Error).message)
                reportError(err, {
                    service: 'wallet',
                    phase: 'zarecash-deposit-enqueue',
                    transactionId: transaction.id,
                })
            }
            return transaction
        }

        // Best-effort: kick off async auto-verification. Swallows its own errors so a
        // queue hiccup can never break deposit submission — the deposit still goes to manual.
        await DepositVerificationService.enqueue(transaction.id)
        return transaction
    }

    // Called by Admin — uses SELECT FOR UPDATE to prevent double-crediting
    static async approveDeposit(transactionId: string, adjustedAmount?: number, reviewerId?: string) {
        return await prisma.$transaction(async (tx) => {
            // Lock the transaction row first to prevent concurrent approvals from both
            // passing the PENDING_REVIEW check before either commits.
            const transactions = await tx.$queryRaw<Array<{ id: string; userId: string; amount: Decimal; status: string; type: string; note: string | null; createdAt: Date }>>`
                SELECT id, "userId", amount, status, type, note, "createdAt" FROM transactions WHERE id = ${transactionId} FOR UPDATE
            `
            const transaction = transactions[0]
            if (!transaction || transaction.status !== PaymentStatus.PENDING_REVIEW) {
                throw new Error('Invalid transaction')
            }

            // Separation of duties (defense-in-depth; also enforced in reviewTransaction):
            // a reviewer may never credit a deposit into their own account.
            if (reviewerId && reviewerId === transaction.userId) {
                throw new Error('You cannot approve your own deposit')
            }

            // Lock the wallet row before reading and updating
            const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${transaction.userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet) throw new Error('Wallet not found')

            // Determine the amount to credit. When an admin adjusts the deposit
            // during review, `adjustedAmount` overrides the player-stated value and
            // the original is preserved in `originalAmount` for the audit trail.
            const statedAmount = new Decimal(transaction.amount)
            const creditAmount = adjustedAmount != null ? new Decimal(adjustedAmount) : statedAmount
            if (!creditAmount.isFinite() || creditAmount.lte(0)) {
                throw new Error('Adjusted amount must be a positive number')
            }
            const isAdjusted = adjustedAmount != null && !creditAmount.equals(statedAmount)

            const realBefore = new Decimal(wallet.realBalance)
            const realAfter = realBefore.plus(creditAmount)
            const bonusBefore = new Decimal(wallet.bonusBalance)

            // Update transaction status with balance snapshot. If the amount was
            // adjusted, overwrite `amount` with the credited value and keep the
            // player-stated figure in `originalAmount`.
            await tx.transaction.update({
                where: { id: transactionId },
                data: {
                    status: PaymentStatus.APPROVED,
                    reviewedById: reviewerId,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                    ...(isAdjusted ? { amount: creditAmount, originalAmount: statedAmount } : {}),
                },
            })

            // Credit realBalance with the (possibly adjusted) amount
            await tx.wallet.update({
                where: { userId: transaction.userId },
                data: { realBalance: { increment: creditAmount } },
            })

            // ── First Deposit Bonus ──────────────────────────────────────────
            const previousApproved = await tx.transaction.count({
                where: {
                    userId: transaction.userId,
                    type: TransactionType.DEPOSIT,
                    status: PaymentStatus.APPROVED,
                    id: { not: transactionId },
                },
            })

            let bonusAwarded = 0
            // Set when this is the account's first deposit but its paying account already
            // funded another account's first deposit (the duplicate-account farming
            // pattern). Withholds the first-deposit bonus here and the referral reward below.
            let sharedPayer: SharedPayerMatch | null = null
            let firstDepositBonusBlocked = false
            // Set when taking the paying-account lock or running that lookup failed. Fails
            // closed on the incentives (both are withheld, as for a shared payer) and open
            // on the deposit credited above.
            let payerCheckFailure: { stage: 'lock' | 'lookup'; error: unknown } | null = null
            if (previousApproved === 0) {
                // Serialise first-deposit approvals paid from one account. Otherwise two
                // accounts' first deposits from the same payer approved at once (the ZareCash
                // workers run at concurrency 4) each run the lookup below before the other
                // commits, and both collect both incentives. Only this first-deposit path
                // locks, so ordinary deposits never queue. Every key the lookup can match on
                // is locked, in the helper's sorted order so two approvals never wait on each
                // other. The transaction stays READ COMMITTED on purpose: the lookup's
                // statement snapshot is taken after the wait, so it sees the earlier
                // approval's commit; a stricter isolation level would pin it before the wait.
                //
                // Lock and lookup each run under a savepoint: a failed statement aborts the
                // whole Postgres transaction (every later query errors with 25P02), which
                // would roll back the credit above too. RELEASE hands the acquired locks to
                // this transaction, which holds them until commit. A failure rolls back to
                // the savepoint, dropping any lock taken so far, and withholds the incentives,
                // so there is then nothing left to serialise.
                await tx.$executeRaw`SAVEPOINT first_deposit_payer_lock`
                try {
                    for (const key of await PayerIdentityService.firstDepositLockKeys(tx, transactionId)) {
                        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_DEPOSIT_PAYER_LOCK_CLASSID}::int, hashtext(${key}))`
                    }
                } catch (error) {
                    payerCheckFailure = { stage: 'lock', error }
                    await tx.$executeRaw`ROLLBACK TO SAVEPOINT first_deposit_payer_lock`
                }
                await tx.$executeRaw`RELEASE SAVEPOINT first_deposit_payer_lock`

                if (!payerCheckFailure) {
                    await tx.$executeRaw`SAVEPOINT first_deposit_payer_lookup`
                    try {
                        sharedPayer = await PayerIdentityService.findPriorFirstDepositByPayer(tx, {
                            userId: transaction.userId,
                            transactionId,
                        })
                    } catch (error) {
                        payerCheckFailure = { stage: 'lookup', error }
                        await tx.$executeRaw`ROLLBACK TO SAVEPOINT first_deposit_payer_lookup`
                    }
                    await tx.$executeRaw`RELEASE SAVEPOINT first_deposit_payer_lookup`
                }
                const incentivesWithheld = sharedPayer !== null || payerCheckFailure !== null

                // This is their first deposit — check for bonus setting
                const bonusSetting = await tx.siteSetting.findUnique({ where: { key: 'first_deposit_bonus_amount' } })
                const bonusAmount = Number(bonusSetting?.value ?? '0')
                firstDepositBonusBlocked = bonusAmount > 0 && incentivesWithheld

                if (bonusAmount > 0 && !incentivesWithheld) {
                    const grantResult = await BonusService.grant(tx, {
                        userId: transaction.userId,
                        amount: bonusAmount,
                        source: 'FIRST_DEPOSIT',
                    })

                    if (grantResult.granted) {
                        await tx.transaction.create({
                            data: {
                                userId: transaction.userId,
                                type: TransactionType.FIRST_DEPOSIT_BONUS,
                                amount: bonusAmount,
                                status: PaymentStatus.APPROVED,
                                note: 'First deposit bonus',
                                balanceBefore: realAfter,
                                balanceAfter: realAfter,
                                bonusBalanceBefore: grantResult.bonusBalanceBefore,
                                bonusBalanceAfter: grantResult.bonusBalanceAfter,
                            },
                        })
                        bonusAwarded = bonusAmount
                    }
                }
            }

            // ── Deposit Bonus Rules (daily / weekly threshold) ──────────────
            // Runs regardless of whether a first-deposit bonus was just granted
            // above — the two are independent and both can fire on the same
            // deposit (e.g. a large first deposit that also crosses a daily
            // threshold).
            const depositBonusResult = await DepositBonusService.evaluateAndGrant(tx, transaction.userId, transaction.createdAt, new Date())

            return { transaction, realAfter, bonusAwarded, bonusBefore, creditAmount, isAdjusted, statedAmount, depositBonusResult, sharedPayer, firstDepositBonusBlocked, payerCheckFailure }
        }).then(async ({ transaction, realAfter, bonusAwarded, bonusBefore, creditAmount, isAdjusted, statedAmount, depositBonusResult, sharedPayer, firstDepositBonusBlocked, payerCheckFailure }) => {
            const depositBonusTotal = [...depositBonusResult.daily, ...depositBonusResult.weekly]
                .reduce((sum, grant) => sum.plus(grant.amount), new Decimal(0))
            const finalBonusBalance = bonusBefore.plus(new Decimal(bonusAwarded)).plus(depositBonusTotal).toNumber()

            // Push balance update
            NotificationService.pushWalletUpdate(
                transaction.userId,
                realAfter.toNumber(),
                finalBonusBalance,
            )

            // PostHog — post-commit only. The approval itself, then every bonus
            // this approval granted (first-deposit and rule-based).
            void emitDepositApproved(transaction.id)
            if (sharedPayer) {
                console.warn(
                    '[WalletService] first deposit %s shares its paying account with first deposit %s of another account (%s); first-deposit incentives withheld',
                    transaction.id,
                    sharedPayer.transactionId,
                    sharedPayer.matchedOn,
                )
                void captureEvent(transaction.userId, 'first_deposit_shared_payer', {
                    matched_on: sharedPayer.matchedOn,
                    bonus_blocked: firstDepositBonusBlocked,
                })
            }
            if (payerCheckFailure) {
                // The log line carries only the error's code or name: a driver message can
                // echo query values, and these queries' values are the player's paying account.
                const { stage, error } = payerCheckFailure
                const reason = (error as { code?: unknown } | null)?.code ?? (error as Error | null)?.name ?? 'unknown'
                console.error(
                    '[WalletService] first deposit %s payer %s failed (%s); first-deposit incentives withheld',
                    transaction.id,
                    stage,
                    String(reason),
                )
                reportError(error, { service: 'wallet', phase: `first-deposit-payer-${stage}`, transactionId: transaction.id })
            }
            if (bonusAwarded > 0) {
                void captureEvent(transaction.userId, 'bonus_granted', {
                    amount: bonusAwarded,
                    source: 'FIRST_DEPOSIT',
                    rule_id: null,
                })
            }
            const depositBonusGrants = [...depositBonusResult.daily, ...depositBonusResult.weekly]
            for (const grant of depositBonusGrants) {
                void captureEvent(transaction.userId, 'bonus_granted', {
                    amount: Number(grant.amount),
                    source: 'DEPOSIT_RULE',
                    rule_id: grant.ruleId,
                })
            }

            // One notification per rule that paid. The DEPOSIT_APPROVED message
            // below speaks only for the first-deposit bonus, so without these a
            // threshold bonus is a silent balance jump the player has no way to
            // explain — or to spend before it expires. Fire-and-forget after
            // commit: the grant is already durable, and a notification failure
            // must never take the money with it.
            for (const grant of depositBonusGrants) {
                void NotificationService.create(
                    transaction.userId,
                    NotificationType.BONUS_GRANTED,
                    'Bonus Received 🎁',
                    `You earned a ${Number(grant.amount).toFixed(2)} ETB bonus from ${grant.name}. Use it before ${formatAddisTime(grant.expiresAt)}.`,
                    {
                        amount: Number(grant.amount),
                        source: 'DEPOSIT_RULE',
                        ruleId: grant.ruleId,
                        ruleName: grant.name,
                        expiresAt: grant.expiresAt.toISOString(),
                    },
                ).catch(() => {})
            }

            // Metrics: deposit approved (post-commit). The payment method is stored
            // in `note` (the client-supplied methodCode) by initiateDeposit. Bound
            // the label to the configured PaymentMethod catalog so an arbitrary
            // client value can never explode Prometheus label cardinality: unknown
            // codes collapse to 'other', a missing code to 'unknown'.
            let methodLabel = 'unknown'
            if (transaction.note) {
                const known = await prisma.paymentMethod
                    .findUnique({ where: { code: transaction.note }, select: { code: true } })
                    .catch(() => null)
                methodLabel = known ? transaction.note : 'other'
            }
            wbDepositsTotal.labels(methodLabel, 'approved').inc()

            // Send notification (reflects the credited amount, which may have been adjusted)
            const credited = creditAmount.toNumber()
            const metadata: Record<string, unknown> = {
                transactionId: transaction.id,
                amount: credited,
            }
            if (isAdjusted) {
                metadata.originalAmount = statedAmount.toNumber()
            }
            if (bonusAwarded > 0) {
                metadata.bonusAwarded = bonusAwarded
            }
            if (depositBonusTotal.gt(0)) {
                // Distinct from `bonusAwarded`, which is the first-deposit bonus alone:
                // the two are independent and a single deposit can carry both.
                metadata.depositBonusAwarded = depositBonusTotal.toNumber()
            }

            await NotificationService.create(
                transaction.userId,
                NotificationType.DEPOSIT_APPROVED,
                'Deposit Approved ✅',
                bonusAwarded > 0
                    ? `Your deposit of ${credited.toFixed(2)} ETB has been approved! You also received a ${bonusAwarded.toFixed(2)} ETB first deposit bonus!`
                    : `Your deposit of ${credited.toFixed(2)} ETB has been approved and added to your wallet.`,
                metadata,
            ).catch(() => {})

            // Check referral bonus (only on first deposit, bonus already handled above)
            if (bonusAwarded > 0) {
                // bonusAwarded > 0 means this IS the first deposit
                await ReferralService.processFirstDepositBonus(transaction.userId).catch((err) =>
                    reportReferralRewardFailure(err, transaction.userId, transaction.id),
                )
            } else if (!sharedPayer && !payerCheckFailure) {
                // Still check if it's first deposit for referral purposes
                const previousApproved = await prisma.transaction.count({
                    where: {
                        userId: transaction.userId,
                        type: TransactionType.DEPOSIT,
                        status: PaymentStatus.APPROVED,
                        id: { not: transaction.id },
                    },
                })
                if (previousApproved === 0) {
                    await ReferralService.processFirstDepositBonus(transaction.userId).catch((err) =>
                        reportReferralRewardFailure(err, transaction.userId, transaction.id),
                    )
                }
            }

            // Return the transaction reflecting the credited (possibly adjusted) amount
            return { ...transaction, amount: creditAmount, originalAmount: isAdjusted ? statedAmount : null }
        })
    }

    static async requestWithdrawal(userId: string, data: { amount: number, paymentMethod: string, accountNumber: string }) {
        // Anything other than ACTIVE cannot withdraw. The route already carries
        // requireActiveAccount; this is the deliberate duplicate, because it is
        // the last check before money moves and must not depend on a caller
        // having remembered a preHandler.
        //
        // Reads the column directly rather than going through
        // AccountStatusService: that service imports ZareCashService, which
        // imports this one, and the cycle is not worth a cache hit here.
        const account = await prisma.user.findUnique({ where: { id: userId }, select: { accountStatus: true } })
        if (!account) throw new Error('User not found')
        if (account.accountStatus !== AccountStatus.ACTIVE) {
            throw Object.assign(
                new Error('This account is under review. Withdrawals are temporarily disabled — please contact support.'),
                { statusCode: 403 },
            )
        }

        const pendingWithdrawal = await prisma.transaction.findFirst({
            where: { userId, type: TransactionType.WITHDRAWAL, status: PaymentStatus.PENDING_REVIEW },
        })
        if (pendingWithdrawal) {
            throw Object.assign(
                new Error('You already have a pending withdrawal request. Please wait for it to be processed before submitting a new one.'),
                { statusCode: 409 },
            )
        }

        const [minRow, maxRow] = await Promise.all([
            prisma.siteSetting.findUnique({ where: { key: 'min_withdrawal_amount' } }),
            prisma.siteSetting.findUnique({ where: { key: 'max_withdrawal_amount' } }),
        ])
        const minWithdrawal = minRow ? Number(minRow.value) : 100
        const maxWithdrawal = maxRow ? Number(maxRow.value) : 10000
        if (data.amount < minWithdrawal) {
            throw new Error(`Minimum withdrawal amount is ${minWithdrawal} Birr`)
        }
        if (data.amount > maxWithdrawal) {
            throw new Error(`Maximum withdrawal amount is ${maxWithdrawal} Birr`)
        }

        // Resolve routing BEFORE opening the wallet transaction — it is a read of
        // PaymentMethod config, and it must be known INSIDE the transaction so the
        // decision lands on the row atomically with the debit. See the comment on
        // `gateway` below for why that timing is the whole point.
        const routeToZareCash = await isZareCashMethod(data.paymentMethod)

        return await prisma.$transaction(async (tx) => {
            // Lock the wallet row to prevent concurrent withdrawals from passing the balance check
            const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet || new Decimal(wallet.realBalance).lessThan(new Decimal(data.amount))) {
                throw new Error('Insufficient balance — only your real balance is withdrawable')
            }

            // Authoritative single-pending guard INSIDE the wallet lock. Concurrent
            // requests for the same user serialize on the FOR UPDATE row above, so the
            // second caller sees the first's pending row here (the pre-check at the top
            // is only a fast-path for UX and is not race-safe on its own).
            const stillPending = await tx.transaction.findFirst({
                where: { userId, type: TransactionType.WITHDRAWAL, status: PaymentStatus.PENDING_REVIEW },
            })
            if (stillPending) {
                throw Object.assign(
                    new Error('You already have a pending withdrawal request. Please wait for it to be processed before submitting a new one.'),
                    { statusCode: 409 },
                )
            }

            const realBefore = new Decimal(wallet.realBalance)
            const realAfter = realBefore.minus(new Decimal(data.amount))
            const bonusBefore = new Decimal(wallet.bonusBalance)

            // Lock the balance immediately
            await tx.wallet.update({
                where: { userId },
                data: { realBalance: { decrement: data.amount } }
            })

            // Create a pending withdrawal with balance snapshot.
            //
            // `gateway` is written HERE, in the same transaction as the debit, and
            // that timing is load-bearing. It is what arms the admin double-pay
            // guard (AdminService.reviewTransaction). Keying that guard on
            // `gatewayRef` instead — as it originally did — armed it far too late:
            // gatewayRef is only written once ZareCash has answered the payout
            // POST, and that POST can be in flight for ZARECASH_TIMEOUT_MS per
            // attempt across several attempts. In that window a clerk working the
            // review queue saw gatewayRef null, sailed through the guard, and
            // refunded (or hand-paid) a payout ZareCash was about to settle.
            // gatewayRef stays exactly what it is — the upstream id, written when
            // we learn it.
            const transaction = await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.WITHDRAWAL,
                    amount: data.amount,
                    status: PaymentStatus.PENDING_REVIEW,
                    note: `${data.paymentMethod}: ${data.accountNumber}`,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                    ...(routeToZareCash ? { gateway: 'zarecash' } : {}),
                },
            })
            return { transaction, realAfter, bonusBefore }
        }).then(async ({ transaction, realAfter, bonusBefore }) => {
            // Push balance update
            NotificationService.pushWalletUpdate(userId, realAfter.toNumber(), bonusBefore.toNumber())

            void captureEvent(userId, 'withdrawal_requested', {
                amount: data.amount,
                method: data.paymentMethod,
                gateway: routeToZareCash ? 'zarecash' : 'manual',
                tx_id: transaction.id,
            })

            // Submit AFTER the DB transaction commits — never hold the wallet lock
            // across a network call. Routing data travels on the job rather than
            // being parsed back out of the free-form `note` string.
            //
            // The debit and PENDING_REVIEW row are already committed by this point,
            // so a failure here (Redis down, DB blip on the isZareCashMethod read)
            // must not surface as a request error — the player would see a failed
            // withdrawal while actually being debited, with no way to retry (the
            // single-pending guard blocks a resubmit). The row is already in the
            // exact state the manual admin path knows how to handle, so swallow and
            // report instead of throwing.
            try {
                if (routeToZareCash) {
                    await getQueue(QUEUE_NAMES.ZARECASH_WITHDRAWAL).add(
                        'submit',
                        {
                            transactionId: transaction.id,
                            methodCode: data.paymentMethod,
                            destinationAccount: data.accountNumber,
                        },
                        { attempts: ZARECASH_WITHDRAWAL_ATTEMPTS },
                    )
                }
            } catch (err) {
                console.error('[WalletService] failed to enqueue ZareCash withdrawal submit:', (err as Error).message)
                reportError(err, { service: 'wallet', phase: 'zarecash-withdrawal-enqueue', transactionId: transaction.id })
                // The queue never accepted the job, so nothing will ever submit
                // this payout to ZareCash — which means the gateway does NOT own
                // this row and must not hold the admin guard shut on it. Hand it
                // back to the manual review path (which is exactly the state the
                // comment above describes) rather than leaving the player debited
                // behind a guard no worker will ever release. Scoped to
                // PENDING_REVIEW so it can never disturb a row something else has
                // already moved on.
                await prisma.transaction
                    .updateMany({
                        where: {
                            id: transaction.id,
                            gateway: 'zarecash',
                            gatewayRef: null,
                            status: PaymentStatus.PENDING_REVIEW,
                        },
                        data: { gateway: null },
                    })
                    .catch((clearErr) => {
                        // Best-effort compensation only. Failing here leaves the row
                        // marked gateway-managed — safe (no double pay), but it needs
                        // a human, so say so loudly.
                        console.error(
                            '[WalletService] could not release gateway marker on %s after a failed enqueue:',
                            transaction.id,
                            (clearErr as Error).message,
                        )
                        reportError(clearErr, {
                            service: 'wallet',
                            phase: 'zarecash-withdrawal-marker-release',
                            transactionId: transaction.id,
                        })
                    })
            }
            return transaction
        })
    }

    /**
     * Reject a pending withdrawal and refund the player.
     *
     * Extracted from AdminService so both a human reviewer and the ZareCash
     * withdrawal worker can reach it. The claim is an atomic conditional update:
     * two concurrent rejects serialize on the row and the loser aborts BEFORE
     * crediting, so the wallet can never be double-refunded.
     */
    static async rejectWithdrawal(transactionId: string, note?: string, reviewerId?: string) {
        const existing = await prisma.transaction.findUnique({ where: { id: transactionId } })
        if (!existing) throw new Error('Transaction not found')
        if (existing.type !== TransactionType.WITHDRAWAL) {
            throw new Error('rejectWithdrawal only applies to withdrawals')
        }

        const result = await prisma.$transaction(async (tx) => {
            const claim = await tx.transaction.updateMany({
                where: { id: transactionId, status: PaymentStatus.PENDING_REVIEW },
                data: { status: PaymentStatus.REJECTED, note, reviewedById: reviewerId },
            })
            if (claim.count === 0) {
                throw new Error('Transaction is not pending review')
            }
            const updated = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } })

            const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${existing.userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet) throw new Error('Wallet not found')

            const realBefore = new Decimal(wallet.realBalance)
            const realAfter = realBefore.plus(new Decimal(existing.amount))
            const bonusBefore = new Decimal(wallet.bonusBalance)

            await tx.wallet.update({
                where: { userId: existing.userId },
                data: { realBalance: { increment: existing.amount } },
            })

            await tx.transaction.create({
                data: {
                    userId: existing.userId,
                    type: TransactionType.REFUND,
                    amount: existing.amount,
                    status: PaymentStatus.APPROVED,
                    referenceId: transactionId,
                    note: `Refund for rejected withdrawal${note ? `: ${note}` : ''}`,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                },
            })

            return { updated, realAfter, bonusBefore }
        })

        NotificationService.pushWalletUpdate(
            existing.userId,
            result.realAfter.toNumber(),
            result.bonusBefore.toNumber(),
        )

        await NotificationService.create(
            existing.userId,
            NotificationType.WITHDRAWAL_PROCESSED,
            'Withdrawal Rejected',
            `Your withdrawal of ${Number(existing.amount).toFixed(2)} ETB was rejected and refunded to your wallet.${note ? ` Reason: ${note}` : ''}`,
            { transactionId, amount: Number(existing.amount), note },
        ).catch(() => {})

        void captureEvent(existing.userId, 'withdrawal_rejected', {
            amount: Number(existing.amount),
            method: withdrawalMethodFromNote(existing.note),
            hours_to_decision: hoursBetween(existing.createdAt, new Date()),
            tx_id: transactionId,
        })

        wbWithdrawalsTotal.labels('rejected').inc()

        return result.updated
    }

    static async getTransactions(
        userId: string,
        params: { type?: TransactionType; page?: number; limit?: number },
    ) {
        const page = params.page ?? 1
        const limit = params.limit ?? 20
        const skip = (page - 1) * limit

        const [transactions, total] = await Promise.all([
            prisma.transaction.findMany({
                where: {
                    userId,
                    ...(params.type && { type: params.type }),
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.transaction.count({
                where: {
                    userId,
                    ...(params.type && { type: params.type }),
                },
            }),
        ])

        return {
            data: transactions,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        }
    }

    static async getUserStats(userId: string) {
        const [entries, prizes] = await Promise.all([
            prisma.transaction.aggregate({
                where: { userId, type: TransactionType.GAME_ENTRY },
                _count: true,
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { userId, type: TransactionType.PRIZE_WIN },
                _count: true,
                _sum: { amount: true },
            }),
        ])
        return {
            gamesPlayed: entries._count,
            gamesWon: prizes._count,
            totalWagered: Number(entries._sum.amount ?? 0),
            totalWon: Number(prizes._sum.amount ?? 0),
        }
    }
}
