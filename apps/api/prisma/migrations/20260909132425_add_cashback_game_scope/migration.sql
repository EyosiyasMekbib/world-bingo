-- AlterTable
ALTER TABLE "cashback_promotions" ADD COLUMN     "providerGameKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "templateIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

