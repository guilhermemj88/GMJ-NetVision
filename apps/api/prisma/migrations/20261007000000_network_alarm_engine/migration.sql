-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AlarmType" ADD VALUE 'INTERFACE_ERRORS';
ALTER TYPE "AlarmType" ADD VALUE 'INTERFACE_CRC';
ALTER TYPE "AlarmType" ADD VALUE 'INTERFACE_DISCARDS';

-- AlterTable
ALTER TABLE "InterfaceMetricSample" ADD COLUMN     "fcsErrors" BIGINT,
ADD COLUMN     "fcsErrorsDelta" BIGINT;

-- AlterTable
ALTER TABLE "Alarm" ADD COLUMN     "currentValue" DOUBLE PRECISION,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "metricKey" TEXT,
ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "notifiedSeverity" "AlarmSeverity",
ADD COLUMN     "resolutionNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "ruleId" TEXT,
ADD COLUMN     "thresholdValue" DOUBLE PRECISION,
ADD COLUMN     "unit" TEXT;

-- CreateTable
CREATE TABLE "AlarmRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AlarmType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" "AlarmSeverity" NOT NULL,
    "mapLinkedOnly" BOOLEAN NOT NULL DEFAULT true,
    "mediaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scope" JSONB NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlarmRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlarmRule_type_enabled_idx" ON "AlarmRule"("type", "enabled");

-- CreateIndex
CREATE INDEX "Alarm_deviceId_type_endedAt_idx" ON "Alarm"("deviceId", "type", "endedAt");

