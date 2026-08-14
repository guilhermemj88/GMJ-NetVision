-- Initial production schema for maps, global hosts, encrypted credentials and assisted discovery.
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "MapMode" AS ENUM ('MANUAL', 'AUTO', 'HYBRID');
CREATE TYPE "PositionSource" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "NodeDisplayMode" AS ENUM ('ICON_2D', 'ICON_3D', 'CARD');
CREATE TYPE "LinkDisplayStyle" AS ENUM ('FLOW', 'WEATHERMAP', 'HYBRID', 'MINIMAL');
CREATE TYPE "LinkMetricDisplay" AS ENUM ('THROUGHPUT', 'UTILIZATION', 'BOTH', 'NONE');
CREATE TYPE "CapacitySource" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "DeviceStatus" AS ENUM ('UP', 'DOWN', 'WARNING', 'UNKNOWN');
CREATE TYPE "InterfaceStatus" AS ENUM ('UP', 'DOWN', 'DISABLED', 'WARNING', 'UNKNOWN');
CREATE TYPE "DiscoverySource" AS ENUM ('MANUAL', 'LLDP_SNMP', 'LLDP_SSH');
CREATE TYPE "DiscoveryJobStatus" AS ENUM ('PENDING', 'RUNNING', 'REVIEW', 'COMPLETED', 'FAILED');
CREATE TYPE "MatchStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'AMBIGUOUS');
CREATE TYPE "HostOrigin" AS ENUM ('MANUAL', 'ZABBIX', 'DISCOVERY', 'IMPORTED');
CREATE TYPE "SourceKind" AS ENUM ('ZABBIX', 'SSH', 'SNMP');
CREATE TYPE "SourceConnectionState" AS ENUM ('DISABLED', 'CONFIGURED', 'CONNECTED', 'FAILED');
CREATE TYPE "SnmpVersion" AS ENUM ('SNMP_V2C', 'SNMP_V3');
CREATE TYPE "SnmpSecurityLevel" AS ENUM ('NO_AUTH_NO_PRIV', 'AUTH_NO_PRIV', 'AUTH_PRIV');
CREATE TYPE "SnmpAuthProtocol" AS ENUM ('MD5', 'SHA', 'SHA256');
CREATE TYPE "SnmpPrivacyProtocol" AS ENUM ('DES', 'AES', 'AES256');

