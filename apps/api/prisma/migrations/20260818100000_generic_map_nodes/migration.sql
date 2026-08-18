-- Additive migration: adds explicit support for conceptual (non-host) map nodes.
-- MapNode.deviceId becomes optional; generic nodes carry nodeKind/genericType/label.
-- Link endpoints become nullable and gain optional node references.
-- No existing row, column or data is removed or rewritten.

CREATE TYPE "NodeKind" AS ENUM ('DEVICE', 'GENERIC');

ALTER TABLE "MapNode" ALTER COLUMN "deviceId" DROP NOT NULL;
ALTER TABLE "MapNode" ADD COLUMN "nodeKind" "NodeKind" NOT NULL DEFAULT 'DEVICE';
ALTER TABLE "MapNode" ADD COLUMN "genericType" TEXT;
ALTER TABLE "MapNode" ADD COLUMN "label" TEXT;

ALTER TABLE "Link" ALTER COLUMN "sourceDeviceId" DROP NOT NULL;
ALTER TABLE "Link" ALTER COLUMN "sourceInterfaceId" DROP NOT NULL;
ALTER TABLE "Link" ALTER COLUMN "targetDeviceId" DROP NOT NULL;
ALTER TABLE "Link" ALTER COLUMN "targetInterfaceId" DROP NOT NULL;
ALTER TABLE "Link" ADD COLUMN "sourceNodeId" TEXT;
ALTER TABLE "Link" ADD COLUMN "targetNodeId" TEXT;

CREATE INDEX "Link_sourceNodeId_idx" ON "Link"("sourceNodeId");
CREATE INDEX "Link_targetNodeId_idx" ON "Link"("targetNodeId");

ALTER TABLE "Link" ADD CONSTRAINT "Link_sourceNodeId_fkey" FOREIGN KEY ("sourceNodeId") REFERENCES "MapNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Link" ADD CONSTRAINT "Link_targetNodeId_fkey" FOREIGN KEY ("targetNodeId") REFERENCES "MapNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
