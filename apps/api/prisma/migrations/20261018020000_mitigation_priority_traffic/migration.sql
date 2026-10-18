-- Candidate only. Apply to an isolated database for validation, never automatically to production.
CREATE TABLE "MitigationTrafficObservation" (
  "id" TEXT NOT NULL,
  "generation" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "interfaceId" TEXT NOT NULL,
  "ifIndex" INTEGER NOT NULL,
  "interfaceName" TEXT NOT NULL,
  "requestStartedAt" TIMESTAMP(3) NOT NULL,
  "collectedAt" TIMESTAMP(3) NOT NULL,
  "previousCollectedAt" TIMESTAMP(3),
  "intervalMs" DOUBLE PRECISION,
  "inOctets" DECIMAL(20,0) NOT NULL,
  "outOctets" DECIMAL(20,0) NOT NULL,
  "uptimeTicks" BIGINT NOT NULL,
  "discontinuityTicks" BIGINT NOT NULL,
  "lastChangeTicks" BIGINT NOT NULL,
  "adminStatus" INTEGER NOT NULL,
  "operStatus" INTEGER NOT NULL,
  "speedBps" BIGINT,
  "rxBps" DOUBLE PRECISION,
  "txBps" DOUBLE PRECISION,
  "quality" TEXT NOT NULL,
  CONSTRAINT "MitigationTrafficObservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MitigationTrafficObservation_interfaceId_collectedAt_key" ON "MitigationTrafficObservation"("interfaceId", "collectedAt");
CREATE INDEX "MitigationTrafficObservation_collectedAt_idx" ON "MitigationTrafficObservation"("collectedAt");
