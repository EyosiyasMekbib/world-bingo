-- CreateTable
CREATE TABLE "jackpot" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lastWonAt" TIMESTAMP(3),
    "lastWonBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jackpot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jackpot_wins" (
    "id" TEXT NOT NULL,
    "jackpotId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "ballCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jackpot_wins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jackpot_wins_userId_idx" ON "jackpot_wins"("userId");

-- AddForeignKey
ALTER TABLE "jackpot_wins" ADD CONSTRAINT "jackpot_wins_jackpotId_fkey" FOREIGN KEY ("jackpotId") REFERENCES "jackpot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
