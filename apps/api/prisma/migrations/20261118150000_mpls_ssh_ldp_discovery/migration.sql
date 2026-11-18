-- Descoberta VSI/VPLS por SSH (LDP incluido), estado explicito e evidencias.
--
-- `MIB vazia != ausencia de servico`: a partir desta migration o equipamento
-- guarda o RESULTADO da descoberta (FOUND_*/NOT_FOUND/INCOMPLETE/UNSUPPORTED/
-- CONFLICT), as fontes consultadas, as sessoes LDP e as divergencias SNMP x SSH.

-- Postgres nao aceita ADD VALUE dentro de transacao em versoes antigas; o
-- Prisma roda as migrations fora de transacao implicita, e o IF NOT EXISTS
-- torna a execucao idempotente.
ALTER TYPE "MplsSource" ADD VALUE IF NOT EXISTS 'SSH';

CREATE TYPE "MplsDiscoveryState" AS ENUM (
  'UNKNOWN',
  'FOUND_UP',
  'FOUND_DOWN',
  'FOUND_MIXED',
  'NOT_FOUND',
  'INCOMPLETE',
  'UNSUPPORTED',
  'CONFLICT'
);

ALTER TABLE "MplsDeviceState"
  ADD COLUMN "discoveryState" "MplsDiscoveryState" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "sources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ldpPeers" JSONB,
  ADD COLUMN "conflicts" JSONB;

-- Descoberta de membros (STATIC/DYNAMIC) observada na CLI, quando o VRP a expoe.
ALTER TABLE "MplsVsi" ADD COLUMN "memberDiscovery" TEXT;
