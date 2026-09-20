CREATE TYPE "BgpPeerRole" AS ENUM ('UPSTREAM', 'PEER', 'OTHER');
CREATE TYPE "BgpState" AS ENUM ('IDLE', 'CONNECT', 'ACTIVE', 'OPENSENT', 'OPENCONFIRM', 'ESTABLISHED', 'UNKNOWN');

CREATE TABLE "BgpPeer" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "peerAddress" TEXT NOT NULL,
  "remoteAs" BIGINT,
  "interfaceId" TEXT,
  "monitoringEnabled" BOOLEAN NOT NULL DEFAULT true,
  "role" "BgpPeerRole" NOT NULL DEFAULT 'OTHER',
  "stateCode" INTEGER NOT NULL DEFAULT 0,
  "state" "BgpState" NOT NULL DEFAULT 'UNKNOWN',
  "established" BOOLEAN NOT NULL DEFAULT false,
  "receivedPrefixes" BIGINT,
  "establishedSince" TIMESTAMP(3),
  "lastStateChangedAt" TIMESTAMP(3),
  "lastPollingAt" TIMESTAMP(3),
  "lastDiscoveryAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BgpPeer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BgpPeerSample" (
  "id" BIGSERIAL NOT NULL,
  "bgpPeerId" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stateCode" INTEGER NOT NULL,
  "state" "BgpState" NOT NULL,
  "established" BOOLEAN NOT NULL,
  "receivedPrefixes" BIGINT,
  CONSTRAINT "BgpPeerSample_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BgpPeerStateEvent" (
  "id" BIGSERIAL NOT NULL,
  "bgpPeerId" TEXT NOT NULL,
  "previousStateCode" INTEGER NOT NULL,
  "previousState" "BgpState" NOT NULL,
  "currentStateCode" INTEGER NOT NULL,
  "currentState" "BgpState" NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BgpPeerStateEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BgpPeer_deviceId_peerAddress_key" ON "BgpPeer"("deviceId", "peerAddress");
CREATE INDEX "BgpPeer_deviceId_established_idx" ON "BgpPeer"("deviceId", "established");
CREATE INDEX "BgpPeer_interfaceId_idx" ON "BgpPeer"("interfaceId");
CREATE INDEX "BgpPeer_role_idx" ON "BgpPeer"("role");
CREATE INDEX "BgpPeerSample_bgpPeerId_timestamp_idx" ON "BgpPeerSample"("bgpPeerId", "timestamp");
CREATE INDEX "BgpPeerStateEvent_bgpPeerId_occurredAt_idx" ON "BgpPeerStateEvent"("bgpPeerId", "occurredAt");

ALTER TABLE "BgpPeer" ADD CONSTRAINT "BgpPeer_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BgpPeer" ADD CONSTRAINT "BgpPeer_interfaceId_fkey"
  FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BgpPeerSample" ADD CONSTRAINT "BgpPeerSample_bgpPeerId_fkey"
  FOREIGN KEY ("bgpPeerId") REFERENCES "BgpPeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BgpPeerStateEvent" ADD CONSTRAINT "BgpPeerStateEvent_bgpPeerId_fkey"
  FOREIGN KEY ("bgpPeerId") REFERENCES "BgpPeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Device" ADD COLUMN "bgpMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false;
