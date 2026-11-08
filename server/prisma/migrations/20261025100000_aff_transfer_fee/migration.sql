-- AlterEnum
ALTER TYPE "BalanceLogType" ADD VALUE 'AFF';
ALTER TYPE "BalanceLogType" ADD VALUE 'TRANSFER';

-- CreateEnum
CREATE TYPE "AffLogType" AS ENUM ('EARN', 'REVOKE', 'WITHDRAW');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "affCode" TEXT,
ADD COLUMN "referrerId" INTEGER,
ADD COLUMN "affBalance" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "InstanceTransfer" ADD COLUMN "remark" TEXT,
ADD COLUMN "fee" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AffLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "AffLogType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "inviteeId" INTEGER,
    "orderId" INTEGER,
    "orderAmount" DECIMAL(10,2),
    "rate" DECIMAL(5,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AffLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_affCode_key" ON "User"("affCode");

-- CreateIndex
CREATE INDEX "AffLog_userId_createdAt_idx" ON "AffLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AffLog_orderId_idx" ON "AffLog"("orderId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffLog" ADD CONSTRAINT "AffLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffLog" ADD CONSTRAINT "AffLog_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffLog" ADD CONSTRAINT "AffLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
