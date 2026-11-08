-- AlterEnum
ALTER TYPE "InstanceStatus" ADD VALUE 'MIGRATING';

-- AlterEnum
ALTER TYPE "TaskType" ADD VALUE 'MIGRATE';

-- CreateEnum
CREATE TYPE "NetworkMode" AS ENUM ('NAT', 'NAT_IPV6', 'IPV6_ONLY', 'IPV4', 'IPV4_IPV6');

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "country" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "networkMode" "NetworkMode" NOT NULL DEFAULT 'NAT',
ADD COLUMN     "publicIpv6" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "natListenAddressV6" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "ipv6Subnet" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "ipv6Parent" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "trafficLimit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trafficResetDay" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "trafficMode" "TrafficMode" NOT NULL DEFAULT 'BOTH',
ADD COLUMN     "agentTokenHash" TEXT,
ALTER COLUMN "natListenAddress" SET DEFAULT '';

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN     "publicIpv6" TEXT;

-- CreateTable
CREATE TABLE "Volume" (
    "id" SERIAL NOT NULL,
    "instanceId" INTEGER NOT NULL,
    "pool" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Volume_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Volume_instanceId_idx" ON "Volume"("instanceId");

-- AddForeignKey
ALTER TABLE "Volume" ADD CONSTRAINT "Volume_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_userId_readAt_idx" ON "Message"("userId", "readAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: 安装 / 上报 / Caddy 令牌加密保存，查看安装命令时沿用
ALTER TABLE "Node" ADD COLUMN "installTokenEnc" TEXT,
ADD COLUMN "agentTokenEnc" TEXT,
ADD COLUMN "caddyTokenEnc" TEXT;

-- AlterTable: 昵称、国家或地区、外观、两步验证
ALTER TABLE "User" ADD COLUMN "name" TEXT,
ADD COLUMN "country" TEXT,
ADD COLUMN "theme" TEXT,
ADD COLUMN "totpSecretEnc" TEXT,
ADD COLUMN "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN "totpLastStep" INTEGER,
ADD COLUMN "recoveryCodes" TEXT NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "OAuthAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccount_provider_providerId_key" ON "OAuthAccount"("provider", "providerId");

-- CreateIndex
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount"("userId");

-- AddForeignKey
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "RealNameVerification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "realNameEnc" TEXT NOT NULL,
    "idNumberEnc" TEXT NOT NULL,
    "nameMasked" TEXT NOT NULL,
    "idNumberMasked" TEXT NOT NULL,
    "idNumberHash" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "certifyId" TEXT,
    "reason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewerId" INTEGER,

    CONSTRAINT "RealNameVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RealNameVerification_userId_key" ON "RealNameVerification"("userId");

-- CreateIndex
CREATE INDEX "RealNameVerification_status_idx" ON "RealNameVerification"("status");

-- CreateIndex
CREATE INDEX "RealNameVerification_idNumberHash_idx" ON "RealNameVerification"("idNumberHash");

-- AddForeignKey
ALTER TABLE "RealNameVerification" ADD CONSTRAINT "RealNameVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
