-- 交易市场：上架前拨测快照
ALTER TABLE "MarketListing" ADD COLUMN "ping" JSONB;
