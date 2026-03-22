-- AlterTable
ALTER TABLE "game_templates" ADD COLUMN     "botCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "botEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "botFillToMin" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
