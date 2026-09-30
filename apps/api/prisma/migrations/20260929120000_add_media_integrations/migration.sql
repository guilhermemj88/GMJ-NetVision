-- Fase 9 - Central de Midias / Integracoes (camada de notificacao).
--
-- Aditiva: cria apenas tabelas novas. Nenhuma tabela existente e alterada.
-- NAO aplicada em producao: preparada para o preview/validacao da Fase 9.

-- CreateEnum
CREATE TYPE "MediaIntegrationType" AS ENUM ('WEBHOOK');

-- CreateEnum
CREATE TYPE "MediaIntegrationPurpose" AS ENUM ('BGP_MITIGATION');

-- CreateEnum
CREATE TYPE "MediaDeliveryDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MediaDeliveryStatus" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "MediaIntegration" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "MediaIntegrationType" NOT NULL DEFAULT 'WEBHOOK',
    "purpose" "MediaIntegrationPurpose" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "outboundUrl" TEXT,
    "outboundSecretEncrypted" BYTEA,
    "inboundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "inboundSecretEncrypted" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastOutboundAttemptAt" TIMESTAMP(3),
    "lastOutboundSuccessAt" TIMESTAMP(3),
    "lastOutboundFailureAt" TIMESTAMP(3),
    "lastOutboundStatusCode" INTEGER,
    "lastOutboundLatencyMs" INTEGER,
    "lastOutboundEvent" TEXT,
    "lastOutboundErrorSafe" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastInboundAction" TEXT,
    "lastInboundStatus" TEXT,
    "lastInboundRequestId" TEXT,
    "lastInboundErrorSafe" TEXT,

    CONSTRAINT "MediaIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaDeliveryLog" (
    "id" TEXT NOT NULL,
    "mediaIntegrationId" TEXT,
    "direction" "MediaDeliveryDirection" NOT NULL,
    "event" TEXT,
    "action" TEXT,
    "profileId" TEXT,
    "requestId" TEXT,
    "status" "MediaDeliveryStatus" NOT NULL,
    "httpStatus" INTEGER,
    "latencyMs" INTEGER,
    "idempotent" BOOLEAN,
    "safeError" TEXT,
    "destination" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaIntegration_type_purpose_key" ON "MediaIntegration"("type", "purpose");

-- CreateIndex
CREATE INDEX "MediaIntegration_purpose_enabled_idx" ON "MediaIntegration"("purpose", "enabled");

-- CreateIndex
CREATE INDEX "MediaDeliveryLog_mediaIntegrationId_createdAt_idx" ON "MediaDeliveryLog"("mediaIntegrationId", "createdAt");

-- CreateIndex
CREATE INDEX "MediaDeliveryLog_direction_createdAt_idx" ON "MediaDeliveryLog"("direction", "createdAt");

-- CreateIndex
CREATE INDEX "MediaDeliveryLog_profileId_createdAt_idx" ON "MediaDeliveryLog"("profileId", "createdAt");

-- AddForeignKey
ALTER TABLE "MediaDeliveryLog" ADD CONSTRAINT "MediaDeliveryLog_mediaIntegrationId_fkey" FOREIGN KEY ("mediaIntegrationId") REFERENCES "MediaIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
