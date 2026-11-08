-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('ONLINE', 'OFFLINE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PublicNicMode" AS ENUM ('ROUTED', 'BRIDGED');

-- CreateEnum
CREATE TYPE "GatewayStatus" AS ENUM ('NONE', 'DEPLOYING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "InstanceType" AS ENUM ('LXC_NAT', 'KVM_NAT', 'KVM_IPV4');

-- CreateEnum
CREATE TYPE "TrafficMode" AS ENUM ('OUT', 'IN', 'BOTH', 'MAX');

-- CreateEnum
CREATE TYPE "OverLimitAction" AS ENUM ('STOP', 'THROTTLE');

-- CreateEnum
CREATE TYPE "InstanceStatus" AS ENUM ('CREATING', 'RUNNING', 'STOPPED', 'REINSTALLING', 'SUSPENDED', 'ERROR', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "SuspendReason" AS ENUM ('EXPIRED', 'TRAFFIC', 'ADMIN');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL');

-- CreateEnum
CREATE TYPE "PortProtocol" AS ENUM ('TCP', 'UDP', 'TCP_UDP');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('PENDING', 'ACTIVE', 'ERROR');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('CREATE', 'START', 'STOP', 'RESTART', 'FORCE_STOP', 'REINSTALL', 'RESET_PASSWORD', 'SNAPSHOT_CREATE', 'SNAPSHOT_RESTORE', 'SNAPSHOT_DELETE', 'SUSPEND', 'UNSUSPEND', 'APPLY_LIMITS', 'DELETE');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('NEW', 'RENEW');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "BalanceLogType" AS ENUM ('RECHARGE', 'REDEEM', 'PURCHASE', 'RENEW', 'REFUND', 'ADJUST');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "remark" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Node" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "serverFingerprint" TEXT,
    "project" TEXT NOT NULL DEFAULT 'default',
    "storagePool" TEXT NOT NULL DEFAULT 'default',
    "profile" TEXT NOT NULL DEFAULT 'default',
    "publicIp" TEXT NOT NULL,
    "natNetwork" TEXT NOT NULL DEFAULT 'incusbr0',
    "natCidr" TEXT,
    "natListenAddress" TEXT NOT NULL DEFAULT '0.0.0.0',
    "portRangeStart" INTEGER NOT NULL DEFAULT 20000,
    "portRangeEnd" INTEGER NOT NULL DEFAULT 60000,
    "publicNicMode" "PublicNicMode" NOT NULL DEFAULT 'ROUTED',
    "publicNicParent" TEXT,
    "dnsServers" TEXT NOT NULL DEFAULT '1.1.1.1,8.8.8.8',
    "gatewayName" TEXT NOT NULL DEFAULT 'inculark-gateway',
    "gatewayImage" TEXT NOT NULL DEFAULT 'alpine/3.22',
    "gatewayIp" TEXT,
    "gatewayStatus" "GatewayStatus" NOT NULL DEFAULT 'NONE',
    "gatewayError" TEXT,
    "maxInstances" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "NodeStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IpAddress" (
    "id" SERIAL NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "prefix" INTEGER NOT NULL DEFAULT 32,
    "gateway" TEXT,
    "instanceId" INTEGER,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IpAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Image" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "family" TEXT NOT NULL DEFAULT 'linux',
    "alias" TEXT NOT NULL,
    "server" TEXT NOT NULL DEFAULT 'https://images.linuxcontainers.org',
    "protocol" TEXT NOT NULL DEFAULT 'simplestreams',
    "forContainer" BOOLEAN NOT NULL DEFAULT true,
    "forVm" BOOLEAN NOT NULL DEFAULT true,
    "cloudInit" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "InstanceType" NOT NULL,
    "cpu" INTEGER NOT NULL,
    "cpuAllowance" INTEGER,
    "memory" INTEGER NOT NULL,
    "disk" INTEGER NOT NULL,
    "bandwidthIn" INTEGER NOT NULL,
    "bandwidthOut" INTEGER NOT NULL,
    "traffic" INTEGER NOT NULL DEFAULT 0,
    "trafficMode" "TrafficMode" NOT NULL DEFAULT 'OUT',
    "overLimitAction" "OverLimitAction" NOT NULL DEFAULT 'THROTTLE',
    "throttleRate" INTEGER NOT NULL DEFAULT 1,
    "portLimit" INTEGER NOT NULL DEFAULT 10,
    "siteLimit" INTEGER NOT NULL DEFAULT 0,
    "snapshotLimit" INTEGER NOT NULL DEFAULT 1,
    "priceMonthly" DECIMAL(10,2),
    "priceQuarterly" DECIMAL(10,2),
    "priceSemiannual" DECIMAL(10,2),
    "priceAnnual" DECIMAL(10,2),
    "stock" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instance" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "planId" INTEGER,
    "nodeId" INTEGER NOT NULL,
    "imageId" INTEGER,
    "type" "InstanceType" NOT NULL,
    "status" "InstanceStatus" NOT NULL DEFAULT 'CREATING',
    "suspendReason" "SuspendReason",
    "cpu" INTEGER NOT NULL,
    "cpuAllowance" INTEGER,
    "memory" INTEGER NOT NULL,
    "disk" INTEGER NOT NULL,
    "bandwidthIn" INTEGER NOT NULL,
    "bandwidthOut" INTEGER NOT NULL,
    "traffic" INTEGER NOT NULL,
    "trafficMode" "TrafficMode" NOT NULL,
    "overLimitAction" "OverLimitAction" NOT NULL,
    "throttleRate" INTEGER NOT NULL,
    "portLimit" INTEGER NOT NULL,
    "siteLimit" INTEGER NOT NULL,
    "snapshotLimit" INTEGER NOT NULL,
    "privateIp" TEXT,
    "ipv6" TEXT,
    "macAddress" TEXT,
    "sshPort" INTEGER,
    "rootPassword" TEXT,
    "trafficIn" BIGINT NOT NULL DEFAULT 0,
    "trafficOut" BIGINT NOT NULL DEFAULT 0,
    "trafficThrottled" BOOLEAN NOT NULL DEFAULT false,
    "lastRxCounter" BIGINT NOT NULL DEFAULT 0,
    "lastTxCounter" BIGINT NOT NULL DEFAULT 0,
    "trafficAnchorDay" INTEGER NOT NULL,
    "trafficResetAt" TIMESTAMP(3) NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "remark" TEXT,
    "lastError" TEXT,
    "provisionedAt" TIMESTAMP(3),
    "lastReinstallAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortMapping" (
    "id" SERIAL NOT NULL,
    "instanceId" INTEGER NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "protocol" "PortProtocol" NOT NULL DEFAULT 'TCP_UDP',
    "publicPort" INTEGER NOT NULL,
    "privatePort" INTEGER NOT NULL,
    "description" TEXT,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteBinding" (
    "id" SERIAL NOT NULL,
    "instanceId" INTEGER NOT NULL,
    "domain" TEXT NOT NULL,
    "targetPort" INTEGER NOT NULL DEFAULT 80,
    "https" BOOLEAN NOT NULL DEFAULT true,
    "status" "SiteStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" SERIAL NOT NULL,
    "instanceId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrafficDaily" (
    "instanceId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "rx" BIGINT NOT NULL DEFAULT 0,
    "tx" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "TrafficDaily_pkey" PRIMARY KEY ("instanceId","date")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" SERIAL NOT NULL,
    "instanceId" INTEGER,
    "userId" INTEGER,
    "type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "no" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "instanceId" INTEGER,
    "planId" INTEGER,
    "type" "OrderType" NOT NULL,
    "cycle" "BillingCycle" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PAID',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "BalanceLogType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedeemCode" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "usedById" INTEGER,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedeemCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_NodeToPlan" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_NodeToPlan_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "IpAddress_address_key" ON "IpAddress"("address");

-- CreateIndex
CREATE UNIQUE INDEX "IpAddress_instanceId_key" ON "IpAddress"("instanceId");

-- CreateIndex
CREATE INDEX "IpAddress_nodeId_idx" ON "IpAddress"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Instance_name_key" ON "Instance"("name");

-- CreateIndex
CREATE INDEX "Instance_userId_idx" ON "Instance"("userId");

-- CreateIndex
CREATE INDEX "Instance_status_idx" ON "Instance"("status");

-- CreateIndex
CREATE INDEX "Instance_expiresAt_idx" ON "Instance"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Instance_nodeId_privateIp_key" ON "Instance"("nodeId", "privateIp");

-- CreateIndex
CREATE INDEX "PortMapping_instanceId_idx" ON "PortMapping"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "PortMapping_nodeId_publicPort_key" ON "PortMapping"("nodeId", "publicPort");

-- CreateIndex
CREATE UNIQUE INDEX "SiteBinding_domain_key" ON "SiteBinding"("domain");

-- CreateIndex
CREATE INDEX "SiteBinding_instanceId_idx" ON "SiteBinding"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "Snapshot_instanceId_name_key" ON "Snapshot"("instanceId", "name");

-- CreateIndex
CREATE INDEX "Task_instanceId_createdAt_idx" ON "Task"("instanceId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_no_key" ON "Order"("no");

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BalanceLog_userId_createdAt_idx" ON "BalanceLog"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RedeemCode_code_key" ON "RedeemCode"("code");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_createdAt_idx" ON "ActivityLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "_NodeToPlan_B_index" ON "_NodeToPlan"("B");

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IpAddress" ADD CONSTRAINT "IpAddress_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortMapping" ADD CONSTRAINT "PortMapping_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteBinding" ADD CONSTRAINT "SiteBinding_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrafficDaily" ADD CONSTRAINT "TrafficDaily_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceLog" ADD CONSTRAINT "BalanceLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedeemCode" ADD CONSTRAINT "RedeemCode_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_NodeToPlan" ADD CONSTRAINT "_NodeToPlan_A_fkey" FOREIGN KEY ("A") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_NodeToPlan" ADD CONSTRAINT "_NodeToPlan_B_fkey" FOREIGN KEY ("B") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
