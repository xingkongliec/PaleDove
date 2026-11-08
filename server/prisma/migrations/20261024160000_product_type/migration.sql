-- 实例类型从套餐移到产品：产品下的所有套餐都使用产品的类型

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "type" "InstanceType" NOT NULL DEFAULT 'LXC_NAT';

-- 已有产品取其下第一个套餐的类型，并让其余套餐与之一致
UPDATE "Product" SET "type" = (SELECT "type" FROM "Plan" WHERE "Plan"."productId" = "Product"."id" ORDER BY "Plan"."id" LIMIT 1)
WHERE EXISTS (SELECT 1 FROM "Plan" WHERE "Plan"."productId" = "Product"."id");
UPDATE "Plan" SET "type" = "Product"."type" FROM "Product" WHERE "Plan"."productId" = "Product"."id";
