const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();
async function test() {
  const data = { identifier: 'kira', password: 'password123' };
  const user = await prisma.user.findFirst({
      where: {
          OR: [
              { phone: data.identifier },
              { username: data.identifier },
          ],
      },
  });
  if (!user) { console.log('No user'); return; }
  const isValid = await bcrypt.compare(data.password, user.passwordHash);
  console.log('isValid:', isValid);
}
test().catch(console.error).finally(() => prisma.$disconnect());
