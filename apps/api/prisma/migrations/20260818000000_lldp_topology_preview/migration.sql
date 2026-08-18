-- Additive migration: persists LLDP topology preview payloads so that a long
-- discovery survives an API restart and can still be reviewed/applied later.
-- No existing table, column or data is modified.
CREATE TABLE "LldpTopologyPreview" (
  "id" TEXT NOT NULL,
  "mapId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LldpTopologyPreview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LldpTopologyPreview_mapId_idx"
  ON "LldpTopologyPreview"("mapId");
