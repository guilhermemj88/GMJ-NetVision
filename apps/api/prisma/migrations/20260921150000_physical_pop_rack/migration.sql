-- Physical POP/rack inventory. Device and Interface remain the authoritative
-- monitored entities; this schema only adds physical placement and cabling.
CREATE TYPE "PhysicalAssetKind" AS ENUM ('NETWORK', 'SERVER', 'OLT', 'DIO', 'PATCH_PANEL', 'POWER', 'GENERIC');
CREATE TYPE "PhysicalPortSide" AS ENUM ('DEVICE', 'FRONT', 'REAR');
CREATE TYPE "PhysicalPortType" AS ENUM ('RJ45', 'SFP', 'SFP_PLUS', 'QSFP', 'FIBER', 'POWER', 'OTHER');
CREATE TYPE "PhysicalConnectionMedium" AS ENUM ('FIBER', 'COPPER', 'DAC', 'AOC', 'UNKNOWN');
CREATE TYPE "PhysicalConnectionEnd" AS ENUM ('A', 'B');

CREATE TABLE "PhysicalSite" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "description" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PhysicalSite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PhysicalRack" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "units" INTEGER NOT NULL DEFAULT 42,
  "description" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PhysicalRack_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PhysicalRack_units_check" CHECK ("units" BETWEEN 1 AND 100)
);

CREATE TABLE "PhysicalEquipmentTemplate" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "manufacturer" TEXT NOT NULL DEFAULT '',
  "model" TEXT NOT NULL DEFAULT '',
  "kind" "PhysicalAssetKind" NOT NULL DEFAULT 'GENERIC',
  "heightU" INTEGER NOT NULL DEFAULT 1,
  "description" TEXT NOT NULL DEFAULT '',
  "vendorVerified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PhysicalEquipmentTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PhysicalEquipmentTemplate_heightU_check" CHECK ("heightU" BETWEEN 1 AND 100)
);

CREATE TABLE "PhysicalTemplatePort" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL,
  "side" "PhysicalPortSide" NOT NULL DEFAULT 'DEVICE',
  "type" "PhysicalPortType" NOT NULL DEFAULT 'OTHER',
  "pairedTemplatePortId" TEXT,
  CONSTRAINT "PhysicalTemplatePort_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PhysicalTemplatePort_sortOrder_check" CHECK ("sortOrder" >= 0),
  CONSTRAINT "PhysicalTemplatePort_not_self_paired" CHECK ("pairedTemplatePortId" IS NULL OR "pairedTemplatePortId" <> "id")
);

CREATE TABLE "PhysicalAsset" (
  "id" TEXT NOT NULL,
  "rackId" TEXT NOT NULL,
  "deviceId" TEXT,
  "templateId" TEXT,
  "name" TEXT NOT NULL,
  "kind" "PhysicalAssetKind" NOT NULL DEFAULT 'GENERIC',
  "startU" INTEGER NOT NULL,
  "heightU" INTEGER NOT NULL DEFAULT 1,
  "description" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PhysicalAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PhysicalAsset_startU_check" CHECK ("startU" >= 1),
  CONSTRAINT "PhysicalAsset_heightU_check" CHECK ("heightU" >= 1)
);

CREATE TABLE "PhysicalConnection" (
  "id" TEXT NOT NULL,
  "medium" "PhysicalConnectionMedium" NOT NULL DEFAULT 'UNKNOWN',
  "label" TEXT NOT NULL DEFAULT '',
  "notes" TEXT NOT NULL DEFAULT '',
  "lengthMeters" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PhysicalConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PhysicalConnection_lengthMeters_check" CHECK ("lengthMeters" IS NULL OR "lengthMeters" >= 0)
);

