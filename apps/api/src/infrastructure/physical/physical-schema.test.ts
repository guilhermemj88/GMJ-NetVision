import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260921150000_physical_pop_rack/migration.sql'),
  'utf8',
);

describe('physical inventory persistence schema', () => {
  it('links physical assets and ports to authoritative Device and Interface records', () => {
    // Whitespace-insensitive: `prisma format` realigns columns, so the intent is
    // the optional relation/column, not its padding.
    expect(schema).toMatch(/^\s*device\s+Device\?/m);
    expect(schema).toMatch(/^\s*mappedInterface\s+Interface\?/m);
    expect(schema).toMatch(/^\s*deviceId\s+String\?/m);
    expect(schema).toMatch(/^\s*mappedInterfaceId\s+String\?/m);
  });

  it('stores cable occupancy on ports and limits each connection to A/B endpoints', () => {
    expect(schema).toMatch(/^\s*connectionId\s+String\?/m);
    expect(schema).toMatch(/@@unique\(\[connectionId, connectionEnd\]\)/);
    expect(migration).toContain('"PhysicalPort_connection_pair_check"');
  });

  it('enforces rack bounds and overlap in PostgreSQL as well as in the service', () => {
    expect(migration).toContain('validate_physical_asset_placement');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('physical asset rack units overlap');
  });

  it('detaches both endpoint columns when a cable row is deleted', () => {
    // The pair check requires connectionId and connectionEnd to be NULL together,
    // so the FK ON DELETE SET NULL alone cannot release an endpoint.
    expect(migration).toContain('detach_physical_connection_endpoints');
    expect(migration).toMatch(
      /UPDATE "PhysicalPort"\s+SET "connectionId" = NULL, "connectionEnd" = NULL/s,
    );
    expect(migration).toContain('BEFORE DELETE ON "PhysicalConnection"');
    expect(migration).toContain('AFTER DELETE ON "PhysicalPort"');
  });
});
