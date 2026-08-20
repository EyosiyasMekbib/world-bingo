import { describe, it, expect } from 'vitest'
import { prisma } from './setup'
import { WalletService } from '../services/wallet.service'

async function makeUser(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: { realBalance: 0, bonusBalance: 0 } } },
    })
}

describe('WalletService.setSpendAccount', () => {
    it('flips the selected account and defaults to REAL', async () => {
        const user = await makeUser('spendacct1', '+251900000018')
        const initial = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(initial.spendAccount).toBe('REAL')

        const updated = await WalletService.setSpendAccount(user.id, 'BONUS')
        expect(updated.spendAccount).toBe('BONUS')
    })
})
