-- 实例转移（过户）记录
CREATE TYPE "TransferMode" AS ENUM ('KEEP', 'REINSTALL');

CREATE TABLE "InstanceTransfer" (
    "id" SERIAL NOT NULL,
    "instanceId" INTEGER NOT NULL,
    "hostname" TEXT NOT NULL,
    "fromUserId" INTEGER NOT NULL,
    "toUserId" INTEGER NOT NULL,
    "mode" "TransferMode" NOT NULL,
    "byAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstanceTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InstanceTransfer_fromUserId_idx" ON "InstanceTransfer"("fromUserId");
CREATE INDEX "InstanceTransfer_toUserId_idx" ON "InstanceTransfer"("toUserId");
CREATE INDEX "InstanceTransfer_instanceId_idx" ON "InstanceTransfer"("instanceId");

ALTER TABLE "InstanceTransfer" ADD CONSTRAINT "InstanceTransfer_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstanceTransfer" ADD CONSTRAINT "InstanceTransfer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstanceTransfer" ADD CONSTRAINT "InstanceTransfer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
