-- AUTO-ALL-PREP-1: direcao de telemetria do motor AUTO, POR PERFIL.
--
-- Aditiva e reversivel: coluna NULLABLE, sem default. Perfis existentes ficam
-- com direcao NAO configurada (fail-closed: TELEMETRY_UNAVAILABLE). O ENV
-- MITIGATION_AUTO_TRAFFIC_DIRECTIONS continua valendo como FALLBACK, o que
-- preserva o AUTO atual (BHNET-CEASA) exatamente como esta hoje.
--
-- Rollback manual (com autorizacao): DROP COLUMN + DROP TYPE.

CREATE TYPE "BgpMitigationTrafficDirection" AS ENUM ('RX', 'TX');

ALTER TABLE "BgpMitigationProfile"
  ADD COLUMN "autoTrafficDirection" "BgpMitigationTrafficDirection";