-- AlterTable
ALTER TABLE "games" ADD COLUMN     "templateId" TEXT;

-- CreateTable
CREATE TABLE "game_templates" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ticketPrice" DECIMAL(10,2) NOT NULL,
    "maxPlayers" INTEGER NOT NULL,
    "minPlayers" INTEGER NOT NULL DEFAULT 2,
    "houseEdgePct" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "pattern" "PatternType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "countdownSecs" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "games_templateId_status_idx" ON "games"("templateId", "status");

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "game_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
