ALTER TABLE "Ticket" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'other';
ALTER TABLE "Ticket" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "Ticket" ADD COLUMN "resourceRef" INTEGER;
ALTER TABLE "Ticket" ADD COLUMN "resourceName" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "lastReplyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Ticket" ADD COLUMN "closedAt" TIMESTAMP(3);
UPDATE "Ticket" SET "lastReplyAt" = "updatedAt", "closedAt" = CASE WHEN "status" = 'CLOSED' THEN "updatedAt" END;
ALTER TABLE "TicketMessage" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
UPDATE "TicketMessage" m SET "isAdmin" = true FROM "User" u WHERE m."authorId" = u."id" AND u."role" = 'ADMIN';
UPDATE "Ticket" t SET "status" = 'REPLIED' WHERE t."status" = 'OPEN' AND (SELECT m."isAdmin" FROM "TicketMessage" m WHERE m."ticketId" = t."id" ORDER BY m."id" DESC LIMIT 1) = true;
CREATE INDEX "Ticket_status_lastReplyAt_idx" ON "Ticket"("status", "lastReplyAt");
CREATE TABLE "TicketAttachment" (
  "id" SERIAL NOT NULL,
  "ticketId" INTEGER NOT NULL,
  "messageId" INTEGER NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TicketAttachment_storageKey_key" ON "TicketAttachment"("storageKey");
CREATE INDEX "TicketAttachment_ticketId_idx" ON "TicketAttachment"("ticketId");
CREATE INDEX "TicketAttachment_messageId_idx" ON "TicketAttachment"("messageId");
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TicketMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
