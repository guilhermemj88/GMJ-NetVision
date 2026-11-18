-- BGP Juniper: AS local POR PEER.
-- Um mesmo MX usa local-as diferente por grupo/vizinho (comprovado em
-- VIANET-OUROPRETO com 52575 e 265185), então `Device.bgpLocalAs` não basta.
-- ADITIVA: coluna anulável, sem default e sem reescrever linhas existentes.
-- Huawei continua usando `Device.bgpLocalAs`; o dashboard faz
-- peer.localAs ?? device.bgpLocalAs.
ALTER TABLE "BgpPeer" ADD COLUMN "localAs" BIGINT;
