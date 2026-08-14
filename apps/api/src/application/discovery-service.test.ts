import { describe, expect, it } from 'vitest';
import { demoDevices, type DiscoveredNeighbor } from '@gmj/shared';
import { DiscoveryService } from './discovery-service';

describe('DiscoveryService correlation', () => {
  const service = new DiscoveryService([]);
  const neighbor: DiscoveredNeighbor = {
    id: 'n-1',
    localDeviceId: 'core-01',
    localPort: '100GE1/0/1',
    remoteSystemName: 'agg-centro-01',
    remotePort: '100GE1/0/48',
    capabilities: ['bridge'],
    source: 'LLDP_SNMP',
    matchStatus: 'UNMATCHED',
  };

  it('matches normalized hostnames', () => {
    expect(service.correlate(neighbor, demoDevices)).toMatchObject({
      matchStatus: 'MATCHED',
      matchedDeviceId: 'agg-centro',
    });
  });

  it('does not guess unknown identities', () => {
    expect(
      service.correlate({ ...neighbor, remoteSystemName: 'SW-UNKNOWN' }, demoDevices).matchStatus,
    ).toBe('UNMATCHED');
  });
});
