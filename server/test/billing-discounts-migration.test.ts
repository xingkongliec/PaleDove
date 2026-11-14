import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

describe('billing discount source migration', () => {
  it('uses historical offer snapshots, preserves amounts, and keeps attribution after offers are removed', async () => {
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE "Order" (id INTEGER PRIMARY KEY, instanceId INTEGER, type TEXT, amount DECIMAL, discount DECIMAL, couponCode TEXT, couponId INTEGER, discountSource TEXT, createdAt INTEGER);
        CREATE TABLE "Invoice" (id INTEGER PRIMARY KEY, instanceId INTEGER, type TEXT, amount DECIMAL, discount DECIMAL, discountSource TEXT, payload TEXT, createdAt INTEGER);
        CREATE TABLE "NightMarketOffer" (id INTEGER PRIMARY KEY, orderId INTEGER, snapshot TEXT);
        INSERT INTO "Order" VALUES
          (1, 10, 'NEW', 12.6, 7.4, NULL, NULL, NULL, 100),
          (2, 10, 'RENEW', 25.2, 14.8, NULL, NULL, NULL, 200),
          (3, 10, 'RENEW', 15, 5, 'SAVE5', 1, NULL, 300),
          (4, 20, 'NEW', 18, 2, NULL, NULL, NULL, 100),
          (5, 20, 'RENEW', 18, 2, NULL, NULL, NULL, 200),
          (6, 30, 'RENEW', 18, 2, NULL, NULL, NULL, 200),
          (7, 10, 'RENEW', 18, 2, NULL, NULL, NULL, 50);
        INSERT INTO "NightMarketOffer" VALUES (1, 1, '{"discountMode":"RECURRING"}'), (2, 4, '{"discountMode":"ONCE"}');
        INSERT INTO "Invoice" VALUES
          (1, 10, 'PURCHASE', 12.6, 7.4, NULL, '{"nightMarket":{"name":"Historical prize"},"passwordEnc":"keep-secret"}', 100),
          (2, 10, 'RENEW', 12.6, 7.4, NULL, '{"periods":1,"couponCode":null}', 200),
          (3, 10, 'RENEW', 15, 5, NULL, '{"couponCode":"SAVE5"}', 300),
          (4, 20, 'RENEW', 18, 2, NULL, '{}', 200),
          (5, 30, 'RENEW', 18, 2, NULL, '{}', 200),
          (6, 10, 'RENEW', 18, 2, NULL, '{}', 50);
      `);
      const orders = db.prepare('SELECT id, amount, discount FROM "Order" ORDER BY id').all();
      const invoices = db.prepare('SELECT id, amount, discount, payload FROM "Invoice" ORDER BY id').all();
      const { backfillBillingDiscounts } = await import('../scripts/billing-discounts.mjs');
      backfillBillingDiscounts(db);
      const sources = (table: string) => db.prepare(`SELECT discountSource FROM "${table}" ORDER BY id`).all().map((r: { discountSource: string }) => r.discountSource);
      expect(sources('Order')).toEqual(['NIGHT_MARKET', 'NIGHT_MARKET', 'COUPON', 'NIGHT_MARKET', null, null, null]);
      expect(sources('Invoice')).toEqual(['NIGHT_MARKET', 'NIGHT_MARKET', 'COUPON', null, null, null]);
      db.exec('DELETE FROM "NightMarketOffer"');
      backfillBillingDiscounts(db);
      expect(sources('Order')).toEqual(['NIGHT_MARKET', 'NIGHT_MARKET', 'COUPON', 'NIGHT_MARKET', null, null, null]);
      expect(sources('Invoice')).toEqual(['NIGHT_MARKET', 'NIGHT_MARKET', 'COUPON', null, null, null]);
      expect(db.prepare('SELECT id, amount, discount FROM "Order" ORDER BY id').all()).toEqual(orders);
      expect(db.prepare('SELECT id, amount, discount, payload FROM "Invoice" ORDER BY id').all()).toEqual(invoices);
    } finally { db.close(); }
  });
});
