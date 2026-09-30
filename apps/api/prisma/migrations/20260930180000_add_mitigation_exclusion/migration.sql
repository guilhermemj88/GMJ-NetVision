-- Fase 13 - exclusao permanente de peers/targets da mitigacao DDoS.
--
-- ADITIVA: um enum novo e tres colunas novas em BgpMitigationProfile.
-- `mitigationExcluded` nasce false, portanto TODOS os perfis existentes
-- continuam permitidos (comportamento anterior preservado). Nenhum DROP,
-- nenhum DELETE, nenhum reset.

-- CreateEnum
CREATE TYPE "BgpMitigationExclusionReason" AS ENUM ('UPLINK', 'TRANSIT', 'IX', 'BACKBONE', 'MANUAL');

-- AlterTable
ALTER TABLE "BgpMitigationProfile"
  ADD COLUMN "mitigationExcluded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mitigationExclusionReason" "BgpMitigationExclusionReason",
  ADD COLUMN "mitigationExclusionNote" TEXT;
