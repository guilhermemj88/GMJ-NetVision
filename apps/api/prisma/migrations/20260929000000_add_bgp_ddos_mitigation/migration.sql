-- CreateEnum
CREATE TYPE "BgpMitigationMode" AS ENUM ('SIMULATION_ONLY');

-- CreateEnum
CREATE TYPE "BgpMitigationProfileMode" AS ENUM ('DISABLED', 'ALERT_ONLY', 'AUTO');

-- CreateEnum
CREATE TYPE "BgpMitigationState" AS ENUM ('DISABLED', 'ALERT_ONLY', 'NORMAL', 'TRIGGER_PENDING', 'MITIGATING', 'MITIGATED', 'RECOVERY_PENDING', 'RECOVERING', 'FAILED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "BgpMitigationBandwidthSource" AS ENUM ('DESCRIPTION', 'MANUAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BgpMitigationSimulationResult" AS ENUM ('WOULD_MITIGATE', 'WOULD_RECOVER', 'NO_ACTION', 'BLOCKED', 'FAILED');

-- CreateTable
CREATE TABLE "BgpMitigationProfile" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "policyName" TEXT NOT NULL,
    "interfaceId" TEXT,
    "detectedBandwidthBps" BIGINT,
    "bandwidthSource" "BgpMitigationBandwidthSource" NOT NULL DEFAULT 'UNKNOWN',
    "bandwidthOverrideBps" BIGINT,
    "prefixLimit" INTEGER NOT NULL DEFAULT 100,
    "mode" "BgpMitigationProfileMode" NOT NULL DEFAULT 'ALERT_ONLY',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggerPercent" DOUBLE PRECISION NOT NULL DEFAULT 90,
    "recoveryPercent" DOUBLE PRECISION NOT NULL DEFAULT 70,
    "triggerSamples" INTEGER NOT NULL DEFAULT 3,
    "recoverySamples" INTEGER NOT NULL DEFAULT 12,
    "checkIntervalSeconds" INTEGER NOT NULL DEFAULT 5,
    "mitigationRt" TEXT NOT NULL DEFAULT '268568:660',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BgpMitigationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BgpMitigationProfilePeer" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "peerId" TEXT,
    "peerAddress" TEXT NOT NULL,
    "addressFamily" "BgpAddressFamily" NOT NULL DEFAULT 'IPV4',
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BgpMitigationProfilePeer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BgpMitigationRuntime" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "state" "BgpMitigationState" NOT NULL DEFAULT 'NORMAL',
    "currentTrafficBps" BIGINT,
    "peakTrafficBps" BIGINT,
    "triggerCounter" INTEGER NOT NULL DEFAULT 0,
    "recoveryCounter" INTEGER NOT NULL DEFAULT 0,
    "plannedNode" INTEGER,
    "lastSampleAt" TIMESTAMP(3),
    "lastValidatedAt" TIMESTAMP(3),
    "lastReconciledAt" TIMESTAMP(3),
    "safeError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BgpMitigationRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BgpMitigationSimulation" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT,
    "simulatedTrafficBps" BIGINT,
    "simulatedUtilizationPercent" DOUBLE PRECISION,
    "simulatedSamples" INTEGER,
    "simulatedPrefixCount" INTEGER,
    "calculatedThresholdBps" BIGINT,
    "result" "BgpMitigationSimulationResult" NOT NULL,
    "plannedNode" INTEGER,
    "plannedPolicy" TEXT,
    "plannedRt" TEXT,
    "affectedPeers" JSONB,
    "commandPreview" JSONB,
    "notificationPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BgpMitigationSimulation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BgpMitigationEvent" (
    "id" BIGSERIAL NOT NULL,
    "profileId" TEXT NOT NULL,
    "simulationId" TEXT,
    "type" TEXT NOT NULL,
    "previousState" "BgpMitigationState",
    "newState" "BgpMitigationState",
    "trafficBps" BIGINT,
    "thresholdBps" BIGINT,
    "plannedNode" INTEGER,
    "policyName" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "safeError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BgpMitigationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BgpMitigationProfile_deviceId_mode_idx" ON "BgpMitigationProfile"("deviceId", "mode");

-- CreateIndex
CREATE INDEX "BgpMitigationProfile_policyName_idx" ON "BgpMitigationProfile"("policyName");

-- CreateIndex
CREATE INDEX "BgpMitigationProfile_interfaceId_idx" ON "BgpMitigationProfile"("interfaceId");

-- CreateIndex
CREATE UNIQUE INDEX "BgpMitigationProfile_deviceId_policyName_key" ON "BgpMitigationProfile"("deviceId", "policyName");

-- CreateIndex
CREATE INDEX "BgpMitigationProfilePeer_peerId_idx" ON "BgpMitigationProfilePeer"("peerId");

-- CreateIndex
CREATE INDEX "BgpMitigationProfilePeer_addressFamily_idx" ON "BgpMitigationProfilePeer"("addressFamily");

-- CreateIndex
CREATE UNIQUE INDEX "BgpMitigationProfilePeer_profileId_peerAddress_key" ON "BgpMitigationProfilePeer"("profileId", "peerAddress");

-- CreateIndex
CREATE UNIQUE INDEX "BgpMitigationRuntime_profileId_key" ON "BgpMitigationRuntime"("profileId");

-- CreateIndex
CREATE INDEX "BgpMitigationRuntime_state_idx" ON "BgpMitigationRuntime"("state");

-- CreateIndex
CREATE INDEX "BgpMitigationRuntime_lastSampleAt_idx" ON "BgpMitigationRuntime"("lastSampleAt");

-- CreateIndex
CREATE INDEX "BgpMitigationSimulation_profileId_createdAt_idx" ON "BgpMitigationSimulation"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "BgpMitigationSimulation_userId_idx" ON "BgpMitigationSimulation"("userId");

-- CreateIndex
CREATE INDEX "BgpMitigationEvent_profileId_createdAt_idx" ON "BgpMitigationEvent"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "BgpMitigationEvent_simulationId_idx" ON "BgpMitigationEvent"("simulationId");

-- AddForeignKey
ALTER TABLE "BgpMitigationProfile" ADD CONSTRAINT "BgpMitigationProfile_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpMitigationProfile" ADD CONSTRAINT "BgpMitigationProfile_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpMitigationProfilePeer" ADD CONSTRAINT "BgpMitigationProfilePeer_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BgpMitigationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpMitigationProfilePeer" ADD CONSTRAINT "BgpMitigationProfilePeer_peerId_fkey" FOREIGN KEY ("peerId") REFERENCES "BgpPeer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpMitigationRuntime" ADD CONSTRAINT "BgpMitigationRuntime_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BgpMitigationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpMitigationSimulation" ADD CONSTRAINT "BgpMitigationSimulation_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BgpMitigationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpMitigationSimulation" ADD CONSTRAINT "BgpMitigationSimulation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpMitigationEvent" ADD CONSTRAINT "BgpMitigationEvent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BgpMitigationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgpMitigationEvent" ADD CONSTRAINT "BgpMitigationEvent_simulationId_fkey" FOREIGN KEY ("simulationId") REFERENCES "BgpMitigationSimulation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

