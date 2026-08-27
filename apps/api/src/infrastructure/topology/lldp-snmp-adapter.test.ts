import { describe, expect, it } from 'vitest';
import type { Device } from '@gmj/shared';
import type { SnmpClient, SnmpRequestOptions, SnmpVarBind } from '../../domain/ports';
import { LldpSnmpDiscoveryAdapter, LLDP_OIDS } from './lldp-snmp-adapter';

interface WalkCall {
  host: string;
  oid: string;
  options: SnmpRequestOptions | undefined;
}

class FakeSnmpClient implements SnmpClient {
  readonly calls: WalkCall[] = [];

  constructor(private readonly values: Map<string, SnmpVarBind[]>) {}

  async walk(host: string, oid: string, options?: SnmpRequestOptions): Promise<SnmpVarBind[]> {
    this.calls.push({ host, oid, options });
    return this.values.get(oid) ?? [];
  }

  async get(_host: string, _oids: string[]): Promise<SnmpVarBind[]> {
    return [];
  }
}

const device: Device = {
  id: 'device-a',
  name: 'A',
  hostname: 'A',
  ip: '192.0.2.1',
  vendor: 'Huawei',
  model: '',
  status: 'UP',
  deviceType: 'switch',
  site: '',
  source: 'LLDP_SNMP',
  discoveryMethod: 'AUTO',
  uptimeSeconds: 0,
  pppSupported: false,
  pppOnline: 0,
  pppUpdatedAt: null,
  pppSource: null,
  updatedAt: '',
  interfaces: [],
};

function rows(oid: string, entries: Array<[string, string | number | Uint8Array]>): SnmpVarBind[] {
  return entries.map(([suffix, value]) => ({ oid: `${oid}.${suffix}`, value }));
}

