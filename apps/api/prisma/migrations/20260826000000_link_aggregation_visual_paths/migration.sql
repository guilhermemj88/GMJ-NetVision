CREATE TYPE "LinkAggregationMode" AS ENUM ('NONE', 'SUM');

ALTER TABLE "Link"
  ADD COLUMN "aggregationMode" "LinkAggregationMode" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "metricSources" JSONB,
  ADD COLUMN "visualPaths" JSONB;
