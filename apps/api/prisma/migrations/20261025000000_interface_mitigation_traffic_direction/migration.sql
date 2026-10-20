-- AUTO-ALL direcao por INTERFACE (heranca para perfis e para descobertas futuras).
--
-- Aditiva e reversivel: coluna NULLABLE, sem default. Sem direcao na interface,
-- a resolucao cai no comportamento anterior (perfil > ENV > indefinida =
-- TELEMETRY_UNAVAILABLE, fail-closed).
--
-- Precedencia (documentada e testada):
--   1. BgpMitigationProfile.autoTrafficDirection (override explicito do perfil)
--   2. MITIGATION_AUTO_TRAFFIC_DIRECTIONS (ENV legado, preservado)
--   3. Interface.mitigationTrafficDirection (heranca)
--   4. NULL -> telemetria indisponivel
--
-- ROLLBACK OPERACIONAL: NAO remover a coluna. A reversao padrao e de FLAGS e
-- CODIGO (o build anterior ignora colunas extras e o schema continua compativel),
-- preservando todos os dados. A coluna e NULLABLE e sem default: sem direcao
-- configurada, o comportamento e identico ao anterior (fail-closed). Remover a
-- coluna e operacao excepcional, com autorizacao propria, backup verificado e
-- confirmacao previa de que nenhum processo (motor, rotas, UI) a utiliza.

ALTER TABLE "Interface"
  ADD COLUMN "mitigationTrafficDirection" "BgpMitigationTrafficDirection";
