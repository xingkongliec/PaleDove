CREATE TYPE "InvoiceType" AS ENUM ('PURCHASE', 'RENEW', 'TRAFFIC_RESET');

CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'CANCELED', 'EXPIRED');

CREATE TABLE "Invoice" (
    "id" SERIAL NOT NULL,
    "no" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" "InvoiceType" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "instanceId" INTEGER,
    "planId" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invoice_no_key" ON "Invoice"("no");
CREATE INDEX "Invoice_userId_status_createdAt_idx" ON "Invoice"("userId", "status", "createdAt");
CREATE INDEX "Invoice_instanceId_status_idx" ON "Invoice"("instanceId", "status");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_instanceId_fkey"
  FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
