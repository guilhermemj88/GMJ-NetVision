-- Additive shadow state and integration audit. No operational profile/runtime updates.
CREATE TABLE "MitigationFastShadowState" (
  "profileId" TEXT NOT NULL PRIMARY KEY,
  "state" TEXT NOT NULL DEFAULT 'NORMAL',
  "triggerCounter" INTEGER NOT NULL DEFAULT 0,
  "recoveryCounter" INTEGER NOT NULL DEFAULT 0,
  "currentTrafficBps" BIGINT,
  "lastSampleAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "MitigationFastDecision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "profileId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "sampleId" TEXT NOT NULL,
  "sampleAt" TIMESTAMP(3) NOT NULL,
  "outcome" TEXT NOT NULL,
  "reason" TEXT,
  "decision" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MitigationFastDecision_mode_check" CHECK ("mode" IN ('SHADOW', 'ENFORCE'))
);
CREATE UNIQUE INDEX "MitigationFastDecision_profileId_mode_sampleId_key" ON "MitigationFastDecision"("profileId", "mode", "sampleId");
CREATE INDEX "MitigationFastDecision_profileId_createdAt_idx" ON "MitigationFastDecision"("profileId", "createdAt");
