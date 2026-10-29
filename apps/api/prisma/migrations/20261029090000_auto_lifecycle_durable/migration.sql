CREATE TABLE "MitigationAutomationRecord" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MitigationAutomationRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MitigationAutomationRecord_kind_status_updatedAt_idx"
ON "MitigationAutomationRecord"("kind", "status", "updatedAt");
