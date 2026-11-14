CREATE TABLE "NightMarketPeriod" (
    "id" SERIAL NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "refreshAt" TIMESTAMP(3) NOT NULL,
    "currentAct" INTEGER NOT NULL,
    "catalog" JSONB NOT NULL,
    CONSTRAINT "NightMarketPeriod_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "NightMarketPool" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "periodId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NightMarketPool_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "NightMarketOffer" (
    "id" SERIAL NOT NULL,
    "poolId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "discountPercent" INTEGER NOT NULL,
    "originalPrice" DECIMAL(10,2) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "revealedAt" TIMESTAMP(3),
    "purchasedAt" TIMESTAMP(3),
    "invoiceId" INTEGER,
    "orderId" INTEGER,
    CONSTRAINT "NightMarketOffer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NightMarketPeriod_startsAt_key" ON "NightMarketPeriod"("startsAt");
CREATE UNIQUE INDEX "NightMarketPool_userId_periodId_key" ON "NightMarketPool"("userId", "periodId");
CREATE UNIQUE INDEX "NightMarketOffer_invoiceId_key" ON "NightMarketOffer"("invoiceId");
CREATE UNIQUE INDEX "NightMarketOffer_orderId_key" ON "NightMarketOffer"("orderId");
CREATE UNIQUE INDEX "NightMarketOffer_poolId_position_key" ON "NightMarketOffer"("poolId", "position");
ALTER TABLE "NightMarketPool" ADD CONSTRAINT "NightMarketPool_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NightMarketPool" ADD CONSTRAINT "NightMarketPool_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "NightMarketPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NightMarketOffer" ADD CONSTRAINT "NightMarketOffer_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "NightMarketPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NightMarketOffer" ADD CONSTRAINT "NightMarketOffer_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NightMarketOffer" ADD CONSTRAINT "NightMarketOffer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
