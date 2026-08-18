import { describe, expect, it } from 'vitest';
import type { DiscoveredNeighbor } from '@gmj/shared';
import { LldpCorrelationService } from './lldp-correlation-service';
import { makeHost, makeInterface } from '../test-fixtures';

function neighbor(partial: Partial<DiscoveredNeighbor>): DiscoveredNeighbor {
  return {
    id: 'n-1',
    localDeviceId: 'host-a',
    localPort: '100GE1/0/1',
    remoteSystemName: 'host-b',
    remotePort: '100GE1/0/2',
    capabilities: [],
    source: 'LLDP_SNMP',
    matchStatus: 'UNMATCHED',
    ...partial,
  };
}

const service = new LldpCorrelationService();

describe('LldpCorrelationService', () => {
  const hostA = makeHost({ id: 'host-a', hostname: 'bhe-a' });
  const hostB = makeHost({
    id: 'host-b',
    hostname: 'agg-centro-01',
    managementIp: '10.0.0.2',
    interfaces: [makeInterface({ id: 'b-if-1', deviceId: 'host-b', name: '100GE1/0/2', ifIndex: 2002 })],
  });

  it('correlates by management IP with the highest priority', () => {
    const result = service.observe(
      neighbor({ remoteManagementAddress: '10.0.0.2', remoteSystemName: 'whatever' }),
      [hostA, hostB],
    );
    expect(result.matchedBy).toBe('MANAGEMENT_IP');
    expect(result.targetHost?.id).toBe('host-b');
  });

  it('correlates by normalized hostname when management IP is absent', () => {
    const result = service.observe(
      neighbor({ remoteSystemName: 'AGG-CENTRO-01' }),
      [hostA, hostB],
    );
    expect(result.matchedBy).toBe('SYSTEM_NAME');
    expect(result.targetHost?.id).toBe('host-b');
  });

  it('correlates by chassis ID against interface MACs', () => {
    const hostWithMac = makeHost({
      id: 'host-b',
      hostname: 'mac-host',
      interfaces: [makeInterface({ id: 'b-if-1', deviceId: 'host-b', name: '100GE1/0/2', ifIndex: 2002, mac: 'A0:3D:6F:00:00:01' })],
    });
    const result = service.observe(
      neighbor({ remoteChassisId: 'a0:3d:6f:00:00:01', remoteSystemName: 'mac-host' }),
      [hostA, hostWithMac],
    );
    expect(result.matchedBy).toBe('CHASSIS_ID');
    expect(result.targetHost?.id).toBe('host-b');
  });

  it('resolves the local interface by explicit ifIndex', () => {
    const withIf = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      interfaces: [makeInterface({ id: 'a-if-1', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    const resolved = service.resolveLocalInterface(
      withIf,
      neighbor({ localPort: '100GE1/0/1', localIfIndex: 1001 }),
    );
    expect(resolved?.id).toBe('a-if-1');
  });

  it('resolves the local interface by interfaceName subtype', () => {
    const host = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      interfaces: [makeInterface({ id: 'a-if-1', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    expect(service.resolveLocalInterface(
      host,
      neighbor({ localPort: 'HundredGigabitEthernet1/0/1', localPortSubtype: 5 }),
    )?.id).toBe('a-if-1');
  });

  it('resolves the local interface by interfaceAlias subtype', () => {
    const host = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      interfaces: [makeInterface({ id: 'a-if-1', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001, alias: 'UPLINK-TO-CORE' })],
    });
    expect(service.resolveLocalInterface(
      host,
      neighbor({ localPort: 'UPLINK-TO-CORE', localPortSubtype: 1 }),
    )?.id).toBe('a-if-1');
  });

  it('resolves the local interface by macAddress subtype', () => {
    const host = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      interfaces: [makeInterface({ id: 'a-if-1', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001, mac: 'A0:3D:6F:00:00:01' })],
    });
    expect(service.resolveLocalInterface(
      host,
      neighbor({ localPort: 'a0:3d:6f:00:00:01', localPortSubtype: 3 }),
    )?.id).toBe('a-if-1');
  });

  it('falls back to interface name for the portComponent subtype', () => {
    const host = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      interfaces: [makeInterface({ id: 'a-if-1', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    expect(service.resolveLocalInterface(
      host,
      neighbor({ localPort: '100GE1/0/1', localPortSubtype: 2 }),
    )?.id).toBe('a-if-1');
  });

  it('resolves the remote interface by name on the matched host', () => {
    const resolved = service.resolveRemoteInterface(hostB, '100GE1/0/2');
    expect(resolved?.id).toBe('b-if-1');
  });

  it('normalizes Huawei interface abbreviations', () => {
    const huawei = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      interfaces: [makeInterface({ id: 'a-if-1', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    expect(service.resolveLocalInterface(
      huawei,
      neighbor({ localPort: 'HundredGigabitEthernet1/0/1', localPortSubtype: 5 }),
    )?.id).toBe('a-if-1');
  });

  it('does not identify a remote host from the remote port alone', () => {
    const result = service.observe(
      neighbor({ remoteSystemName: 'UNKNOWN-DEV', remotePort: '100GE1/0/2' }),
      [hostA, hostB],
    );
    expect(result.targetHost).toBeNull();
    expect(result.matchedBy).toBeNull();
  });

  it('leaves unknown neighbors unmatched', () => {
    const result = service.observe(
      neighbor({ remoteSystemName: 'SW-UNKNOWN', remotePort: 'GE0/0/9' }),
      [hostA, hostB],
    );
    expect(result.targetHost).toBeNull();
    expect(result.targetCandidates).toHaveLength(0);
  });

  it('marks multiple candidates as ambiguous', () => {
    const twinA = makeHost({ id: 'twin-a', hostname: 'core-01' });
    const twinB = makeHost({ id: 'twin-b', hostname: 'CORE-01' });
    const result = service.observe(neighbor({ remoteSystemName: 'core-01' }), [twinA, twinB]);
    expect(result.targetHost).toBeNull();
    expect(result.targetCandidates).toHaveLength(2);
  });
});
