import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { PayerIdentityService, senderAccountKey, maskedPayerKey } from '../services/payer-identity.service'

describe('payer keys', () => {
    it('keys a sender account on its last 9 digits', () => {
        expect(senderAccountKey('0912345678')).toBe('912345678')
        expect(senderAccountKey('+251 912-345-678')).toBe('912345678')
    })

    it('refuses sender accounts too short to trust', () => {
        expect(senderAccountKey('12345')).toBeNull()
        expect(senderAccountKey('')).toBeNull()
        expect(senderAccountKey(null)).toBeNull()
    })

    it('keys a masked receipt number without whitespace', () => {
        expect(maskedPayerKey('2519****2528')).toBe('2519****2528')
        expect(maskedPayerKey(' 2519 **** 2528 ')).toBe('2519****2528')
    })

    it('refuses masked numbers that show fewer than 8 digits', () => {
        expect(maskedPayerKey('****2528')).toBeNull()
        expect(maskedPayerKey(undefined)).toBeNull()
    })
})

let n = 0
async function player(): Promise<string> {
    n++
    const user = await prisma.user.create({
        data: {
            username: `payer-${n}`,
            phone: `+2519300000${String(n).padStart(2, '0')}`,
            passwordHash: 'x',
            wallet: { create: { realBalance: 0 } },
        },
    })
    return user.id
}

async function deposit(
    userId: string,
    o: {
        status?: 'APPROVED' | 'PENDING_REVIEW' | 'REJECTED'
        senderAccount?: string
        createdAt?: string
        payerNumberMasked?: string
        payerName?: string
    },
): Promise<string> {
    const tx = await prisma.transaction.create({
        data: {
            userId,
            type: 'DEPOSIT',
            amount: 100,
            status: o.status ?? 'APPROVED',
            senderAccount: o.senderAccount,
            createdAt: o.createdAt ? new Date(o.createdAt) : undefined,
        },
    })
    if (o.payerNumberMasked || o.payerName) {
        await prisma.depositVerification.create({
            data: {
                transactionId: tx.id,
                status: 'MANUAL_REQUIRED',
                decisionReasons: [],
                payerNumberMasked: o.payerNumberMasked,
                payerName: o.payerName,
            },
        })
    }
    return tx.id
}

describe('PayerIdentityService.findPriorFirstDepositByPayer', () => {
    it("matches another account's first approved deposit by sender account", async () => {
        const a = await player()
        const b = await player()
        const aFirst = await deposit(a, { senderAccount: '0911222333', createdAt: '2026-09-01T10:00:00Z' })
        const current = await deposit(b, { status: 'PENDING_REVIEW', senderAccount: '+251911222333' })
        await expect(PayerIdentityService.findPriorFirstDepositByPayer(prisma, { userId: b, transactionId: current })).resolves.toEqual({
            transactionId: aFirst,
            userId: a,
            matchedOn: 'sender_account',
        })
    })

    it("ignores the same account's own deposits", async () => {
        const a = await player()
        await deposit(a, { senderAccount: '0911222333', createdAt: '2026-09-01T10:00:00Z' })
        const current = await deposit(a, { status: 'PENDING_REVIEW', senderAccount: '0911222333' })
        await expect(PayerIdentityService.findPriorFirstDepositByPayer(prisma, { userId: a, transactionId: current })).resolves.toBeNull()
    })

    it("ignores another account's deposit that was not its first approved deposit", async () => {
        const a = await player()
        const b = await player()
        await deposit(a, { senderAccount: '0944000000', createdAt: '2026-09-01T10:00:00Z' })
        await deposit(a, { senderAccount: '0911222333', createdAt: '2026-09-02T10:00:00Z' })
        const current = await deposit(b, { status: 'PENDING_REVIEW', senderAccount: '0911222333' })
        await expect(PayerIdentityService.findPriorFirstDepositByPayer(prisma, { userId: b, transactionId: current })).resolves.toBeNull()
    })

    it('ignores pending and rejected deposits on other accounts', async () => {
        const a = await player()
        const c = await player()
        const b = await player()
        await deposit(a, { status: 'PENDING_REVIEW', senderAccount: '0911222333' })
        await deposit(c, { status: 'REJECTED', senderAccount: '0911222333' })
        const current = await deposit(b, { status: 'PENDING_REVIEW', senderAccount: '0911222333' })
        await expect(PayerIdentityService.findPriorFirstDepositByPayer(prisma, { userId: b, transactionId: current })).resolves.toBeNull()
    })

    it('matches by receipt payer when the masked number and normalised name agree', async () => {
        const a = await player()
        const b = await player()
        const aFirst = await deposit(a, { payerNumberMasked: '2519****2528', payerName: 'Abebe  Kebede', createdAt: '2026-09-01T10:00:00Z' })
        const current = await deposit(b, { status: 'PENDING_REVIEW', payerNumberMasked: '2519 **** 2528', payerName: 'ABEBE KEBEDE' })
        await expect(PayerIdentityService.findPriorFirstDepositByPayer(prisma, { userId: b, transactionId: current })).resolves.toEqual({
            transactionId: aFirst,
            userId: a,
            matchedOn: 'receipt_payer',
        })
    })

    it('does not match a masked number carried by a different payer name', async () => {
        const a = await player()
        const b = await player()
        await deposit(a, { payerNumberMasked: '2519****2528', payerName: 'Abebe Kebede', createdAt: '2026-09-01T10:00:00Z' })
        const current = await deposit(b, { status: 'PENDING_REVIEW', payerNumberMasked: '2519****2528', payerName: 'Sara Tesfaye' })
        await expect(PayerIdentityService.findPriorFirstDepositByPayer(prisma, { userId: b, transactionId: current })).resolves.toBeNull()
    })

    it('returns the earliest qualifying match when two other accounts share the sender account', async () => {
        const a = await player()
        const c = await player()
        const b = await player()
        // c's first approved deposit is LATER than a's, even though c is created and
        // deposited "second" in wall-clock call order below — createdAt is what must
        // decide the winner, not insertion order.
        const cFirst = await deposit(c, { senderAccount: '0911222333', createdAt: '2026-09-03T10:00:00Z' })
        const aFirst = await deposit(a, { senderAccount: '0911222333', createdAt: '2026-09-01T10:00:00Z' })
        const current = await deposit(b, { status: 'PENDING_REVIEW', senderAccount: '0911222333' })
        await expect(PayerIdentityService.findPriorFirstDepositByPayer(prisma, { userId: b, transactionId: current })).resolves.toEqual({
            transactionId: aFirst,
            userId: a,
            matchedOn: 'sender_account',
        })
        expect(aFirst).not.toBe(cFirst)
    })

    it('returns the earliest qualifying match when two other accounts share the receipt payer', async () => {
        const a = await player()
        const c = await player()
        const b = await player()
        const cFirst = await deposit(c, { payerNumberMasked: '2519****2528', payerName: 'Abebe Kebede', createdAt: '2026-09-03T10:00:00Z' })
        const aFirst = await deposit(a, { payerNumberMasked: '2519****2528', payerName: 'Abebe Kebede', createdAt: '2026-09-01T10:00:00Z' })
        const current = await deposit(b, { status: 'PENDING_REVIEW', payerNumberMasked: '2519****2528', payerName: 'Abebe Kebede' })
        await expect(PayerIdentityService.findPriorFirstDepositByPayer(prisma, { userId: b, transactionId: current })).resolves.toEqual({
            transactionId: aFirst,
            userId: a,
            matchedOn: 'receipt_payer',
        })
        expect(aFirst).not.toBe(cFirst)
    })
})