CREATE TABLE "Map" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "mode" "MapMode" NOT NULL DEFAULT 'HYBRID',
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "nodeDisplayMode" "NodeDisplayMode" NOT NULL DEFAULT 'ICON_2D',
  "linkDisplayStyle" "LinkDisplayStyle" NOT NULL DEFAULT 'HYBRID',
  "linkMetricDisplay" "LinkMetricDisplay" NOT NULL DEFAULT 'BOTH',
  "nodeScale" DOUBLE PRECISION NOT NULL DEFAULT 100,
  "linkScale" DOUBLE PRECISION NOT NULL DEFAULT 100,
  "labelScale" DOUBLE PRECISION NOT NULL DEFAULT 100,
  "viewport" JSONB,
  "filters" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Map_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MapNode" (
  "id" TEXT NOT NULL,
  "mapId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "x" DOUBLE PRECISION NOT NULL,
  "y" DOUBLE PRECISION NOT NULL,
  "locked" BOOLEAN NOT NULL DEFAULT false,
  "positionSource" "PositionSource" NOT NULL DEFAULT 'AUTO',
  CONSTRAINT "MapNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Device" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "ip" TEXT NOT NULL,
  "managementIp" TEXT NOT NULL,
  "vendor" TEXT,
  "model" TEXT,
  "description" TEXT NOT NULL DEFAULT '',
  "notes" TEXT NOT NULL DEFAULT '',
  "origin" "HostOrigin" NOT NULL DEFAULT 'MANUAL',
  "status" "DeviceStatus" NOT NULL DEFAULT 'UNKNOWN',
  "deviceType" TEXT NOT NULL,
  "site" TEXT,
  "source" TEXT NOT NULL,
  "discoveryMethod" TEXT NOT NULL DEFAULT 'AUTO',
  "useZabbix" BOOLEAN NOT NULL DEFAULT false,
  "zabbixHostId" TEXT,
  "zabbixHostName" TEXT,
  "zabbixInterfaceId" TEXT,
  "zabbixIp" TEXT,
  "sshEnabled" BOOLEAN NOT NULL DEFAULT false,
  "sshHost" TEXT,
  "sshPort" INTEGER NOT NULL DEFAULT 22,
  "sshUsername" TEXT,
  "sshAuthentication" TEXT,
  "snmpEnabled" BOOLEAN NOT NULL DEFAULT false,
  "snmpVersion" "SnmpVersion",
  "snmpHost" TEXT,
  "snmpPort" INTEGER NOT NULL DEFAULT 161,
  "snmpUsername" TEXT,
  "snmpSecurityLevel" "SnmpSecurityLevel",
  "snmpAuthProtocol" "SnmpAuthProtocol",
  "snmpPrivacyProtocol" "SnmpPrivacyProtocol",
  "lastPollingAt" TIMESTAMP(3),
  "lastDiscoveryAt" TIMESTAMP(3),
  "uptimeSeconds" BIGINT,
  "cpuPercent" DOUBLE PRECISION,
  "memoryPercent" DOUBLE PRECISION,
  "snmpCredentialId" TEXT,
  "sshCredentialId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Interface" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "alias" TEXT,
  "description" TEXT,
  "ifIndex" INTEGER NOT NULL,
  "mac" TEXT,
  "mtu" INTEGER,
  "speedBps" BIGINT,
  "adminStatus" TEXT NOT NULL,
  "operStatus" "InterfaceStatus" NOT NULL DEFAULT 'UNKNOWN',
  "rxItemId" TEXT,
  "txItemId" TEXT,
  "statusItemId" TEXT,
  "inErrorsItemId" TEXT,
  "outErrorsItemId" TEXT,
  "inDiscardsItemId" TEXT,
  "outDiscardsItemId" TEXT,
  "dataSources" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Interface_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Link" (
  "id" TEXT NOT NULL,
  "mapId" TEXT NOT NULL,
  "sourceDeviceId" TEXT NOT NULL,
  "sourceInterfaceId" TEXT NOT NULL,
  "targetDeviceId" TEXT NOT NULL,
  "targetInterfaceId" TEXT NOT NULL,
  "capacityBps" BIGINT NOT NULL,
  "autoCapacityBps" BIGINT,
  "capacitySource" "CapacitySource" NOT NULL DEFAULT 'AUTO',
  "label" TEXT,
  "status" "DeviceStatus" NOT NULL DEFAULT 'UNKNOWN',
  "discoverySource" "DiscoverySource" NOT NULL DEFAULT 'MANUAL',
  "metricSource" TEXT NOT NULL,
  "visualStyle" "LinkDisplayStyle",
  "metricDisplay" "LinkMetricDisplay",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Link_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MapPlaylist" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "rotationIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MapPlaylist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MapPlaylistItem" (
  "playlistId" TEXT NOT NULL,
  "mapId" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  CONSTRAINT "MapPlaylistItem_pkey" PRIMARY KEY ("playlistId", "mapId")
);