CREATE TABLE "PhysicalPort" (
  "id" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "templatePortId" TEXT,
  "mappedInterfaceId" TEXT,
  "connectionId" TEXT,
  "connectionEnd" "PhysicalConnectionEnd",
  "pairedPortId" TEXT,
  "name" TEXT NOT NULL,
  "label" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL,
  "side" "PhysicalPortSide" NOT NULL DEFAULT 'DEVICE',
  "type" "PhysicalPortType" NOT NULL DEFAULT 'OTHER',
  "notes" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PhysicalPort_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PhysicalPort_sortOrder_check" CHECK ("sortOrder" >= 0),
  CONSTRAINT "PhysicalPort_not_self_paired" CHECK ("pairedPortId" IS NULL OR "pairedPortId" <> "id"),
  CONSTRAINT "PhysicalPort_connection_pair_check" CHECK (("connectionId" IS NULL) = ("connectionEnd" IS NULL))
);

CREATE UNIQUE INDEX "PhysicalSite_code_key" ON "PhysicalSite"("code");
CREATE INDEX "PhysicalSite_name_idx" ON "PhysicalSite"("name");
CREATE UNIQUE INDEX "PhysicalRack_siteId_name_key" ON "PhysicalRack"("siteId", "name");
CREATE INDEX "PhysicalRack_siteId_idx" ON "PhysicalRack"("siteId");
CREATE UNIQUE INDEX "PhysicalEquipmentTemplate_name_key" ON "PhysicalEquipmentTemplate"("name");
CREATE UNIQUE INDEX "PhysicalTemplatePort_pairedTemplatePortId_key" ON "PhysicalTemplatePort"("pairedTemplatePortId");
CREATE UNIQUE INDEX "PhysicalTemplatePort_templateId_side_name_key" ON "PhysicalTemplatePort"("templateId", "side", "name");
CREATE UNIQUE INDEX "PhysicalTemplatePort_templateId_side_sortOrder_key" ON "PhysicalTemplatePort"("templateId", "side", "sortOrder");
CREATE INDEX "PhysicalTemplatePort_templateId_idx" ON "PhysicalTemplatePort"("templateId");
CREATE UNIQUE INDEX "PhysicalAsset_deviceId_key" ON "PhysicalAsset"("deviceId");
CREATE UNIQUE INDEX "PhysicalAsset_rackId_name_key" ON "PhysicalAsset"("rackId", "name");
CREATE INDEX "PhysicalAsset_rackId_startU_idx" ON "PhysicalAsset"("rackId", "startU");
CREATE INDEX "PhysicalAsset_templateId_idx" ON "PhysicalAsset"("templateId");
CREATE UNIQUE INDEX "PhysicalPort_mappedInterfaceId_key" ON "PhysicalPort"("mappedInterfaceId");
CREATE UNIQUE INDEX "PhysicalPort_pairedPortId_key" ON "PhysicalPort"("pairedPortId");
CREATE UNIQUE INDEX "PhysicalPort_assetId_side_name_key" ON "PhysicalPort"("assetId", "side", "name");
CREATE UNIQUE INDEX "PhysicalPort_assetId_side_sortOrder_key" ON "PhysicalPort"("assetId", "side", "sortOrder");
CREATE UNIQUE INDEX "PhysicalPort_connectionId_connectionEnd_key" ON "PhysicalPort"("connectionId", "connectionEnd");
CREATE INDEX "PhysicalPort_assetId_idx" ON "PhysicalPort"("assetId");
CREATE INDEX "PhysicalPort_connectionId_idx" ON "PhysicalPort"("connectionId");
CREATE INDEX "PhysicalPort_templatePortId_idx" ON "PhysicalPort"("templatePortId");

