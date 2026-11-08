-- CreateEnum
CREATE TYPE "AffLogStatus" AS ENUM ('PENDING', 'SETTLED', 'CANCELED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "affCredit" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AffLog" ADD COLUMN "status" "AffLogStatus" NOT NULL DEFAULT 'SETTLED',
ADD COLUMN "effectiveAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "AffLog_status_effectiveAt_idx" ON "AffLog"("status", "effectiveAt");
