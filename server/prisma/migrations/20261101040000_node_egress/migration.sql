-- 智能分流：宿主机出口（WireGuard / SOCKS5 / HTTP）与实例选择的出口
CREATE TYPE "EgressType" AS ENUM ('WIREGUARD', 'SOCKS5', 'HTTP');

ALTER TABLE "Node" ADD COLUMN "egressEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "NodeEgress" (
    "id" SERIAL NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EgressType" NOT NULL,
    "configEnc" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeEgress_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NodeEgress_nodeId_idx" ON "NodeEgress"("nodeId");
ALTER TABLE "NodeEgress" ADD CONSTRAINT "NodeEgress_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Instance" ADD COLUMN "egressId" INTEGER;
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_egressId_fkey" FOREIGN KEY ("egressId") REFERENCES "NodeEgress"("id") ON DELETE SET NULL ON UPDATE CASCADE;
