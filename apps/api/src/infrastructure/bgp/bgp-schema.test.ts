import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('BGP persistence schema', () => {
  it('uses a nullable SetNull interface relation and does not persist suggestedUpstream', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const bgpPeer = schema.slice(
      schema.indexOf('model BgpPeer {'),
      schema.indexOf('model BgpPeerSample {'),
    );

    expect(bgpPeer).toContain('interfaceId        String?');
    expect(bgpPeer).toMatch(
      /interface\s+Interface\?\s+@relation\(fields: \[interfaceId\], references: \[id\], onDelete: SetNull\)/,
    );
    expect(bgpPeer).toContain('@@unique([deviceId, peerAddress])');
    expect(bgpPeer).not.toContain('suggestedUpstream');
  });

  it('creates the BGP foreign keys with the requested delete behavior', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'prisma/migrations/20260919000000_add_bgp_monitoring/migration.sql'),
      'utf8',
    );

    expect(migration).toMatch(/BgpPeer_interfaceId_fkey[\s\S]+ON DELETE SET NULL/);
    expect(migration).toMatch(/BgpPeer_deviceId_fkey[\s\S]+ON DELETE CASCADE/);
    expect(migration).toContain('CREATE UNIQUE INDEX "BgpPeer_deviceId_peerAddress_key"');
  });
});
