-- Fase 12 - par de nodes da mitigacao (BOGONS deny + PREFIX8to24 permit/RT).
--
-- Aditiva: apenas duas colunas novas e nulaveis em BgpMitigationRuntime.
-- NAO aplicada (junto da migration 20260929000000, que tambem segue pendente).

ALTER TABLE "BgpMitigationRuntime"
  ADD COLUMN "plannedBogonNode" INTEGER,
  ADD COLUMN "plannedMitigationNode" INTEGER;
