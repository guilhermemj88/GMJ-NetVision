import { describe, expect, it } from 'vitest';
import { bgpCapabilitiesFor, bgpPlatformFor } from './bgp-vendor';
import { BgpPlatformProviders } from './bgp-platform-providers';
import type { BgpSshDiscoveryProvider, BgpSshDiscoveryReading } from './bgp-ssh-discovery';
import type { BgpSnmpCollector, BgpSnmpCollection } from './bgp-snmp-collector';
import { makeHost } from '../../test-fixtures';

const emptyReading: BgpSshDiscoveryReading = {
  peers: [],
  localAs: null,
  localAsAmbiguous: false,
  ipv6Supported: false,
  logicalUnitFallback: false,
  warnings: [],
};

const emptyCollection = (): BgpSnmpCollection => ({
  collectedAt: new Date('2026-10-01T00:00:00.000Z'),
  peers: [],
  errors: [],
});

function provider(name: string): BgpSshDiscoveryProvider & { discover: () => Promise<BgpSshDiscoveryReading> } {
  return {
    discover: async () => ({ ...emptyReading, warnings: [name] }),
  } as BgpSshDiscoveryProvider & { discover: () => Promise<BgpSshDiscoveryReading> };
}

function collector(name: string): BgpSnmpCollector {
  return {
    collect: async () => ({ ...emptyCollection(), errors: [name] }),
  };
}

function providers(): BgpPlatformProviders {
  return new BgpPlatformProviders({
    huaweiSsh: provider('huawei-ssh'),
    juniperSsh: provider('juniper-ssh'),
    huaweiSnmp: collector('huawei-snmp'),
    juniperSnmp: collector('juniper-snmp'),
  });
}

describe('bgpPlatformFor', () => {
  it('recognizes the vendors that exist in production', () => {
    expect(bgpPlatformFor('Huawei', 'S6730-H24X6C')).toBe('HUAWEI_VRP');
    expect(bgpPlatformFor('Huawei Technologies Co., Ltd', 'NE8000 M8')).toBe('HUAWEI_VRP');
    expect(bgpPlatformFor('Juniper', 'MX240')).toBe('JUNIPER_JUNOS');
    expect(bgpPlatformFor('juniper networks', 'mx480')).toBe('JUNIPER_JUNOS');
  });

  it('does not homologate a platform from the model alone', () => {
    expect(bgpPlatformFor('', 'MX240')).toBe('UNSUPPORTED');
    expect(bgpPlatformFor(null, null)).toBe('UNSUPPORTED');
    expect(bgpPlatformFor('Cisco', 'ASR9001')).toBe('UNSUPPORTED');
  });
});

describe('bgpCapabilitiesFor', () => {
  it('keeps Junos read-only', () => {
    expect(bgpCapabilitiesFor('Juniper', 'MX240')).toEqual({
      platform: 'JUNIPER_JUNOS',
      snmpCollector: 'BGP4_V2_JUNIPER',
      sshDiscovery: true,
      adminActions: false,
      advertisedRoutes: true,
      mitigation: false,
    });
  });

  it('preserves the Huawei capabilities exactly as before', () => {
    expect(bgpCapabilitiesFor('Huawei', 'NE8000 M8')).toEqual({
      platform: 'HUAWEI_VRP',
      snmpCollector: 'BGP4_MIB',
      sshDiscovery: true,
      adminActions: true,
      advertisedRoutes: true,
      mitigation: true,
    });
  });

  it('disables every write capability on an unknown platform', () => {
    expect(bgpCapabilitiesFor('Cisco', 'ASR9001')).toEqual({
      platform: 'UNSUPPORTED',
      snmpCollector: null,
      sshDiscovery: false,
      adminActions: false,
      advertisedRoutes: false,
      mitigation: false,
    });
  });
});

describe('BgpPlatformProviders', () => {
  const juniper = makeHost({ id: 'mx', hostname: 'MX', vendor: 'Juniper', model: 'MX240' });
  const huawei = makeHost({ id: 'ne', hostname: 'NE', vendor: 'Huawei', model: 'NE8000 M8' });
  const unknown = makeHost({ id: 'x', hostname: 'X', vendor: '', model: '' });

  it('routes Juniper to the Junos implementations', async () => {
    const platforms = providers();

    await expect(platforms.discover(juniper)).resolves.toMatchObject({ warnings: ['juniper-ssh'] });
    await expect(platforms.snmpFor(juniper).collect('mx', {})).resolves.toMatchObject({
      errors: ['juniper-snmp'],
    });
  });

  it('keeps Huawei on the Huawei implementations', async () => {
    const platforms = providers();

    await expect(platforms.discover(huawei)).resolves.toMatchObject({ warnings: ['huawei-ssh'] });
    await expect(platforms.snmpFor(huawei).collect('ne', {})).resolves.toMatchObject({
      errors: ['huawei-snmp'],
    });
  });

  it('keeps the legacy Huawei path for a device without a known vendor', async () => {
    const platforms = providers();

    await expect(platforms.discover(unknown)).resolves.toMatchObject({ warnings: ['huawei-ssh'] });
    expect(platforms.snmpFor(unknown)).toBeDefined();
    await expect(platforms.snmpFor(unknown).collect('x', {})).resolves.toMatchObject({
      errors: ['huawei-snmp'],
    });
    expect(platforms.isJuniper(unknown)).toBe(false);
  });
});
