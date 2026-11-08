-- 交易市场：拨测完成后才公开商品（已有商品视为已公开）
ALTER TABLE "MarketListing" ADD COLUMN "published" BOOLEAN NOT NULL DEFAULT true;
