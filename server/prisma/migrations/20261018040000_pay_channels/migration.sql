-- 支付渠道：订单记录所属渠道与手续费
ALTER TABLE "Payment" ADD COLUMN "channelId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "fee" DECIMAL(12,2) NOT NULL DEFAULT 0;
