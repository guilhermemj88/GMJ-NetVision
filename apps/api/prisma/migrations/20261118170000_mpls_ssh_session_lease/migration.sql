-- P6 (2a auditoria): orcamento de sessoes SSH do MPLS compartilhado entre
-- processos. Tabela aditiva, sem relacao com Device (o log sobrevive a
-- remocao do equipamento e serve de trilha de auditoria).
--
-- Linhas com `finishedAt` NULL e `startedAt` antigo sao tratadas como expiradas
-- pela janela de staleness do processo (equipamento/processo morto no meio da
-- leitura nao bloqueia o orcamento para sempre).
CREATE TABLE "MplsSshSessionLog" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MplsSshSessionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MplsSshSessionLog_startedAt_idx" ON "MplsSshSessionLog"("startedAt");
CREATE INDEX "MplsSshSessionLog_hostId_startedAt_idx" ON "MplsSshSessionLog"("hostId", "startedAt");
