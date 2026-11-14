/** SQLite 升级与 PostgreSQL migration 使用相同的历史优惠来源判定。 */
export function backfillBillingDiscounts(db) {
  db.transaction(() => {
    db.exec(`
      UPDATE "Order" SET "discountSource" = 'COUPON'
      WHERE "discountSource" IS NULL AND "discount" > 0 AND ("couponCode" IS NOT NULL OR "couponId" IS NOT NULL);
      UPDATE "Order" SET "discountSource" = 'NIGHT_MARKET'
      WHERE EXISTS (SELECT 1 FROM "NightMarketOffer" n WHERE n."orderId" = "Order"."id");
      UPDATE "Order" SET "discountSource" = 'NIGHT_MARKET'
      WHERE "type" = 'RENEW' AND "discount" > 0 AND "discountSource" IS NULL
      AND EXISTS (
        SELECT 1 FROM "NightMarketOffer" n JOIN "Order" o ON o."id" = n."orderId"
        WHERE o."instanceId" = "Order"."instanceId" AND o."createdAt" <= "Order"."createdAt"
          AND json_extract(n."snapshot", '$.discountMode') = 'RECURRING'
      );
      UPDATE "Invoice" SET "discountSource" = CASE
        WHEN json_extract("payload", '$.discountSource') IN ('COUPON', 'NIGHT_MARKET') THEN json_extract("payload", '$.discountSource')
        WHEN json_type("payload", '$.nightMarket') = 'object' THEN 'NIGHT_MARKET'
        WHEN COALESCE(json_extract("payload", '$.appliedCouponCode'), json_extract("payload", '$.couponCode'), '') <> '' THEN 'COUPON'
      END WHERE "discountSource" IS NULL;
      UPDATE "Invoice" SET "discountSource" = 'NIGHT_MARKET'
      WHERE "type" = 'RENEW' AND "discount" > 0 AND "discountSource" IS NULL
      AND EXISTS (
        SELECT 1 FROM "NightMarketOffer" n JOIN "Order" o ON o."id" = n."orderId"
        WHERE o."instanceId" = "Invoice"."instanceId" AND o."createdAt" <= "Invoice"."createdAt"
          AND json_extract(n."snapshot", '$.discountMode') = 'RECURRING'
      );
    `);
  })();
}
