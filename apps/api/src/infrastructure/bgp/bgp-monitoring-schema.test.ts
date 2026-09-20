import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(
  new URL('../../../prisma/schema.prisma', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL(
    '../../../prisma/migrations/20260919000000_add_bgp_monitoring/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('BGP monitoring device flag schema', () => {
  it('defaults Device.bgpMonitoringEnabled to false', () => {
    expect(schema).toMatch(/bgpMonitoringEnabled\s+Boolean\s+@default\(false\)/);
  });

  it('keeps BgpPeer.monitoringEnabled independent with its own default true', () => {
    expect(schema).toMatch(/monitoringEnabled\s+Boolean\s+@default\(true\)/);
    expect(schema).toMatch(/bgpMonitoringEnabled\s+Boolean\s+@default\(false\)/);
  });

  it('adds the device column with default false in the BGP migration', () => {
    expect(migration).toContain(
      'ALTER TABLE "Device" ADD COLUMN "bgpMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false;',
    );
  });
});
