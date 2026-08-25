CREATE TYPE "TrafficMode" AS ENUM ('BIDIRECTIONAL', 'SINGLE_ENDED');
CREATE TYPE "MplsAcStatus" AS ENUM ('UP', 'DOWN', 'UNKNOWN');

ALTER TABLE "Link"
  ADD COLUMN "trafficMode" "TrafficMode" NOT NULL DEFAULT 'BIDIRECTIONAL',
  ADD COLUMN "customColor" TEXT,
  ADD COLUMN "animationEnabled" BOOLEAN;

ALTER TABLE "MplsDeviceState"
  ADD COLUMN "vsiSupported" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "acSupported" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pwSupported" BOOLEAN NOT NULL DEFAULT false;

UPDATE "MplsDeviceState" SET "vsiSupported" = "supported";

CREATE TABLE "MplsAc" (
  "id" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "mplsVsiId" TEXT NOT NULL,
  "vsiName" TEXT NOT NULL,
  "ifIndex" INTEGER NOT NULL,
  "interfaceId" TEXT,
  "status" "MplsAcStatus" NOT NULL DEFAULT 'UNKNOWN',
  "upStartTimeRaw" TEXT,
  "upSumTimeRaw" BIGINT,
  "source" "MplsSource" NOT NULL DEFAULT 'SNMP',
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MplsAc_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MplsAc_hostId_vsiName_ifIndex_key" ON "MplsAc"("hostId", "vsiName", "ifIndex");
CREATE INDEX "MplsAc_hostId_idx" ON "MplsAc"("hostId");
CREATE INDEX "MplsAc_mplsVsiId_idx" ON "MplsAc"("mplsVsiId");
CREATE INDEX "MplsAc_interfaceId_idx" ON "MplsAc"("interfaceId");
CREATE INDEX "MplsAc_lastSeenAt_idx" ON "MplsAc"("lastSeenAt");

ALTER TABLE "MplsAc" ADD CONSTRAINT "MplsAc_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MplsAc" ADD CONSTRAINT "MplsAc_mplsVsiId_fkey"
  FOREIGN KEY ("mplsVsiId") REFERENCES "MplsVsi"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MplsAc" ADD CONSTRAINT "MplsAc_interfaceId_fkey"
  FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;
