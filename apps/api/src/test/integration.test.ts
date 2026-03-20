/**
 * T53 — API Integration Tests
 *
 * Full end-to-end flows using real DB (world_bingo_test) and real service layer.
 * Tests verify: auth, deposit, withdrawal, game, and concurrent-race scenarios.
 */
import { describe, it, expect, vi } from 'vitest'
import { prisma } from './setup'
import { AuthService } from '../services/auth.service'
import { WalletService } from '../services/wallet.service'
import { GameService } from '../services/game.service'
import { AdminService } from '../services/admin.service'
import { RefundService } from '../services/refund.service'
import { PaymentStatus, TransactionType, PatternType, GameStatus } from '@world-bingo/shared-types'
import { generateCartela, generateSerial } from '@world-bingo/game-logic'

// Mock socket.io — joinGame emits to the room after the DB transaction
vi.mock('../lib/socket', () => ({
    getIo: () => ({
        to: () => ({ emit: vi.fn() }),
    }),
    initSocket: vi.fn(),
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createUser(username: string, phone: string, balance = 1000) {
    const { user } = await AuthService.register({ username, phone, password: 'password123' })
    if (balance > 0) {
        await prisma.wallet.update({
            where: { userId: user.id },
            data: { balance },
        })
    }
    return user
}

async function seedCartelas(count: number) {
    const created: { id: string; serial: string }[] = []
    for (let i = 0; i < count; i++) {
        const grid = generateCartela()
        const serial = `INTEG-${generateSerial(grid)}-${i}`
        const cartela = await prisma.cartela.upsert({
            where: { serial },
            update: {},
            create: { serial, grid: grid as any },
        })
        created.push({ id: cartela.id, serial: cartela.serial })
    }
    return created
}

async function createGame(adminId: string) {
    return prisma.game.create({
        data: {
            title: 'Integration Test Game',
            ticketPrice: 50,
            maxPlayers: 10,
            minPlayers: 2,
            houseEdgePct: 10,
            pattern: PatternType.ANY_LINE,
            status: GameStatus.WAITING,
            calledBalls: [],
        },
    })
}

// ─── Auth Flow ────────────────────────────────────────────────────────────────

describe('Integration: Auth flow', () => {
    it('register → login with username → refresh → logout', async () => {
        // Register
        const { user } = await AuthService.register({
            username: 'integ_auth',
            phone: '+251900000001',
            password: 'password123',
        })
        expect(user.id).toBeTruthy()

        // Login with username
        const session = await AuthService.login({ identifier: 'integ_auth', password: 'password123' })
        expect(session.refreshToken).toBeTruthy()
        expect(session.user.username).toBe('integ_auth')

        // Refresh token
        const refreshed = await AuthService.refreshToken(session.refreshToken)
        expect(refreshed.refreshToken).toBeTruthy()
        expect(refreshed.refreshToken).not.toBe(session.refreshToken)

        // Logout
        await AuthService.logout(session.refreshToken)

        // Refresh after logout should fail
        await expect(AuthService.refreshToken(session.refreshToken)).rejects.toThrow()
    })

    it('login with phone number', async () => {
        await AuthService.register({
            username: 'integ_phone',
            phone: '+251900000002',
            password: 'password123',
        })
        const session = await AuthService.login({ identifier: '+251900000002', password: 'password123' })
        expect(session.user.phone).toBe('+251900000002')
    })

    it('wrong password rejects login', async () => {
        await AuthService.register({
            username: 'integ_badpw',
            phone: '+251900000003',
            password: 'correct',
        })
        await expect(
            AuthService.login({ identifier: 'integ_badpw', password: 'wrong' })
        ).rejects.toThrow()
    })
})

// ─── Deposit Flow ─────────────────────────────────────────────────────────────

describe('Integration: Deposit flow', () => {
    it('initiate with TeleBirr details → admin approve → balance updated + notification', async () => {
        const user = await createUser('integ_deposit1', '+251900000010', 0)

        // Submit deposit with TeleBirr details
        const tx = await WalletService.initiateDeposit(user.id, {
            amount: 300,
            receiptUrl: 'https://example.com/receipt.png',
            transactionId: 'TLB20260101999',
            senderName: 'Test User',
            senderAccount: '0900000010',
        })
        expect(tx.status).toBe(PaymentStatus.PENDING_REVIEW)
        expect((tx as any).paymentTransactionId).toBe('TLB20260101999')
        expect((tx as any).senderName).toBe('Test User')
        expect((tx as any).senderAccount).toBe('0900000010')

        // Admin approves
        await AdminService.reviewTransaction(tx.id, PaymentStatus.APPROVED)

        // Wallet balance should be 300
        const wallet = await WalletService.getBalance(user.id)
        expect(Number(wallet.balance)).toBe(300)

        // Notification should exist
        const notif = await prisma.notification.findFirst({ where: { userId: user.id } })
        expect(notif).toBeTruthy()
        expect(notif?.type).toBe('DEPOSIT_APPROVED')
    })

    it('admin decline with reason → balance unchanged + notification sent', async () => {
        const user = await createUser('integ_deposit2', '+251900000011', 0)

        const tx = await WalletService.initiateDeposit(user.id, { amount: 200 })
        await AdminService.reviewTransaction(tx.id, PaymentStatus.REJECTED, 'Transaction ID mismatch')

        const wallet = await WalletService.getBalance(user.id)
        expect(Number(wallet.balance)).toBe(0)

        const notif = await prisma.notification.findFirst({ where: { userId: user.id } })
        expect(notif?.type).toBe('DEPOSIT_REJECTED')
    })

    it('double-approve is idempotent — second call throws', async () => {
        const user = await createUser('integ_deposit3', '+251900000012', 0)
        const tx = await WalletService.initiateDeposit(user.id, { amount: 100 })
        await AdminService.reviewTransaction(tx.id, PaymentStatus.APPROVED)
        await expect(
            AdminService.reviewTransaction(tx.id, PaymentStatus.APPROVED)
        ).rejects.toThrow()
    })
})

// ─── Withdrawal Flow ──────────────────────────────────────────────────────────

describe('Integration: Withdrawal flow', () => {
    it('request → admin approve → balance stays deducted + notification', async () => {
        const user = await createUser('integ_wd1', '+251900000020', 500)

        const tx = await WalletService.requestWithdrawal(user.id, {
            amount: 200,
            paymentMethod: 'telebirr',
            accountNumber: '0900000020',
        })
        expect(tx.status).toBe(PaymentStatus.PENDING_REVIEW)

        // Balance immediately deducted
        const walletMid = await WalletService.getBalance(user.id)
        expect(Number(walletMid.balance)).toBe(300)

        // Admin marks as transferred
        await AdminService.reviewTransaction(tx.id, PaymentStatus.APPROVED)
        const walletFinal = await WalletService.getBalance(user.id)
        expect(Number(walletFinal.balance)).toBe(300) // unchanged — funds sent externally

        const notif = await prisma.notification.findFirst({ where: { userId: user.id } })
        expect(notif?.type).toBe('WITHDRAWAL_PROCESSED')
    })

    it('admin reject → balance refunded', async () => {
        const user = await createUser('integ_wd2', '+251900000021', 500)

        const tx = await WalletService.requestWithdrawal(user.id, {
            amount: 200,
            paymentMethod: 'telebirr',
            accountNumber: '0900000021',
        })

        await AdminService.reviewTransaction(tx.id, PaymentStatus.REJECTED, 'Invalid account')

        const wallet = await WalletService.getBalance(user.id)
        expect(Number(wallet.balance)).toBe(500) // refunded
    })

    it('insufficient balance is rejected immediately', async () => {
        const user = await createUser('integ_wd3', '+251900000022', 50)
        await expect(
            WalletService.requestWithdrawal(user.id, {
                amount: 200,
                paymentMethod: 'telebirr',
                accountNumber: '0900000022',
            })
        ).rejects.toThrow('Insufficient balance')
    })

    it('below-minimum withdrawal is rejected', async () => {
        const user = await createUser('integ_wd4', '+251900000023', 500)
        await expect(
            WalletService.requestWithdrawal(user.id, {
                amount: 50, // below 100 minimum
                paymentMethod: 'telebirr',
                accountNumber: '0900000023',
            })
        ).rejects.toThrow('Minimum withdrawal')
    })
})

// ─── Concurrent Withdrawal Race Condition ─────────────────────────────────────

describe('Integration: Concurrent withdrawal race condition', () => {
    it('two concurrent withdrawals with insufficient total — only one succeeds', async () => {
        const user = await createUser('integ_race1', '+251900000030', 300)

        const results = await Promise.allSettled([
            WalletService.requestWithdrawal(user.id, {
                amount: 200,
                paymentMethod: 'telebirr',
                accountNumber: '0900000030',
            }),
            WalletService.requestWithdrawal(user.id, {
                amount: 200,
                paymentMethod: 'telebirr',
                accountNumber: '0900000030',
            }),
        ])

        const successes = results.filter(r => r.status === 'fulfilled')
        const failures = results.filter(r => r.status === 'rejected')
        expect(successes).toHaveLength(1)
        expect(failures).toHaveLength(1)

        // Balance should be exactly 100 (300 - 200)
        const wallet = await WalletService.getBalance(user.id)
        expect(Number(wallet.balance)).toBe(100)
    })
})

// ─── Game Flow ────────────────────────────────────────────────────────────────

describe('Integration: Game flow', () => {
    it('create → join (2 players) → cancel → refunds issued', async () => {
        const [admin, p1, p2] = await Promise.all([
            createUser('integ_gm_admin', '+251900000040', 0),
            createUser('integ_gm_p1', '+251900000041', 200),
            createUser('integ_gm_p2', '+251900000042', 200),
        ])

        const cartelas = await seedCartelas(10)
        const game = await createGame(admin.id)

        expect(game.status).toBe('WAITING')

        // Players join
        await GameService.joinGame(p1.id, game.id, [cartelas[0].serial])
        await GameService.joinGame(p2.id, game.id, [cartelas[1].serial])

        // Balances deducted
        const w1 = await WalletService.getBalance(p1.id)
        const w2 = await WalletService.getBalance(p2.id)
        expect(Number(w1.balance)).toBe(150)
        expect(Number(w2.balance)).toBe(150)

        // Cancel the game → triggers refund via RefundService
        await GameService.cancelGame(game.id)
        await RefundService.refundGame(game.id)

        const w1After = await WalletService.getBalance(p1.id)
        const w2After = await WalletService.getBalance(p2.id)
        expect(Number(w1After.balance)).toBe(200)
        expect(Number(w2After.balance)).toBe(200)
    })
})

// ─── Schema Validation ────────────────────────────────────────────────────────

describe('Integration: Schema validation', () => {
    it('DepositSchema requires transactionId min 5 chars', async () => {
        const { DepositSchema } = await import('@world-bingo/shared-types')
        const result = DepositSchema.safeParse({ amount: 100, transactionId: 'AB' })
        expect(result.success).toBe(false)
    })

    it('DepositSchema passes with valid TeleBirr fields', async () => {
        const { DepositSchema } = await import('@world-bingo/shared-types')
        const result = DepositSchema.safeParse({
            amount: 100,
            transactionId: 'TLB2026XXXXX',
            senderName: 'Test User',
            senderAccount: '0900000099',
        })
        expect(result.success).toBe(true)
    })

    it('LoginSchema rejects empty identifier', async () => {
        const { LoginSchema } = await import('@world-bingo/shared-types')
        const result = LoginSchema.safeParse({ identifier: '', password: '123456' })
        expect(result.success).toBe(false)
    })
})
