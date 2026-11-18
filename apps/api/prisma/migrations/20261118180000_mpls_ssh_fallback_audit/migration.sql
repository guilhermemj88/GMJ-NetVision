-- A1-e (3a auditoria): trilha auditavel do opt-in do fallback CLI MPLS.
--
-- Aditiva e sem FK para "Device": a trilha precisa sobreviver a remocao do
-- cadastro (e continuar respondendo "quem alterou, quando e com qual
-- resultado de autorizacao").
CREATE TABLE "MplsSshFallbackAudit" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorUsername" TEXT,
    "previousValue" BOOLEAN NOT NULL,
    "newValue" BOOLEAN NOT NULL,
    "result" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MplsSshFallbackAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MplsSshFallbackAudit_hostId_createdAt_idx" ON "MplsSshFallbackAudit"("hostId", "createdAt");
CREATE INDEX "MplsSshFallbackAudit_createdAt_idx" ON "MplsSshFallbackAudit"("createdAt");
