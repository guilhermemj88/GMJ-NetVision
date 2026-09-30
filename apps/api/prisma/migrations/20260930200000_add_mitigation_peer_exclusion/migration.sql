-- Exclusao PREVENTIVA da mitigacao DDoS por PEER BGP ("nunca mitigar este peer").
-- Migration ADITIVA: cria apenas uma tabela nova, nao altera nem remove dados.
-- Depende do enum "BgpMitigationExclusionReason" (criado em
-- 20260930180000_add_mitigation_exclusion) e de BgpPeer.id.
CREATE TABLE "BgpMitigationPeerExclusion" (
    "id" TEXT NOT NULL,
    "bgpPeerId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "peerAddress" TEXT NOT NULL,
    "addressFamily" "BgpAddressFamily" NOT NULL DEFAULT 'IPV4',
    "interfaceId" TEXT,
    "reason" "BgpMitigationExclusionReason" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BgpMitigationPeerExclusion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BgpMitigationPeerExclusion_bgpPeerId_key" ON "BgpMitigationPeerExclusion"("bgpPeerId");
CREATE INDEX "BgpMitigationPeerExclusion_deviceId_idx" ON "BgpMitigationPeerExclusion"("deviceId");
CREATE INDEX "BgpMitigationPeerExclusion_peerAddress_idx" ON "BgpMitigationPeerExclusion"("peerAddress");
CREATE INDEX "BgpMitigationPeerExclusion_interfaceId_idx" ON "BgpMitigationPeerExclusion"("interfaceId");

ALTER TABLE "BgpMitigationPeerExclusion" ADD CONSTRAINT "BgpMitigationPeerExclusion_bgpPeerId_fkey" FOREIGN KEY ("bgpPeerId") REFERENCES "BgpPeer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
