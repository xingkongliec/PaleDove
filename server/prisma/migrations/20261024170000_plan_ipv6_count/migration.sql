-- 套餐可配置分配的公网 IPv6 数量（0 表示不分配）；实例的 publicIpv6 可保存多个地址（逗号分隔）

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN "ipv6Count" INTEGER NOT NULL DEFAULT 0;

-- 已有套餐保持原行为：所属产品绑定了 IPv6 模式宿主机的，分配 1 个
UPDATE "Plan" SET "ipv6Count" = 1
WHERE EXISTS (
  SELECT 1 FROM "_NodeToProduct" np JOIN "Node" n ON n."id" = np."A"
  WHERE np."B" = "Plan"."productId" AND n."networkMode" IN ('NAT_IPV6', 'IPV6_ONLY', 'IPV4_IPV6')
);
