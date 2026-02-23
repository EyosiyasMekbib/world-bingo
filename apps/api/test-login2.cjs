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
  
  // Test the rest of the login function
  const crypto = require('crypto');
  const generateRefreshToken = () => crypto.randomBytes(40).toString('hex');
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
  
  const refreshToken = generateRefreshToken();
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  
  try {
    await prisma.refreshToken.create({
        data: {
            userId: user.id,
            tokenHash,
            expiresAt,
        },
    });
    console.log('Refresh token created successfully');
  } catch (e) {
    console.error('Error creating refresh token:', e);
  }
}
test().catch(console.error).finally(() => prisma.$disconnect());
