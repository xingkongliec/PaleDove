ALTER TABLE "Order" ADD COLUMN "discountSource" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "discountSource" TEXT;
CREATE INDEX "Invoice_status_createdAt_idx" ON "Invoice"("status", "createdAt");

UPDATE "Order" SET "discountSource" = 'COUPON'
WHERE "discountSource" IS NULL AND "discount" > 0 AND ("couponCode" IS NOT NULL OR "couponId" IS NOT NULL);
UPDATE "Order" SET "discountSource" = 'NIGHT_MARKET'
WHERE EXISTS (SELECT 1 FROM "NightMarketOffer" n WHERE n."orderId" = "Order"."id");

-- 只依据已成交夜市奖品的循环优惠快照补充旧续费来源。
UPDATE "Order" r SET "discountSource" = 'NIGHT_MARKET'
WHERE r."type" = 'RENEW' AND r."discount" > 0 AND r."discountSource" IS NULL
AND EXISTS (
  SELECT 1 FROM "NightMarketOffer" n JOIN "Order" o ON o."id" = n."orderId"
  WHERE o."instanceId" = r."instanceId" AND o."createdAt" <= r."createdAt"
    AND n."snapshot"->>'discountMode' = 'RECURRING'
);

UPDATE "Invoice" SET "discountSource" = CASE
  WHEN "payload"->>'discountSource' IN ('COUPON', 'NIGHT_MARKET') THEN "payload"->>'discountSource'
  WHEN "payload"->'nightMarket' IS NOT NULL AND "payload"->'nightMarket' <> 'null'::jsonb THEN 'NIGHT_MARKET'
  WHEN COALESCE("payload"->>'appliedCouponCode', "payload"->>'couponCode', '') <> '' THEN 'COUPON'
END WHERE "discountSource" IS NULL;
UPDATE "Invoice" i SET "discountSource" = 'NIGHT_MARKET'
WHERE i."type" = 'RENEW' AND i."discount" > 0 AND i."discountSource" IS NULL
AND EXISTS (
  SELECT 1 FROM "NightMarketOffer" n JOIN "Order" o ON o."id" = n."orderId"
  WHERE o."instanceId" = i."instanceId" AND o."createdAt" <= i."createdAt"
    AND n."snapshot"->>'discountMode' = 'RECURRING'
);
