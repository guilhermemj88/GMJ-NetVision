-- Additive audit only. No profile, direction, mode, threshold or authorization updates.
CREATE TABLE "MitigationDirectionAudit" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "changes" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MitigationDirectionAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MitigationDirectionAudit_createdAt_idx" ON "MitigationDirectionAudit"("createdAt");
