-- CreateEnum
CREATE TYPE "OperationalOccurrenceType" AS ENUM ('CRC_FCS', 'DISCARDS');

-- CreateEnum
CREATE TYPE "OperationalOccurrenceCloseReason" AS ENUM ('ACKNOWLEDGED', 'QUIET_24H', 'MANUAL');

-- CreateTable
CREATE TABLE "OperationalOccurrence" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" "OperationalOccurrenceType" NOT NULL,
    "deviceId" TEXT NOT NULL,
    "interfaceId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSampleAt" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "crcDeltaTotal" BIGINT NOT NULL DEFAULT 0,
    "rxDiscardDeltaTotal" BIGINT NOT NULL DEFAULT 0,
    "txDiscardDeltaTotal" BIGINT NOT NULL DEFAULT 0,
    "currentRatePerMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "peakRatePerMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeReason" "OperationalOccurrenceCloseReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalOccurrenceSource" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "interfaceId" TEXT NOT NULL,
    "type" "OperationalOccurrenceType" NOT NULL,
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalOccurrenceSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationalOccurrence_fingerprint_closedAt_idx" ON "OperationalOccurrence"("fingerprint", "closedAt");

-- CreateIndex
CREATE INDEX "OperationalOccurrence_fingerprint_lastSampleAt_idx" ON "OperationalOccurrence"("fingerprint", "lastSampleAt");

-- CreateIndex
CREATE INDEX "OperationalOccurrence_interfaceId_lastSeenAt_idx" ON "OperationalOccurrence"("interfaceId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OperationalOccurrence_deviceId_lastSeenAt_idx" ON "OperationalOccurrence"("deviceId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OperationalOccurrence_type_lastSeenAt_idx" ON "OperationalOccurrence"("type", "lastSeenAt");

-- CreateIndex
CREATE INDEX "OperationalOccurrence_acknowledgedAt_idx" ON "OperationalOccurrence"("acknowledgedAt");

-- CreateIndex
CREATE INDEX "OperationalOccurrence_closedAt_idx" ON "OperationalOccurrence"("closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationalOccurrenceSource_interfaceId_sourceTimestamp_type_key" ON "OperationalOccurrenceSource"("interfaceId", "sourceTimestamp", "type");

-- CreateIndex
CREATE INDEX "OperationalOccurrenceSource_occurrenceId_idx" ON "OperationalOccurrenceSource"("occurrenceId");

-- CreateIndex
CREATE INDEX "OperationalOccurrenceSource_sourceTimestamp_idx" ON "OperationalOccurrenceSource"("sourceTimestamp");

-- AddForeignKey
ALTER TABLE "OperationalOccurrence" ADD CONSTRAINT "OperationalOccurrence_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalOccurrence" ADD CONSTRAINT "OperationalOccurrence_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalOccurrenceSource" ADD CONSTRAINT "OperationalOccurrenceSource_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "OperationalOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalOccurrenceSource" ADD CONSTRAINT "OperationalOccurrenceSource_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE CASCADE ON UPDATE CASCADE;