ALTER TABLE "PhysicalRack" ADD CONSTRAINT "PhysicalRack_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PhysicalSite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PhysicalTemplatePort" ADD CONSTRAINT "PhysicalTemplatePort_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PhysicalEquipmentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PhysicalTemplatePort" ADD CONSTRAINT "PhysicalTemplatePort_pairedTemplatePortId_fkey" FOREIGN KEY ("pairedTemplatePortId") REFERENCES "PhysicalTemplatePort"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PhysicalAsset" ADD CONSTRAINT "PhysicalAsset_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "PhysicalRack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PhysicalAsset" ADD CONSTRAINT "PhysicalAsset_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PhysicalAsset" ADD CONSTRAINT "PhysicalAsset_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PhysicalEquipmentTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PhysicalPort" ADD CONSTRAINT "PhysicalPort_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PhysicalAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PhysicalPort" ADD CONSTRAINT "PhysicalPort_templatePortId_fkey" FOREIGN KEY ("templatePortId") REFERENCES "PhysicalTemplatePort"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PhysicalPort" ADD CONSTRAINT "PhysicalPort_mappedInterfaceId_fkey" FOREIGN KEY ("mappedInterfaceId") REFERENCES "Interface"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PhysicalPort" ADD CONSTRAINT "PhysicalPort_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "PhysicalConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PhysicalPort" ADD CONSTRAINT "PhysicalPort_pairedPortId_fkey" FOREIGN KEY ("pairedPortId") REFERENCES "PhysicalPort"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rack placement is a cross-row invariant. The per-rack advisory lock makes
-- concurrent inserts serialize before the bounds/overlap checks run.
CREATE FUNCTION "validate_physical_asset_placement"() RETURNS trigger AS $$
DECLARE
  rack_units INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW."rackId"));
  SELECT "units" INTO rack_units FROM "PhysicalRack" WHERE "id" = NEW."rackId";
  IF NEW."startU" + NEW."heightU" - 1 > rack_units THEN
    RAISE EXCEPTION 'physical asset exceeds rack units' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "PhysicalAsset" existing
    WHERE existing."rackId" = NEW."rackId"
      AND existing."id" <> NEW."id"
      AND int4range(existing."startU", existing."startU" + existing."heightU", '[)')
          && int4range(NEW."startU", NEW."startU" + NEW."heightU", '[)')
  ) THEN
    RAISE EXCEPTION 'physical asset rack units overlap' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PhysicalAsset_validate_placement"
BEFORE INSERT OR UPDATE OF "rackId", "startU", "heightU" ON "PhysicalAsset"
FOR EACH ROW EXECUTE FUNCTION "validate_physical_asset_placement"();

CREATE FUNCTION "validate_physical_rack_resize"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PhysicalAsset" asset
    WHERE asset."rackId" = NEW."id"
      AND asset."startU" + asset."heightU" - 1 > NEW."units"
  ) THEN
    RAISE EXCEPTION 'physical rack resize would truncate an asset' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PhysicalRack_validate_resize"
BEFORE UPDATE OF "units" ON "PhysicalRack"
FOR EACH ROW EXECUTE FUNCTION "validate_physical_rack_resize"();

-- `PhysicalPort.connectionId` is ON DELETE SET NULL, but the pair check
-- requires connectionId and connectionEnd to be NULL together, so the FK action
-- alone cannot detach an endpoint. Releasing both columns before the cable row
-- disappears keeps every deletion path consistent (API, raw SQL and cascades).
CREATE FUNCTION "detach_physical_connection_endpoints"() RETURNS trigger AS $$
BEGIN
  UPDATE "PhysicalPort"
     SET "connectionId" = NULL, "connectionEnd" = NULL
   WHERE "connectionId" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PhysicalConnection_detach_endpoints"
BEFORE DELETE ON "PhysicalConnection"
FOR EACH ROW EXECUTE FUNCTION "detach_physical_connection_endpoints"();

-- Defensive cleanup for deletes outside the API: removing a connected port
-- removes its cable, which detaches the opposite endpoint through the trigger
-- above. Ports without a cable remain untouched.
CREATE FUNCTION "disconnect_physical_port_after_delete"() RETURNS trigger AS $$
BEGIN
  IF OLD."connectionId" IS NOT NULL THEN
    DELETE FROM "PhysicalConnection" WHERE "id" = OLD."connectionId";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PhysicalPort_disconnect_after_delete"
AFTER DELETE ON "PhysicalPort"
FOR EACH ROW EXECUTE FUNCTION "disconnect_physical_port_after_delete"();
