CREATE TYPE "AlarmType" AS ENUM ('INTERFACE_DOWN');

CREATE TYPE "AlarmSeverity" AS ENUM ('CRITICAL', 'MAJOR', 'WARNING', 'INFO');

CREATE TABLE "Alarm" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "interfaceId" TEXT NOT NULL,
  "linkId" TEXT,
  "type" "AlarmType" NOT NULL DEFAULT 'INTERFACE_DOWN',
  "severity" "AlarmSeverity" NOT NULL DEFAULT 'CRITICAL',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedBy" TEXT,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Alarm_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Alarm_deviceId_idx" ON "Alarm"("deviceId");

CREATE INDEX "Alarm_interfaceId_endedAt_idx" ON "Alarm"("interfaceId", "endedAt");

CREATE INDEX "Alarm_startedAt_idx" ON "Alarm"("startedAt");

ALTER TABLE "Alarm"
  ADD CONSTRAINT "Alarm_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Alarm"
  ADD CONSTRAINT "Alarm_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Alarm"
  ADD CONSTRAINT "Alarm_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "Link"("id") ON DELETE SET NULL ON UPDATE CASCADE;
