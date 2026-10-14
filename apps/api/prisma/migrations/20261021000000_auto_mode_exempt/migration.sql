-- AUTO-ALL: excecao manual do modo AUTO derivado da DESCRIPTION.
--
-- Aditiva e reversivel: coluna NOT NULL com default `false`. Perfis existentes
-- ficam sem excecao (o sweep pode promove-los quando a flag estiver ligada).
-- `true` = o operador fixou ALERT_ONLY para este perfil: o sweep nunca promove
-- e devolve AUTO -> ALERT_ONLY (sem tocar runtime/mitigacao).
--
-- Rollback manual (com autorizacao): ALTER TABLE ... DROP COLUMN "autoModeExempt".

ALTER TABLE "BgpMitigationProfile"
  ADD COLUMN "autoModeExempt" BOOLEAN NOT NULL DEFAULT false;
