-- Per-end manual connection sides. Additive and safe for existing rows: every
-- current link keeps the automatic (position based) routing it already renders.
CREATE TYPE "LinkHandleSide" AS ENUM ('AUTO', 'TOP', 'RIGHT', 'BOTTOM', 'LEFT');

ALTER TABLE "Link"
  ADD COLUMN "sourceHandleSide" "LinkHandleSide" NOT NULL DEFAULT 'AUTO',
  ADD COLUMN "targetHandleSide" "LinkHandleSide" NOT NULL DEFAULT 'AUTO';
