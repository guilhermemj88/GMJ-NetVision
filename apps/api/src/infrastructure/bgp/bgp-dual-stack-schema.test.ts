import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL(
    '../../../prisma/migrations/20260921120000_bgp_dual_stack_local_as_admin_state/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const bgpPeer = schema.slice(schema.indexOf('model BgpPeer {'), schema.indexOf('model BgpPeerSample {'));

describe('BGP dual-stack / local AS / admin state schema', () => {
  it('adds a nullable local ASN to Device without a global default', () => {
    expect(schema).toMatch(/bgpLocalAs\s+BigInt\?/);
    expect(schema).not.toMatch(/bgpLocalAs\s+BigInt\?\s+@default/);
    expect(migration).toContain('ALTER TABLE "Device" ADD COLUMN "bgpLocalAs" BIGINT;');
  });

  it('classifies peers by address family with IPv4 as the existing-data default', () => {
    expect(schema).toMatch(/enum BgpAddressFamily \{\s*IPV4\s*IPV6\s*\}/);
    expect(bgpPeer).toMatch(/addressFamily\s+BgpAddressFamily\s+@default\(IPV4\)/);
    expect(migration).toContain(`ADD COLUMN "addressFamily" "BgpAddressFamily" NOT NULL DEFAULT 'IPV4'`);
    expect(migration).toContain(`UPDATE "BgpPeer" SET "addressFamily" = 'IPV6' WHERE "peerAddress" LIKE '%:%';`);
  });

  it('keeps a single peer key for both families and history attached to the peer', () => {
    expect(bgpPeer).toContain('@@unique([deviceId, peerAddress])');
    expect(schema).toMatch(/model BgpPeerSample \{[\s\S]*?bgpPeerId\s+String/);
    expect(schema).not.toMatch(/model BgpPeerSampleIpv6/);
    expect(schema).not.toMatch(/model BgpPeerStateEventIpv6/);
  });

  it('starts the administrative state as UNKNOWN until a read-back confirms it', () => {
    expect(schema).toMatch(/enum BgpAdminState \{\s*UNKNOWN\s*ENABLED\s*IGNORED\s*\}/);
    expect(bgpPeer).toMatch(/adminState\s+BgpAdminState\s+@default\(UNKNOWN\)/);
    expect(bgpPeer).toMatch(/adminStateCheckedAt\s+DateTime\?/);
    expect(migration).toContain(`ADD COLUMN "adminState" "BgpAdminState" NOT NULL DEFAULT 'UNKNOWN'`);
  });

  it('persists an audit trail for administrative actions without secrets', () => {
    expect(schema).toMatch(/model BgpAdminActionLog \{/);
    expect(schema).toMatch(/enum BgpAdminAction \{\s*DISABLE\s*ENABLE\s*\}/);
    for (const column of [
      '"userId"',
      '"username"',
      '"peerAddress"',
      '"addressFamily"',
      '"localAs"',
      '"remoteAs"',
      '"action"',
      '"startedAt"',
      '"completedAt"',
      '"success"',
      '"errorSafe"',
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).not.toMatch(/password|community|secret|contextcommand/i);
  });
});
