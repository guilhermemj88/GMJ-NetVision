import { describe, expect, it } from 'vitest';
import {
  computePppTotal,
  formatPppLabel,
  formatPppOnline,
  isPppVisible,
} from './ppp';
import type { HostRecord, PppTotalWidgetSettings } from './types';

function host(
  id: string,
  overrides: Partial<HostRecord> = {},
): HostRecord {
  return {
    id,
    name: id,
    hostname: id,
    ip: '10.0.0.1',
    vendor: 'Huawei',
    model: '',
    status: 'UP',
    deviceType: 'router',
    site: '',
    source: 'MANUAL',
    discoveryMethod: 'SNMP',
    uptimeSeconds: 0,
    pppSupported: true,
    pppOnline: 0,
    pppUpdatedAt: new Date().toISOString(),
    pppSource: 'SNMP_HUAWEI',
    updatedAt: '',
    interfaces: [],
    displayName: id,
    managementIp: '10.0.0.1',
    description: '',
    notes: '',
    origin: 'MANUAL',
    useZabbix: false,
    zabbix: null,
    sshEnabled: false,
    ssh: null,
    snmpEnabled: true,
    snmp: {
      version: 'SNMP_V2C',
      host: '10.0.0.1',
      port: 161,
      username: '',
      securityLevel: 'NO_AUTH_NO_PRIV',
      authProtocol: null,
      privacyProtocol: null,
      credentialConfigured: true,
    },
    sourceHealth: {
      ZABBIX: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
      SSH: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
      SNMP: { state: 'CONNECTED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
    },
    lastPollingAt: null,
    lastDiscoveryAt: null,
    mapIds: [],
    mapCount: 0,
    createdAt: '',
    ...overrides,
  };
}

function settings(overrides: Partial<PppTotalWidgetSettings> = {}): PppTotalWidgetSettings {
  return {
    mode: 'AUTO',
    selectedHostIds: [],
    title: 'PPP TOTAL',
    fontColor: null,
    fontSize: 24,
    backgroundColor: null,
    backgroundOpacity: 85,
    showHostCount: true,
    showFreshness: true,
    ...overrides,
  };
}

describe('isPppVisible (host AUTO rule)', () => {
  it('does not show unsupported hosts regardless of mode', () => {
    expect(isPppVisible('SHOW', false, 100)).toBe(false);
  });

  it('AUTO hides 0, 1 and 2 and shows 3+', () => {
    expect(isPppVisible('AUTO', true, 0)).toBe(false);
    expect(isPppVisible('AUTO', true, 1)).toBe(false);
    expect(isPppVisible('AUTO', true, 2)).toBe(false);
    expect(isPppVisible('AUTO', true, 3)).toBe(true);
  });

  it('SHOW displays a supported host even with zero sessions', () => {
    expect(isPppVisible('SHOW', true, 0)).toBe(true);
  });

  it('HIDE never displays', () => {
    expect(isPppVisible('HIDE', true, 12_438)).toBe(false);
  });
});

describe('formatPppOnline / formatPppLabel', () => {
  it('formats pt-BR with thousands separators', () => {
    expect(formatPppOnline(12_438)).toBe('12.438');
    expect(formatPppLabel(12_438)).toBe('PPP 12.438');
  });

  it('treats 0 as valid and negative as 0', () => {
    expect(formatPppOnline(0)).toBe('0');
    expect(formatPppOnline(-5)).toBe('0');
  });
});

describe('computePppTotal (AUTO)', () => {
  it('sums every PPP-capable host of the map', () => {
    const hosts = [host('a', { pppOnline: 5_000 }), host('b', { pppOnline: 7_000 })];
    expect(computePppTotal(hosts, settings()).total).toBe(12_000);
  });

  it('ignores unsupported hosts', () => {
    const hosts = [
      host('a', { pppOnline: 5_000 }),
      host('b', { pppOnline: 7_000 }),
      host('c', { pppSupported: false, pppOnline: 50_000 }),
    ];
    expect(computePppTotal(hosts, settings())).toMatchObject({ total: 12_000, hostCount: 2 });
  });

  it('ignores invalid values (negative)', () => {
    const hosts = [host('a', { pppOnline: 5_000 }), host('b', { pppOnline: -1 })];
    expect(computePppTotal(hosts, settings()).total).toBe(5_000);
  });

  it('treats 0 as a valid value', () => {
    const hosts = [host('a', { pppOnline: 0 })];
    expect(computePppTotal(hosts, settings())).toMatchObject({ total: 0, hostCount: 1 });
  });
});

describe('computePppTotal (MANUAL)', () => {
  it('sums only selected hosts', () => {
    const hosts = [
      host('a', { pppOnline: 5_000 }),
      host('b', { pppOnline: 7_000 }),
      host('c', { pppOnline: 3_000 }),
    ];
    const result = computePppTotal(
      hosts,
      settings({ mode: 'MANUAL', selectedHostIds: ['a', 'c'] }),
    );
    expect(result.total).toBe(8_000);
    expect(result.hostCount).toBe(2);
  });

  it('ignores selected hosts that are unsupported', () => {
    const hosts = [
      host('a', { pppOnline: 5_000 }),
      host('b', { pppSupported: false, pppOnline: 7_000 }),
    ];
    const result = computePppTotal(
      hosts,
      settings({ mode: 'MANUAL', selectedHostIds: ['a', 'b'] }),
    );
    expect(result).toMatchObject({ total: 5_000, hostCount: 1 });
  });

  it('never double counts automatically', () => {
    const hosts = [host('a', { pppOnline: 5_000 }), host('b', { pppOnline: 7_000 })];
    const result = computePppTotal(hosts, settings({ mode: 'MANUAL', selectedHostIds: ['a'] }));
    expect(result.total).toBe(5_000);
  });
});

describe('computePppTotal freshness', () => {
  it('reports 4/4 when every host is fresh', () => {
    const now = Date.now();
    const hosts = [1, 2, 3, 4].map((n) =>
      host(`h${n}`, { pppOnline: n, pppUpdatedAt: new Date(now - 10_000).toISOString() }),
    );
    expect(computePppTotal(hosts, settings(), now)).toMatchObject({
      hostCount: 4,
      freshHostCount: 4,
    });
  });

  it('reports 3/4 when one host is stale', () => {
    const now = Date.now();
    const hosts = [
      host('h1', { pppOnline: 1, pppUpdatedAt: new Date(now - 10_000).toISOString() }),
      host('h2', { pppOnline: 1, pppUpdatedAt: new Date(now - 10_000).toISOString() }),
      host('h3', { pppOnline: 1, pppUpdatedAt: new Date(now - 10_000).toISOString() }),
      host('h4', { pppOnline: 1, pppUpdatedAt: new Date(now - 600_000).toISOString() }),
    ];
    expect(computePppTotal(hosts, settings(), now)).toMatchObject({
      hostCount: 4,
      freshHostCount: 3,
    });
  });
});
