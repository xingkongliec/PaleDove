-- AlterEnum
ALTER TYPE "BalanceLogType" ADD VALUE 'MARKET';

-- CreateEnum
CREATE TYPE "MarketListingStatus" AS ENUM ('ACTIVE', 'SOLD', 'CANCELED', 'REMOVED');

-- CreateTable
CREATE TABLE "MarketListing" (
    "id" SERIAL NOT NULL,
    "instanceId" INTEGER NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "planId" INTEGER,
    "price" DECIMAL(10,2) NOT NULL,
    "mode" "TransferMode" NOT NULL DEFAULT 'KEEP',
    "targetUserId" INTEGER,
    "remark" TEXT,
    "status" "MarketListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "buyerId" INTEGER,
    "fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "soldAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketListing_status_createdAt_idx" ON "MarketListing"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketListing_instanceId_status_idx" ON "MarketListing"("instanceId", "status");

-- CreateIndex
CREATE INDEX "MarketListing_planId_status_soldAt_idx" ON "MarketListing"("planId", "status", "soldAt");

-- CreateIndex
CREATE INDEX "MarketListing_sellerId_status_idx" ON "MarketListing"("sellerId", "status");

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketListing" ADD CONSTRAINT "MarketListing_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
