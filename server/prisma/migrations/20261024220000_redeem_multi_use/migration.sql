-- AlterTable
ALTER TABLE "RedeemCode" ADD COLUMN "maxUses" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "usedCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RedeemUsage" (
    "id" SERIAL NOT NULL,
    "codeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedeemUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RedeemUsage_codeId_userId_key" ON "RedeemUsage"("codeId", "userId");

-- CreateIndex
CREATE INDEX "RedeemUsage_userId_idx" ON "RedeemUsage"("userId");

-- AddForeignKey
ALTER TABLE "RedeemUsage" ADD CONSTRAINT "RedeemUsage_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "RedeemCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedeemUsage" ADD CONSTRAINT "RedeemUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 已使用的兑换码：记为兑换 1 次，并补上兑换记录
UPDATE "RedeemCode" SET "usedCount" = 1 WHERE "usedById" IS NOT NULL;
INSERT INTO "RedeemUsage" ("codeId", "userId", "createdAt")
SELECT "id", "usedById", COALESCE("usedAt", CURRENT_TIMESTAMP) FROM "RedeemCode" WHERE "usedById" IS NOT NULL;
