-- AlterEnum
ALTER TYPE "AlarmType" ADD VALUE 'OPTICAL_RX_DEGRADATION';

-- AlterTable
ALTER TABLE "Interface" ADD COLUMN     "opticalThresholdSource" TEXT,
ADD COLUMN     "opticalThresholds" JSONB,
ADD COLUMN     "opticalThresholdsRefreshAfter" TIMESTAMP(3),
ADD COLUMN     "opticalThresholdsUpdatedAt" TIMESTAMP(3);