CREATE TABLE "DataSource" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "baseUrl" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "config" JSONB,
  "secret" BYTEA,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SnmpCredential" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 161,
  "encryptedPayload" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SnmpCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SshCredential" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 22,
  "username" TEXT NOT NULL,
  "encryptedPayload" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SshCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceSourceMapping" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "dataSourceId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "matchStatus" "MatchStatus" NOT NULL DEFAULT 'UNMATCHED',
  "matchReason" TEXT,
  CONSTRAINT "DeviceSourceMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterfaceSourceMapping" (
  "id" TEXT NOT NULL,
  "interfaceId" TEXT NOT NULL,
  "dataSourceId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  CONSTRAINT "InterfaceSourceMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceSourceHealth" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "source" "SourceKind" NOT NULL,
  "state" "SourceConnectionState" NOT NULL DEFAULT 'CONFIGURED',
  "lastSuccess" TIMESTAMP(3),
  "lastFailure" TIMESTAMP(3),
  "lastErrorSafe" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceSourceHealth_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryJob" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "status" "DiscoveryJobStatus" NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscoveryJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DiscoveryResult" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "localPort" TEXT NOT NULL,
  "remotePort" TEXT NOT NULL,
  "remoteIdentity" JSONB NOT NULL,
  "matchStatus" "MatchStatus" NOT NULL DEFAULT 'UNMATCHED',
  "matchedDeviceId" TEXT,
  "accepted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiscoveryResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MapNode_deviceId_idx" ON "MapNode"("deviceId");
CREATE UNIQUE INDEX "MapNode_mapId_deviceId_key" ON "MapNode"("mapId", "deviceId");
CREATE INDEX "Device_hostname_idx" ON "Device"("hostname");
CREATE INDEX "Device_ip_idx" ON "Device"("ip");
CREATE INDEX "Device_managementIp_idx" ON "Device"("managementIp");
CREATE INDEX "Device_zabbixHostId_idx" ON "Device"("zabbixHostId");
CREATE UNIQUE INDEX "Interface_deviceId_ifIndex_key" ON "Interface"("deviceId", "ifIndex");
CREATE INDEX "Link_mapId_idx" ON "Link"("mapId");
CREATE INDEX "Link_sourceDeviceId_idx" ON "Link"("sourceDeviceId");
CREATE INDEX "Link_targetDeviceId_idx" ON "Link"("targetDeviceId");
CREATE INDEX "MapPlaylistItem_mapId_idx" ON "MapPlaylistItem"("mapId");
CREATE UNIQUE INDEX "MapPlaylistItem_playlistId_order_key" ON "MapPlaylistItem"("playlistId", "order");
CREATE UNIQUE INDEX "DeviceSourceMapping_dataSourceId_externalId_key" ON "DeviceSourceMapping"("dataSourceId", "externalId");
CREATE UNIQUE INDEX "InterfaceSourceMapping_dataSourceId_externalId_key" ON "InterfaceSourceMapping"("dataSourceId", "externalId");
CREATE INDEX "DeviceSourceHealth_source_state_idx" ON "DeviceSourceHealth"("source", "state");
CREATE UNIQUE INDEX "DeviceSourceHealth_deviceId_source_key" ON "DeviceSourceHealth"("deviceId", "source");

ALTER TABLE "MapNode" ADD CONSTRAINT "MapNode_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "Map"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MapNode" ADD CONSTRAINT "MapNode_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_snmpCredentialId_fkey" FOREIGN KEY ("snmpCredentialId") REFERENCES "SnmpCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Device" ADD CONSTRAINT "Device_sshCredentialId_fkey" FOREIGN KEY ("sshCredentialId") REFERENCES "SshCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Interface" ADD CONSTRAINT "Interface_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Link" ADD CONSTRAINT "Link_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "Map"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Link" ADD CONSTRAINT "Link_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Link" ADD CONSTRAINT "Link_sourceInterfaceId_fkey" FOREIGN KEY ("sourceInterfaceId") REFERENCES "Interface"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Link" ADD CONSTRAINT "Link_targetDeviceId_fkey" FOREIGN KEY ("targetDeviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Link" ADD CONSTRAINT "Link_targetInterfaceId_fkey" FOREIGN KEY ("targetInterfaceId") REFERENCES "Interface"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MapPlaylistItem" ADD CONSTRAINT "MapPlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "MapPlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MapPlaylistItem" ADD CONSTRAINT "MapPlaylistItem_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "Map"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceSourceMapping" ADD CONSTRAINT "DeviceSourceMapping_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceSourceMapping" ADD CONSTRAINT "DeviceSourceMapping_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterfaceSourceMapping" ADD CONSTRAINT "InterfaceSourceMapping_interfaceId_fkey" FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterfaceSourceMapping" ADD CONSTRAINT "InterfaceSourceMapping_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceSourceHealth" ADD CONSTRAINT "DeviceSourceHealth_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryJob" ADD CONSTRAINT "DiscoveryJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryResult" ADD CONSTRAINT "DiscoveryResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "DiscoveryJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
