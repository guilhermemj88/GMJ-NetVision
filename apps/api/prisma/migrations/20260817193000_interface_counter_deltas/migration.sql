-- Keep the vendor counters as cumulative values and store interval deltas
-- separately. Existing history remains untouched and starts with zero deltas.
ALTER TABLE "InterfaceMetricSample"
  ADD COLUMN "inErrorsDelta" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "outErrorsDelta" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "inDiscardsDelta" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "outDiscardsDelta" BIGINT NOT NULL DEFAULT 0;
