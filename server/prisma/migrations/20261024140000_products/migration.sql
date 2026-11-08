-- 产品：套餐的上级分类，宿主机从套餐改为绑定在产品上

-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tags" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_NodeToProduct" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_NodeToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_NodeToProduct_B_index" ON "_NodeToProduct"("B");

-- AddForeignKey
ALTER TABLE "_NodeToProduct" ADD CONSTRAINT "_NodeToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_NodeToProduct" ADD CONSTRAINT "_NodeToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 已有套餐：每个套餐生成一个同名产品（沿用套餐 id），继承原来绑定的宿主机
ALTER TABLE "Plan" ADD COLUMN "productId" INTEGER;
INSERT INTO "Product" ("id", "name", "enabled", "sortOrder", "updatedAt")
SELECT "id", "name", "enabled", "sortOrder", CURRENT_TIMESTAMP FROM "Plan";
SELECT setval(pg_get_serial_sequence('"Product"', 'id'), COALESCE((SELECT MAX("id") FROM "Product"), 0) + 1, false);
UPDATE "Plan" SET "productId" = "id";
INSERT INTO "_NodeToProduct" ("A", "B") SELECT "A", "B" FROM "_NodeToPlan";
ALTER TABLE "Plan" ALTER COLUMN "productId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Plan_productId_idx" ON "Plan"("productId");

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropTable
DROP TABLE "_NodeToPlan";
