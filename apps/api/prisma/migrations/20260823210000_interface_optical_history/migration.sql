ALTER TABLE "Interface"
  ADD COLUMN "opticalLaneSource" TEXT,
  ADD COLUMN "opticalLanesUpdatedAt" TIMESTAMP(3);

CREATE TABLE "InterfaceOpticalSample" (
  "id" BIGSERIAL NOT NULL,
  "interfaceId" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rxPowerDbm" DOUBLE PRECISION,
  "txPowerDbm" DOUBLE PRECISION,
  "opticalLanes" JSONB,
  CONSTRAINT "InterfaceOpticalSample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InterfaceOpticalSample_interfaceId_timestamp_idx"
  ON "InterfaceOpticalSample"("interfaceId", "timestamp");

ALTER TABLE "InterfaceOpticalSample"
  ADD CONSTRAINT "InterfaceOpticalSample_interfaceId_fkey"
  FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
