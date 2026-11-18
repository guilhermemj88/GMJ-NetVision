-- A1 (auditoria independente): o fallback CLI (SSH) do modulo MPLS passa a
-- exigir habilitacao EXPLICITA por equipamento.
--
-- Aditiva e segura: as linhas existentes ficam com `false`, ou seja, o fallback
-- permanece DESLIGADO ate o operador autorizar equipamento por equipamento.
-- Nenhuma coleta SNMP muda de comportamento; nenhum dado e removido.
ALTER TABLE "MplsDeviceState" ADD COLUMN "sshFallbackEnabled" BOOLEAN NOT NULL DEFAULT false;
