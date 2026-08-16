CREATE TABLE "DeviceMetricSample" (
  "id" BIGSERIAL NOT NULL,
  "deviceId" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uptimeSeconds" BIGINT,
  "sysName" TEXT,
  "sysDescr" TEXT,
  "sysObjectId" TEXT,
  CONSTRAINT "DeviceMetricSample_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterfaceMetricSample" (
  "id" BIGSERIAL NOT NULL,
  "interfaceId" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inOctets" BIGINT NOT NULL,
  "outOctets" BIGINT NOT NULL,
  "rxBps" DOUBLE PRECISION NOT NULL,
  "txBps" DOUBLE PRECISION NOT NULL,
  "inErrors" BIGINT NOT NULL DEFAULT 0,
  "outErrors" BIGINT NOT NULL DEFAULT 0,
  "inDiscards" BIGINT NOT NULL DEFAULT 0,
  "outDiscards" BIGINT NOT NULL DEFAULT 0,
  "operStatus" "InterfaceStatus" NOT NULL DEFAULT 'UNKNOWN',
  CONSTRAINT "InterfaceMetricSample_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DeviceMetricSample_deviceId_timestamp_idx"
  ON "DeviceMetricSample"("deviceId", "timestamp");
CREATE INDEX "InterfaceMetricSample_interfaceId_timestamp_idx"
  ON "InterfaceMetricSample"("interfaceId", "timestamp");

ALTER TABLE "DeviceMetricSample"
  ADD CONSTRAINT "DeviceMetricSample_deviceId_fkey"
  FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InterfaceMetricSample"
  ADD CONSTRAINT "InterfaceMetricSample_interfaceId_fkey"
  FOREIGN KEY ("interfaceId") REFERENCES "Interface"("id") ON DELETE CASCADE ON UPDATE CASCADE;
