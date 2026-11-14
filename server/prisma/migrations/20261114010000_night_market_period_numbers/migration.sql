ALTER TABLE "NightMarketPeriod" ADD COLUMN "number" INTEGER NOT NULL DEFAULT 1;
WITH numbered AS (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "startsAt", "id") AS period_number
    FROM "NightMarketPeriod"
)
UPDATE "NightMarketPeriod" AS period
SET "number" = numbered.period_number
FROM numbered
WHERE period."id" = numbered."id";
CREATE UNIQUE INDEX "NightMarketPeriod_number_key" ON "NightMarketPeriod"("number");
ALTER TABLE "NightMarketPeriod" ALTER COLUMN "currentAct" SET DEFAULT 2;
