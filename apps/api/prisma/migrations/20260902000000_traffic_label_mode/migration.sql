CREATE TYPE "TrafficLabelMode" AS ENUM ('CARD', 'INLINE', 'HIDDEN');

ALTER TABLE "Map"
  ADD COLUMN "trafficLabelMode" "TrafficLabelMode" NOT NULL DEFAULT 'CARD';
