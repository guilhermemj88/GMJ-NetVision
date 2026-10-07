-- CreateEnum
CREATE TYPE "AlarmSuppressionMode" AS ENUM ('UNTIL_CLEAR', 'UNTIL_TIME');

-- CreateEnum
CREATE TYPE "AlarmSuppressionReason" AS ENUM ('INTENTIONAL_SHUTDOWN', 'MAINTENANCE', 'FALSE_POSITIVE', 'OTHER');

-- CreateTable
CREATE TABLE "AlarmSuppression" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "interfaceId" TEXT NOT NULL,
    "type" "AlarmType" NOT NULL,
    "ruleId" TEXT,
    "metricKey" TEXT,
    "mode" "AlarmSuppressionMode" NOT NULL,
    "reason" "AlarmSuppressionReason" NOT NULL,
    "note" TEXT,
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suppressedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "clearedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlarmSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlarmSuppression_fingerprint_clearedAt_idx" ON "AlarmSuppression"("fingerprint", "clearedAt");

-- CreateIndex
CREATE INDEX "AlarmSuppression_deviceId_clearedAt_idx" ON "AlarmSuppression"("deviceId", "clearedAt");

-- CreateIndex
CREATE INDEX "AlarmSuppression_interfaceId_clearedAt_idx" ON "AlarmSuppression"("interfaceId", "clearedAt");

-- CreateIndex
CREATE INDEX "AlarmSuppression_clearedAt_expiresAt_idx" ON "AlarmSuppression"("clearedAt", "expiresAt");

-- AddForeignKey
ALTER TABLE "AlarmSuppression" ADD CONSTRAINT "AlarmSuppression_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmSuppression" ADD CONSTRAINT "AlarmSuppression_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE CASCADE ON UPDATE CASCADE;
