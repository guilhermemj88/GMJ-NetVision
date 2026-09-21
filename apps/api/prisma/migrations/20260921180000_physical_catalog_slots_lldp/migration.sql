-- CreateEnum
CREATE TYPE "PhysicalTemplateOrigin" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PhysicalPortRole" AS ENUM ('TEMPLATE', 'DISCOVERED', 'MANUAL');

-- AlterTable
ALTER TABLE "PhysicalEquipmentTemplate" ADD COLUMN     "catalogKey" TEXT,
ADD COLUMN     "category" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "family" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "origin" "PhysicalTemplateOrigin" NOT NULL DEFAULT 'CUSTOM',
ADD COLUMN     "referenceUrl" TEXT,
ADD COLUMN     "structureConfirmed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PhysicalPort" ADD COLUMN     "moduleId" TEXT,
ADD COLUMN     "role" "PhysicalPortRole" NOT NULL DEFAULT 'TEMPLATE',
ADD COLUMN     "slotId" TEXT;

-- CreateTable
CREATE TABLE "PhysicalTemplateSlot" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhysicalTemplateSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalTemplateSlotModule" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "moduleTemplateId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PhysicalTemplateSlotModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalModuleTemplate" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "catalogKey" TEXT,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "slotsRequired" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhysicalModuleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalModuleTemplatePort" (
    "id" TEXT NOT NULL,
    "moduleTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL,
    "type" "PhysicalPortType" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhysicalModuleTemplatePort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalSlot" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhysicalSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalModule" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "moduleTemplateId" TEXT,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "serial" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhysicalModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalLldpAdjacency" (
    "id" TEXT NOT NULL,
    "localDeviceId" TEXT NOT NULL,
    "localInterfaceId" TEXT,
    "localPortName" TEXT NOT NULL,
    "remoteDeviceId" TEXT,
    "remoteHostname" TEXT NOT NULL,
    "remotePortName" TEXT NOT NULL,
    "remoteInterfaceId" TEXT,
    "remoteChassisId" TEXT,
    "confidence" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhysicalLldpAdjacency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhysicalTemplateSlot_templateId_idx" ON "PhysicalTemplateSlot"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalTemplateSlot_templateId_index_key" ON "PhysicalTemplateSlot"("templateId", "index");

-- CreateIndex
CREATE INDEX "PhysicalTemplateSlotModule_moduleTemplateId_idx" ON "PhysicalTemplateSlotModule"("moduleTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalTemplateSlotModule_slotId_moduleTemplateId_key" ON "PhysicalTemplateSlotModule"("slotId", "moduleTemplateId");

-- CreateIndex
CREATE INDEX "PhysicalModuleTemplate_templateId_idx" ON "PhysicalModuleTemplate"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalModuleTemplate_templateId_name_key" ON "PhysicalModuleTemplate"("templateId", "name");

-- CreateIndex
CREATE INDEX "PhysicalModuleTemplatePort_moduleTemplateId_idx" ON "PhysicalModuleTemplatePort"("moduleTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalModuleTemplatePort_moduleTemplateId_name_key" ON "PhysicalModuleTemplatePort"("moduleTemplateId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalModuleTemplatePort_moduleTemplateId_sortOrder_key" ON "PhysicalModuleTemplatePort"("moduleTemplateId", "sortOrder");

-- CreateIndex
CREATE INDEX "PhysicalSlot_assetId_idx" ON "PhysicalSlot"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalSlot_assetId_index_key" ON "PhysicalSlot"("assetId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalModule_slotId_key" ON "PhysicalModule"("slotId");

-- CreateIndex
CREATE INDEX "PhysicalModule_assetId_idx" ON "PhysicalModule"("assetId");

-- CreateIndex
CREATE INDEX "PhysicalModule_moduleTemplateId_idx" ON "PhysicalModule"("moduleTemplateId");

-- CreateIndex
CREATE INDEX "PhysicalLldpAdjacency_localInterfaceId_idx" ON "PhysicalLldpAdjacency"("localInterfaceId");

-- CreateIndex
CREATE INDEX "PhysicalLldpAdjacency_remoteDeviceId_idx" ON "PhysicalLldpAdjacency"("remoteDeviceId");

-- CreateIndex
CREATE INDEX "PhysicalLldpAdjacency_observedAt_idx" ON "PhysicalLldpAdjacency"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalLldpAdjacency_localDeviceId_localPortName_remoteHos_key" ON "PhysicalLldpAdjacency"("localDeviceId", "localPortName", "remoteHostname", "remotePortName");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalEquipmentTemplate_catalogKey_key" ON "PhysicalEquipmentTemplate"("catalogKey");

-- CreateIndex
CREATE INDEX "PhysicalEquipmentTemplate_category_idx" ON "PhysicalEquipmentTemplate"("category");

-- CreateIndex
CREATE INDEX "PhysicalEquipmentTemplate_manufacturer_idx" ON "PhysicalEquipmentTemplate"("manufacturer");

-- CreateIndex
CREATE INDEX "PhysicalEquipmentTemplate_origin_idx" ON "PhysicalEquipmentTemplate"("origin");

-- CreateIndex
CREATE INDEX "PhysicalPort_slotId_idx" ON "PhysicalPort"("slotId");

-- CreateIndex
CREATE INDEX "PhysicalPort_moduleId_idx" ON "PhysicalPort"("moduleId");

-- AddForeignKey
ALTER TABLE "PhysicalTemplateSlot" ADD CONSTRAINT "PhysicalTemplateSlot_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PhysicalEquipmentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalTemplateSlotModule" ADD CONSTRAINT "PhysicalTemplateSlotModule_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "PhysicalTemplateSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalTemplateSlotModule" ADD CONSTRAINT "PhysicalTemplateSlotModule_moduleTemplateId_fkey" FOREIGN KEY ("moduleTemplateId") REFERENCES "PhysicalModuleTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalModuleTemplate" ADD CONSTRAINT "PhysicalModuleTemplate_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PhysicalEquipmentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalModuleTemplatePort" ADD CONSTRAINT "PhysicalModuleTemplatePort_moduleTemplateId_fkey" FOREIGN KEY ("moduleTemplateId") REFERENCES "PhysicalModuleTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalSlot" ADD CONSTRAINT "PhysicalSlot_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PhysicalAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalModule" ADD CONSTRAINT "PhysicalModule_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PhysicalAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalModule" ADD CONSTRAINT "PhysicalModule_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "PhysicalSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalModule" ADD CONSTRAINT "PhysicalModule_moduleTemplateId_fkey" FOREIGN KEY ("moduleTemplateId") REFERENCES "PhysicalModuleTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalPort" ADD CONSTRAINT "PhysicalPort_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "PhysicalSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalPort" ADD CONSTRAINT "PhysicalPort_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "PhysicalModule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
