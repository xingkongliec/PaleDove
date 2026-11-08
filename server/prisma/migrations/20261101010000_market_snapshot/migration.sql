-- 交易市场成交记录：成交时的实例信息快照
ALTER TABLE "MarketListing" ADD COLUMN "snapshot" JSONB;
