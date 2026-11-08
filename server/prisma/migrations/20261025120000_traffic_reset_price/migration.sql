-- AlterEnum
ALTER TYPE "BalanceLogType" ADD VALUE 'TRAFFIC';

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN "trafficResetPrice" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN "trafficResetPrice" DECIMAL(10,2);
