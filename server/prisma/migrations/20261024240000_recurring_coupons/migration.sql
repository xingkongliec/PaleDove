-- AlterTable
ALTER TABLE "Instance" ADD COLUMN "couponId" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "couponId" INTEGER;

-- 已有使用记录的订单补上优惠码 ID
UPDATE "Order" o SET "couponId" = u."couponId" FROM "CouponUsage" u WHERE u."orderId" = o."id";

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
