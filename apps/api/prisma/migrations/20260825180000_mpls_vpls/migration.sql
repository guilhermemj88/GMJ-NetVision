CREATE TYPE "MplsSource" AS ENUM ('SNMP');
CREATE TYPE "MplsStatus" AS ENUM ('UP', 'DOWN', 'DEGRADED', 'ADMIN_DOWN', 'UNKNOWN');
CREATE TYPE "MplsVsiOperationalStatus" AS ENUM ('UP', 'DOWN', 'ADMIN_DOWN', 'UNKNOWN');
CREATE TYPE "MplsAdminStatus" AS ENUM ('UP', 'DOWN', 'UNKNOWN');
CREATE TYPE "MplsPwStatus" AS ENUM ('DOWN', 'UP', 'PLUG_OUT', 'BACKUP', 'UNKNOWN');
CREATE TYPE "MplsPwState" AS ENUM ('DOWN', 'UP', 'UNKNOWN');
CREATE TYPE "MplsPwWorkingState" AS ENUM ('MASTER', 'BACKUP', 'UNKNOWN');
CREATE TYPE "MplsEntityType" AS ENUM ('VSI', 'PW');

CREATE TABLE "MplsDeviceState" (
  "id" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "supported" BOOLEAN NOT NULL DEFAULT false,
  "source" "MplsSource" NOT NULL DEFAULT 'SNMP',
  "lastPollingAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastErrorSafe" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MplsDeviceState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MplsVsi" (
  "id" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "signalingType" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "rd" TEXT,
  "vsiId" INTEGER,
  "status" "MplsStatus" NOT NULL DEFAULT 'UNKNOWN',
  "operationalStatus" "MplsVsiOperationalStatus" NOT NULL DEFAULT 'UNKNOWN',
  "adminStatus" "MplsAdminStatus" NOT NULL DEFAULT 'UNKNOWN',
  "mtu" INTEGER,
  "vcType" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "tunnelPolicy" TEXT,
  "description" TEXT,
  "vlanId" INTEGER,
  "localInterfaceId" TEXT,
  "source" "MplsSource" NOT NULL DEFAULT 'SNMP',
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MplsVsi_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MplsPw" (
  "id" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "mplsVsiId" TEXT NOT NULL,
  "vsiName" TEXT NOT NULL,
  "pwId" INTEGER NOT NULL,
  "remoteIp" TEXT NOT NULL,
  "remoteHostId" TEXT,
  "tunnelPolicy" TEXT,
  "pwType" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "inboundLabel" INTEGER,
  "outboundLabel" INTEGER,
  "status" "MplsPwStatus" NOT NULL DEFAULT 'UNKNOWN',
  "state" "MplsPwState" NOT NULL DEFAULT 'UNKNOWN',
  "workingState" "MplsPwWorkingState" NOT NULL DEFAULT 'UNKNOWN',
  "upStartTime" TIMESTAMP(3),
  "upSumTime" BIGINT,
  "source" "MplsSource" NOT NULL DEFAULT 'SNMP',
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MplsPw_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MplsStateEvent" (
  "id" BIGSERIAL NOT NULL,
  "hostId" TEXT NOT NULL,
  "entityType" "MplsEntityType" NOT NULL,
  "entityId" TEXT NOT NULL,
  "vsiName" TEXT NOT NULL,
  "pwId" INTEGER,
  "remoteIp" TEXT,
  "previousStatus" TEXT NOT NULL,
  "currentStatus" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MplsStateEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MplsDeviceState_hostId_key" ON "MplsDeviceState"("hostId");
CREATE UNIQUE INDEX "MplsVsi_hostId_name_key" ON "MplsVsi"("hostId", "name");
CREATE INDEX "MplsVsi_hostId_idx" ON "MplsVsi"("hostId");
CREATE INDEX "MplsVsi_operationalStatus_idx" ON "MplsVsi"("operationalStatus");
CREATE INDEX "MplsVsi_status_idx" ON "MplsVsi"("status");
CREATE INDEX "MplsVsi_lastSeenAt_idx" ON "MplsVsi"("lastSeenAt");
CREATE INDEX "MplsVsi_localInterfaceId_idx" ON "MplsVsi"("localInterfaceId");
CREATE UNIQUE INDEX "MplsPw_hostId_vsiName_pwId_remoteIp_key" ON "MplsPw"("hostId", "vsiName", "pwId", "remoteIp");
CREATE INDEX "MplsPw_hostId_idx" ON "MplsPw"("hostId");
CREATE INDEX "MplsPw_mplsVsiId_idx" ON "MplsPw"("mplsVsiId");
CREATE INDEX "MplsPw_remoteIp_idx" ON "MplsPw"("remoteIp");
CREATE INDEX "MplsPw_remoteHostId_idx" ON "MplsPw"("remoteHostId");
CREATE INDEX "MplsPw_status_idx" ON "MplsPw"("status");
CREATE INDEX "MplsPw_lastSeenAt_idx" ON "MplsPw"("lastSeenAt");
CREATE INDEX "MplsStateEvent_hostId_occurredAt_idx" ON "MplsStateEvent"("hostId", "occurredAt");
CREATE INDEX "MplsStateEvent_entityType_entityId_occurredAt_idx" ON "MplsStateEvent"("entityType", "entityId", "occurredAt");

ALTER TABLE "MplsDeviceState" ADD CONSTRAINT "MplsDeviceState_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MplsVsi" ADD CONSTRAINT "MplsVsi_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MplsVsi" ADD CONSTRAINT "MplsVsi_localInterfaceId_fkey"
  FOREIGN KEY ("localInterfaceId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MplsPw" ADD CONSTRAINT "MplsPw_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MplsPw" ADD CONSTRAINT "MplsPw_mplsVsiId_fkey"
  FOREIGN KEY ("mplsVsiId") REFERENCES "MplsVsi"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MplsPw" ADD CONSTRAINT "MplsPw_remoteHostId_fkey"
  FOREIGN KEY ("remoteHostId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MplsStateEvent" ADD CONSTRAINT "MplsStateEvent_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
