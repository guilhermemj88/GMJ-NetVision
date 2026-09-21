-- BGP dual-stack, local ASN per device/context and administrative state.
--
-- Existing peers stay attached to the same BgpPeer row (and therefore to their
-- BgpPeerSample/BgpPeerStateEvent history): addressFamily defaults to IPV4 and
-- adminState starts as UNKNOWN because no read-back ever confirmed it.

CREATE TYPE "BgpAddressFamily" AS ENUM ('IPV4', 'IPV6');
CREATE TYPE "BgpAdminState" AS ENUM ('UNKNOWN', 'ENABLED', 'IGNORED');
CREATE TYPE "BgpAdminAction" AS ENUM ('DISABLE', 'ENABLE');

ALTER TABLE "Device" ADD COLUMN "bgpLocalAs" BIGINT;

ALTER TABLE "BgpPeer"
  ADD COLUMN "addressFamily" "BgpAddressFamily" NOT NULL DEFAULT 'IPV4',
  ADD COLUMN "adminState" "BgpAdminState" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "adminStateCheckedAt" TIMESTAMP(3);

-- Every peer persisted before this migration came from the IPv4-only parser;
-- the LIKE is only a defensive reclassification for manually seeded rows.
UPDATE "BgpPeer" SET "addressFamily" = 'IPV6' WHERE "peerAddress" LIKE '%:%';

CREATE INDEX "BgpPeer_addressFamily_idx" ON "BgpPeer"("addressFamily");

CREATE TABLE "BgpAdminActionLog" (
  "id" TEXT NOT NULL,
  "bgpPeerId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "userId" TEXT,
  "username" TEXT,
  "peerAddress" TEXT NOT NULL,
  "addressFamily" "BgpAddressFamily" NOT NULL,
  "localAs" BIGINT,
  "remoteAs" BIGINT,
  "action" "BgpAdminAction" NOT NULL,
  "success" BOOLEAN NOT NULL DEFAULT false,
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "errorSafe" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "BgpAdminActionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BgpAdminActionLog_bgpPeerId_startedAt_idx" ON "BgpAdminActionLog"("bgpPeerId", "startedAt");
CREATE INDEX "BgpAdminActionLog_deviceId_startedAt_idx" ON "BgpAdminActionLog"("deviceId", "startedAt");

ALTER TABLE "BgpAdminActionLog"
  ADD CONSTRAINT "BgpAdminActionLog_bgpPeerId_fkey"
  FOREIGN KEY ("bgpPeerId") REFERENCES "BgpPeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