describe('LldpSnmpDiscoveryAdapter', () => {
  it('parses LLDP-MIB remote rows, management address and local port id', async () => {
    const values = new Map<string, SnmpVarBind[]>([
      [LLDP_OIDS.remoteSystemName, rows(LLDP_OIDS.remoteSystemName, [['0.5.1', 'SW-B']])],
      [LLDP_OIDS.remoteChassisId, rows(LLDP_OIDS.remoteChassisId, [['0.5.1', 'a0:3d:6f:00:00:01']])],
      [LLDP_OIDS.remotePortId, rows(LLDP_OIDS.remotePortId, [['0.5.1', '100GE1/0/10']])],
      [LLDP_OIDS.remotePortDescription, rows(LLDP_OIDS.remotePortDescription, [['0.5.1', 'TO-CORE']])],
      [LLDP_OIDS.remoteSystemDescription, rows(LLDP_OIDS.remoteSystemDescription, [['0.5.1', 'Huawei S6730']])],
      [LLDP_OIDS.localPortId, rows(LLDP_OIDS.localPortId, [['5', '100GE1/0/5']])],
      [LLDP_OIDS.localPortIdSubtype, rows(LLDP_OIDS.localPortIdSubtype, [['5', 7]])],
      [LLDP_OIDS.localPortDescription, rows(LLDP_OIDS.localPortDescription, [['5', 'uplink']])],
      [LLDP_OIDS.remoteManAddr, rows(LLDP_OIDS.remoteManAddr, [['0.5.1.1.10.0.0.2', new Uint8Array()]])],
    ]);
    const client = new FakeSnmpClient(values);
    const adapter = new LldpSnmpDiscoveryAdapter(client, {
      async resolve() {
        return { host: '192.0.2.1', port: 1161, community: 'secret' };
      },
    });

    const neighbors = await adapter.discoverNeighbors(device);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]).toMatchObject({
      localDeviceId: 'device-a',
      localPort: '100GE1/0/5',
      remoteSystemName: 'SW-B',
      remoteChassisId: 'a0:3d:6f:00:00:01',
      remotePort: '100GE1/0/10',
      remotePortDescription: 'TO-CORE',
      systemDescription: 'Huawei S6730',
      remoteManagementAddress: '10.0.0.2',
      source: 'LLDP_SNMP',
    });
    expect(neighbors[0]?.localIfIndex).toBeUndefined();
    expect(client.calls[0]).toMatchObject({
      host: '192.0.2.1',
      options: { community: 'secret', port: 1161, version: 'v2c' },
    });
  });

  it('does not invent an ifIndex from the LLDP table index (portComponent)', async () => {
    const values = new Map<string, SnmpVarBind[]>([
      [LLDP_OIDS.remoteSystemName, rows(LLDP_OIDS.remoteSystemName, [['0.7.1', 'SW-C']])],
      [LLDP_OIDS.remoteChassisId, rows(LLDP_OIDS.remoteChassisId, [['0.7.1', 'a0:3d:6f:00:00:02']])],
      [LLDP_OIDS.remotePortId, rows(LLDP_OIDS.remotePortId, [['0.7.1', 'GE0/0/1']])],
      [LLDP_OIDS.remotePortDescription, rows(LLDP_OIDS.remotePortDescription, [])],
      [LLDP_OIDS.remoteSystemDescription, rows(LLDP_OIDS.remoteSystemDescription, [])],
      [LLDP_OIDS.localPortId, rows(LLDP_OIDS.localPortId, [['7', '42']])],
      [LLDP_OIDS.localPortIdSubtype, rows(LLDP_OIDS.localPortIdSubtype, [['7', 2]])],
      [LLDP_OIDS.localPortDescription, rows(LLDP_OIDS.localPortDescription, [])],
      [LLDP_OIDS.remoteManAddr, rows(LLDP_OIDS.remoteManAddr, [])],
    ]);
    const neighbors = await new LldpSnmpDiscoveryAdapter(new FakeSnmpClient(values)).discoverNeighbors(device);
    expect(neighbors[0]).toMatchObject({ localPort: '42', localPortSubtype: 2 });
    expect(neighbors[0]?.localIfIndex).toBeUndefined();
  });

  it('exposes the MAC when the local port subtype is macAddress', async () => {
    const values = new Map<string, SnmpVarBind[]>([
      [LLDP_OIDS.remoteSystemName, rows(LLDP_OIDS.remoteSystemName, [['0.9.1', 'SW-D']])],
      [LLDP_OIDS.remoteChassisId, rows(LLDP_OIDS.remoteChassisId, [['0.9.1', 'a0:3d:6f:00:00:09']])],
      [LLDP_OIDS.remotePortId, rows(LLDP_OIDS.remotePortId, [['0.9.1', 'GE0/0/1']])],
      [LLDP_OIDS.remotePortDescription, rows(LLDP_OIDS.remotePortDescription, [])],
      [LLDP_OIDS.remoteSystemDescription, rows(LLDP_OIDS.remoteSystemDescription, [])],
      [LLDP_OIDS.localPortId, rows(LLDP_OIDS.localPortId, [['9', 'a0:3d:6f:00:00:09']])],
      [LLDP_OIDS.localPortIdSubtype, rows(LLDP_OIDS.localPortIdSubtype, [['9', 3]])],
      [LLDP_OIDS.localPortDescription, rows(LLDP_OIDS.localPortDescription, [])],
      [LLDP_OIDS.remoteManAddr, rows(LLDP_OIDS.remoteManAddr, [])],
    ]);
    const neighbors = await new LldpSnmpDiscoveryAdapter(new FakeSnmpClient(values)).discoverNeighbors(device);
    expect(neighbors[0]).toMatchObject({
      localPort: 'a0:3d:6f:00:00:09',
      localPortSubtype: 3,
      localMac: 'a0:3d:6f:00:00:09',
    });
  });

  it('decodes an IPv4 management address from the manAddr table', async () => {
    const values = new Map<string, SnmpVarBind[]>([
      [LLDP_OIDS.remoteSystemName, rows(LLDP_OIDS.remoteSystemName, [['0.5.1', 'SW-B']])],
      [LLDP_OIDS.remoteChassisId, rows(LLDP_OIDS.remoteChassisId, [['0.5.1', 'a0:3d:6f:00:00:01']])],
      [LLDP_OIDS.remotePortId, rows(LLDP_OIDS.remotePortId, [['0.5.1', '100GE1/0/10']])],
      [LLDP_OIDS.remotePortDescription, rows(LLDP_OIDS.remotePortDescription, [])],
      [LLDP_OIDS.remoteSystemDescription, rows(LLDP_OIDS.remoteSystemDescription, [])],
      [LLDP_OIDS.localPortId, rows(LLDP_OIDS.localPortId, [['5', '100GE1/0/5']])],
      [LLDP_OIDS.localPortIdSubtype, rows(LLDP_OIDS.localPortIdSubtype, [['5', 7]])],
      [LLDP_OIDS.localPortDescription, rows(LLDP_OIDS.localPortDescription, [])],
      [LLDP_OIDS.remoteManAddr, rows(LLDP_OIDS.remoteManAddr, [['0.5.1.1.10.0.0.2', new Uint8Array()]])],
    ]);
    const neighbors = await new LldpSnmpDiscoveryAdapter(new FakeSnmpClient(values)).discoverNeighbors(device);
    expect(neighbors[0]?.remoteManagementAddress).toBe('10.0.0.2');
  });

  it('ignores IPv6 management addresses safely', async () => {
    const values = new Map<string, SnmpVarBind[]>([
      [LLDP_OIDS.remoteSystemName, rows(LLDP_OIDS.remoteSystemName, [['0.5.1', 'SW-B']])],
      [LLDP_OIDS.remoteChassisId, rows(LLDP_OIDS.remoteChassisId, [['0.5.1', 'a0:3d:6f:00:00:01']])],
      [LLDP_OIDS.remotePortId, rows(LLDP_OIDS.remotePortId, [['0.5.1', '100GE1/0/10']])],
      [LLDP_OIDS.remotePortDescription, rows(LLDP_OIDS.remotePortDescription, [])],
      [LLDP_OIDS.remoteSystemDescription, rows(LLDP_OIDS.remoteSystemDescription, [])],
      [LLDP_OIDS.localPortId, rows(LLDP_OIDS.localPortId, [['5', '100GE1/0/5']])],
      [LLDP_OIDS.localPortIdSubtype, rows(LLDP_OIDS.localPortIdSubtype, [['5', 7]])],
      [LLDP_OIDS.localPortDescription, rows(LLDP_OIDS.localPortDescription, [])],
      // subtype 2 = ipv6, 16 octets: 2001:db8::1
      [LLDP_OIDS.remoteManAddr, rows(LLDP_OIDS.remoteManAddr, [
        ['0.5.1.2.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.0.1', new Uint8Array()],
      ])],
    ]);
    const neighbors = await new LldpSnmpDiscoveryAdapter(new FakeSnmpClient(values)).discoverNeighbors(device);
    expect(neighbors[0]?.remoteManagementAddress).toBeUndefined();
  });

  it('leaves management address absent when the table has no IPv4', async () => {
    const values = new Map<string, SnmpVarBind[]>([
      [LLDP_OIDS.remoteSystemName, rows(LLDP_OIDS.remoteSystemName, [['0.5.1', 'SW-B']])],
      [LLDP_OIDS.remoteChassisId, rows(LLDP_OIDS.remoteChassisId, [['0.5.1', 'a0:3d:6f:00:00:01']])],
      [LLDP_OIDS.remotePortId, rows(LLDP_OIDS.remotePortId, [['0.5.1', '100GE1/0/10']])],
      [LLDP_OIDS.remotePortDescription, rows(LLDP_OIDS.remotePortDescription, [])],
      [LLDP_OIDS.remoteSystemDescription, rows(LLDP_OIDS.remoteSystemDescription, [])],
      [LLDP_OIDS.localPortId, rows(LLDP_OIDS.localPortId, [['5', '100GE1/0/5']])],
      [LLDP_OIDS.localPortIdSubtype, rows(LLDP_OIDS.localPortIdSubtype, [['5', 7]])],
      [LLDP_OIDS.localPortDescription, rows(LLDP_OIDS.localPortDescription, [])],
      [LLDP_OIDS.remoteManAddr, rows(LLDP_OIDS.remoteManAddr, [])],
    ]);
    const neighbors = await new LldpSnmpDiscoveryAdapter(new FakeSnmpClient(values)).discoverNeighbors(device);
    expect(neighbors[0]?.remoteManagementAddress).toBeUndefined();
  });

  it('keeps the first IPv4 when multiple management addresses exist', async () => {
    const values = new Map<string, SnmpVarBind[]>([
      [LLDP_OIDS.remoteSystemName, rows(LLDP_OIDS.remoteSystemName, [['0.5.1', 'SW-B']])],
      [LLDP_OIDS.remoteChassisId, rows(LLDP_OIDS.remoteChassisId, [['0.5.1', 'a0:3d:6f:00:00:01']])],
      [LLDP_OIDS.remotePortId, rows(LLDP_OIDS.remotePortId, [['0.5.1', '100GE1/0/10']])],
      [LLDP_OIDS.remotePortDescription, rows(LLDP_OIDS.remotePortDescription, [])],
      [LLDP_OIDS.remoteSystemDescription, rows(LLDP_OIDS.remoteSystemDescription, [])],
      [LLDP_OIDS.localPortId, rows(LLDP_OIDS.localPortId, [['5', '100GE1/0/5']])],
      [LLDP_OIDS.localPortIdSubtype, rows(LLDP_OIDS.localPortIdSubtype, [['5', 7]])],
      [LLDP_OIDS.localPortDescription, rows(LLDP_OIDS.localPortDescription, [])],
      [LLDP_OIDS.remoteManAddr, rows(LLDP_OIDS.remoteManAddr, [
        ['0.5.1.1.10.0.0.2', new Uint8Array()],
        ['0.5.1.1.192.168.0.1', new Uint8Array()],
      ])],
    ]);
    const neighbors = await new LldpSnmpDiscoveryAdapter(new FakeSnmpClient(values)).discoverNeighbors(device);
    expect(neighbors[0]?.remoteManagementAddress).toBe('10.0.0.2');
  });
});
