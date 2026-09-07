CREATE TYPE "LinkLayoutMode" AS ENUM ('AUTO', 'MANUAL');

ALTER TABLE "Link"
  ADD COLUMN "linkLayoutMode" "LinkLayoutMode" NOT NULL DEFAULT 'AUTO';
