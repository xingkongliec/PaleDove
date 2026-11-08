-- CreateEnum
CREATE TYPE "CaddyStatus" AS ENUM ('NONE', 'PENDING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'FAILED');

-- AlterEnum
ALTER TYPE "NodeStatus" ADD VALUE 'PENDING';

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN     "storagePool" TEXT;

-- AlterTable
ALTER TABLE "Node" DROP COLUMN "gatewayError",
DROP COLUMN "gatewayImage",
DROP COLUMN "gatewayIp",
DROP COLUMN "gatewayName",
DROP COLUMN "gatewayStatus",
ADD COLUMN     "apiPort" INTEGER NOT NULL DEFAULT 8443,
ADD COLUMN     "caddyAdminPort" INTEGER NOT NULL DEFAULT 2021,
ADD COLUMN     "caddyCaCert" TEXT,
ADD COLUMN     "caddyError" TEXT,
ADD COLUMN     "caddyStatus" "CaddyStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "caddyTokenExpires" TIMESTAMP(3),
ADD COLUMN     "caddyTokenHash" TEXT,
ADD COLUMN     "caddyVersion" TEXT,
ADD COLUMN     "incusVersion" TEXT,
ADD COLUMN     "installTokenExpires" TIMESTAMP(3),
ADD COLUMN     "installTokenHash" TEXT,
ADD COLUMN     "installedAt" TIMESTAMP(3),
ADD COLUMN     "natCidrInstall" TEXT NOT NULL DEFAULT '10.88.0.1/16',
ADD COLUMN     "storageDriver" TEXT NOT NULL DEFAULT 'btrfs',
ADD COLUMN     "storageSize" TEXT NOT NULL DEFAULT '100GiB',
ADD COLUMN     "storageSource" TEXT,
ALTER COLUMN "endpoint" SET DEFAULT '',
ALTER COLUMN "publicIp" SET DEFAULT '';

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "storagePool" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "locale" TEXT;

-- DropEnum
DROP TYPE "GatewayStatus";

-- CreateTable
CREATE TABLE "ProxySite" (
    "id" SERIAL NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "domain" TEXT NOT NULL,
    "upstream" TEXT NOT NULL,
    "https" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT,
    "status" "SiteStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxySite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "no" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "gateway" TEXT NOT NULL,
    "channel" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "payAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "payUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProxySite_domain_key" ON "ProxySite"("domain");

-- CreateIndex
CREATE INDEX "ProxySite_nodeId_idx" ON "ProxySite"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_no_key" ON "Payment"("no");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Node_installTokenHash_key" ON "Node"("installTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Node_caddyTokenHash_key" ON "Node"("caddyTokenHash");

-- AddForeignKey
ALTER TABLE "ProxySite" ADD CONSTRAINT "ProxySite_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

