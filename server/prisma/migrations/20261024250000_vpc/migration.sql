-- CreateTable
CREATE TABLE "Vpc" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vpc_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN "vpcId" INTEGER,
ADD COLUMN "vpcIp" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Vpc_network_key" ON "Vpc"("network");

-- CreateIndex
CREATE INDEX "Vpc_userId_idx" ON "Vpc"("userId");

-- AddForeignKey
ALTER TABLE "Vpc" ADD CONSTRAINT "Vpc_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vpc" ADD CONSTRAINT "Vpc_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_vpcId_fkey" FOREIGN KEY ("vpcId") REFERENCES "Vpc"("id") ON DELETE SET NULL ON UPDATE CASCADE;
