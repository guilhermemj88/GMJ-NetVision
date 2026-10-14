-- AUTO-ALL: proveniencia do modo AUTO (promovido pelo sweep da DESCRIPTION).
--
-- Aditiva e reversivel: coluna NOT NULL com default `false`. Registros
-- existentes ficam `false` = AUTO manual/legado (ex.: BHNET-3043), que NUNCA e
-- pausado pelo controle de execucao.
--
-- Uso: o motor so recusa NOVAS ativacoes de perfis com `autoPromotedBySweep`
-- quando `MITIGATION_AUTO_EXECUTION_ENABLED=0`; mitigacoes ja ativas e o AUTO
-- manual permanecem intactos.
--
-- Rollback manual (com autorizacao): ALTER TABLE ... DROP COLUMN "autoPromotedBySweep".

ALTER TABLE "BgpMitigationProfile"
  ADD COLUMN "autoPromotedBySweep" BOOLEAN NOT NULL DEFAULT false;
