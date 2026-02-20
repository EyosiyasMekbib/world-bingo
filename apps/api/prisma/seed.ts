import prisma from '../src/lib/prisma'
import { generateCartela, generateSerial } from '@world-bingo/game-logic'

async function main() {
    console.log('Seeding Cartelas...')
    const count = await prisma.cartela.count()
    if (count > 0) {
        console.log('Cartelas already exist.')
        return
    }

    const batch = []
    for (let i = 0; i < 100; i++) {
        const grid = generateCartela()
        const serial = generateSerial(grid)
        batch.push({
            serial: `${serial}-${i}`, // Ensure unique in case random same
            grid: grid as any
        })
    }

    await prisma.cartela.createMany({
        data: batch
    })
    console.log('Seeded 100 Cartelas')
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect()
  })
