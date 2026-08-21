-- AlterTable
ALTER TABLE "bonus_rules" ADD COLUMN     "isSegmentScoped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "memberCount" INTEGER,
ADD COLUMN     "segmentId" TEXT,
ADD COLUMN     "segmentName" TEXT;

-- CreateTable
CREATE TABLE "bonus_rule_members" (
    "ruleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "bonus_rule_members_pkey" PRIMARY KEY ("ruleId","userId")
);

-- AddForeignKey
ALTER TABLE "bonus_rules" ADD CONSTRAINT "bonus_rules_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_rule_members" ADD CONSTRAINT "bonus_rule_members_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "bonus_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bonus_rule_members" ADD CONSTRAINT "bonus_rule_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
