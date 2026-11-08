-- 产品：特权容器 / 嵌套与按宿主机的存储池、流量倍率；实例记录开通时的容器安全选项

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "privileged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "nesting" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "nodeOptions" JSONB;

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN "privileged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "nesting" BOOLEAN NOT NULL DEFAULT true;
