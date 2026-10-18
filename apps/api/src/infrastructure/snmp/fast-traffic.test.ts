import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { deriveFastTraffic } from './fast-traffic-rate';
import { FastSnmpReader, FAST_OIDS, snmpUnsigned } from './fast-snmp-reader';
import { FastTrafficPoller, fastPollerConfig } from './fast-traffic-poller';
import type {
  FastCounterReading,
  FastTrafficObservation,
  FastTrafficStore,
  FastTrafficTarget,
} from './fast-traffic-types';

const t: FastTrafficTarget = {
  deviceId: 'd',
  interfaceId: 'i',
  ifIndex: 200,
  interfaceName: 'Eth-Trunk1.3043',
  speedBps: 300_000_000_000n,
  profiles: [
    {
      profileId: 'p',
      direction: 'tx',
      thresholdBps: 9_000_000_000n,
      bandwidthBps: 10_000_000_000n,
    },
  ],
};
const base = (at = 0): FastCounterReading => ({
  deviceId: 'd',
  interfaceId: 'i',
  ifIndex: 200,
  interfaceName: 'Eth-Trunk1.3043',
  requestStartedAt: new Date(at),
  collectedAt: new Date(at),
  inOctets: 10n,
  outOctets: 20n,
  uptimeTicks: BigInt(100000 + at / 10),
  discontinuityTicks: 0n,
  lastChangeTicks: 0n,
  adminStatus: 1,
  operStatus: 1,
  speedBps: 300_000_000_000n,
});

class MemoryStore implements FastTrafficStore {
  rows: FastTrafficObservation[] = [];
  async append(o: FastTrafficObservation) {
    if (this.rows.some((r) => r.interfaceId === o.interfaceId && r.collectedAt >= o.collectedAt))
      return false;
    this.rows.push(o);
    return true;
  }
  async latest(id: string) {
    return this.rows.filter((r) => r.interfaceId === id).at(-1) ?? null;
  }
}

afterEach(() => vi.useRealTimers());

describe('priority raw counters and physical capacity', () => {
  it('preserves unsigned Counter64 precision', () => {
    expect(snmpUnsigned(new Uint8Array(Array(8).fill(255)))).toBe(18446744073709551615n);
    expect(() => snmpUnsigned(9007199254740992)).toThrow('INVALID_COUNTER');
    expect(() => snmpUnsigned(undefined)).toThrow();
  });
  it('uses real elapsed time, permits 156Gbps on 300G with 10G contract', () => {
    const p = base();
    const c = { ...base(10000), outOctets: 195_000_000_020n };
    const o = deriveFastTraffic(t, c, p, 'g');
    expect(o.quality).toBe('VALID');
    expect(o.txBps).toBe(156_000_000_000);
    expect(o.intervalMs).toBe(10000);
    expect(o.previousCollectedAt).toEqual(p.collectedAt);
  });
  it('frozen counters are a valid zero only while UP and uptime advances', () => {
    const o = deriveFastTraffic(t, base(10000), base(), 'g');
    expect(o.quality).toBe('VALID');
    expect(o.txBps).toBe(0);
  });
  it.each([
    ['BASELINE', {}, undefined],
    ['ADMIN_DOWN', { adminStatus: 2 }, base()],
    ['OPER_DOWN', { operStatus: 2 }, base()],
    ['STATE_TRANSITION', { lastChangeTicks: 5n }, base()],
    ['STATE_TRANSITION', {}, { ...base(), operStatus: 2 }],
    ['RESTART', { uptimeTicks: 10n }, base()],
    ['DISCONTINUITY', { discontinuityTicks: 5n }, base()],
    ['DISCONTINUITY', { outOctets: 1n }, base()],
    ['DISCONTINUITY', { outOctets: 1n }, { ...base(), outOctets: 18446744073709551610n }],
    ['IDENTITY_MISMATCH', { ifIndex: 201 }, base()],
    ['IDENTITY_MISMATCH', { interfaceName: 'reused-index' }, base()],
    ['IDENTITY_MISMATCH', {}, { ...base(), ifIndex: 199 }],
    ['ABOVE_CAPACITY', { outOctets: 999_000_000_000n }, base()],
    ['OUT_OF_ORDER', { collectedAt: new Date(-1), requestStartedAt: new Date(-1) }, base()],
    ['LATE_RESPONSE', { requestStartedAt: new Date(0) }, base()],
    ['STALE_INTERVAL', {}, base(-50000)],
  ] as const)('%s never confirms or substitutes a zero', (quality, changes, previous) => {
    const o = deriveFastTraffic(t, { ...base(10000), ...changes }, previous, 'g');
    expect(o.quality).toBe(quality);
    expect(o.txBps).toBeNull();
  });
});

describe('targeted GET', () => {
  function setup() {
    const host = {
      id: 'd',
      snmpEnabled: true,
      snmp: { version: 'SNMP_V2C', host: '127.0.0.1', port: 1161 },
      interfaces: [{ id: 'i', ifIndex: 200, name: t.interfaceName }],
    } as HostRecord;
    const rows = Object.entries(FAST_OIDS).map(([key, oid]) => ({
      oid: key === 'uptime' ? oid : `${oid}.200`,
      value:
        key === 'name'
          ? t.interfaceName
          : key === 'highSpeed'
            ? '300000'
            : key === 'admin' || key === 'oper'
              ? '1'
              : '100',
    }));
    const get = vi.fn(async () => rows);
    const hosts = {
      getHost: vi.fn(async () => host),
      getDecryptedSnmpCredentials: vi.fn(async () => ({ community: 'isolated' })),
    };
    return { host, rows, get, hosts, reader: new FastSnmpReader(hosts, { get, walk: vi.fn() }) };
  }
  it('gets only nine essential OIDs, no walk or host poll', async () => {
    const h = setup();
    const rows = await h.reader.read([t]);
    expect(rows[0]!.speedBps).toBe(300_000_000_000n);
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledWith(
      '127.0.0.1',
      expect.arrayContaining([FAST_OIDS.uptime, FAST_OIDS.out + '.200']),
      expect.anything(),
    );
  });
  it('removal or ifIndex remapping prevents a request', async () => {
    const h = setup();
    h.host.interfaces = [];
    await expect(h.reader.read([t])).rejects.toThrow('INTERFACE_REMOVED_OR_REMAPPED');
    expect(h.get).not.toHaveBeenCalled();
  });
  it('missing and duplicate OIDs are rejected', async () => {
    const h = setup();
    h.rows.push(h.rows[0]!);
    await expect(h.reader.read([t])).rejects.toThrow('DUPLICATE_OID');
    h.rows.splice(0);
    await expect(h.reader.read([t])).rejects.toThrow();
  });
  it('host unavailable is an error, not zero', async () => {
    const h = setup();
    h.get.mockRejectedValueOnce(new Error('timeout'));
    await expect(h.reader.read([t])).rejects.toThrow('timeout');
  });
});

describe('bounded independent scheduler', () => {
  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    let high = false;
    let counter = 0n;
    let lastAt = Date.now();
    const store = new MemoryStore();
    const reader = {
      read: vi.fn(async (ts: FastTrafficTarget[]): Promise<FastCounterReading[]> => {
        counter += BigInt(Date.now() - lastAt) * (high ? 20_000_000n : 1n);
        lastAt = Date.now();
        return ts.map((target) => ({
          ...base(Date.now()),
          deviceId: target.deviceId,
          interfaceId: target.interfaceId,
          outOctets: counter,
        }));
      }),
    };
    const listTargets = vi.fn(async () => [t]);
    const p = new FastTrafficPoller({
      config: { ...fastPollerConfig({}), mode: 'ENFORCE', profileIds: ['p'] },
      listTargets,
      reader,
      store,
    });
    return {
      p,
      reader,
      store,
      listTargets,
      high: () => {
        high = true;
      },
    };
  }
  it('normal 20s changes to 10s from first high observation', async () => {
    const h = setup();
    await h.p.runDue();
    await h.p.drain();
    h.high();
    vi.setSystemTime(120000);
    await h.p.runDue();
    await h.p.drain();
    expect(h.p.status().entries[0]!.state).toBe('SUSPECTED_ATTACK');
    expect(h.p.status().entries[0]!.nextMeasurementAt).toBe(new Date(130000).toISOString());
    expect(h.p.status().entries[0]!.contractedPercent.p).toBeGreaterThan(100);
    vi.setSystemTime(130000);
    await h.p.runDue();
    await h.p.drain();
    expect(h.reader.read).toHaveBeenCalledTimes(3);
  });
  it('simultaneous cycles never overlap same device', async () => {
    const h = setup();
    let finish!: (v: FastCounterReading[]) => void;
    h.reader.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.all([h.p.runDue(), h.p.runDue(), h.p.runDue()]);
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    finish([base(100000)]);
    await h.p.drain();
  });
  it('failure invalidates availability and next success establishes a new baseline', async () => {
    const h = setup();
    await h.p.runDue();
    await h.p.drain();
    vi.setSystemTime(120000);
    await h.p.runDue();
    await h.p.drain();
    expect(h.p.isAvailable('i')).toBe(true);
    vi.setSystemTime(140000);
    h.reader.read.mockRejectedValueOnce(new Error('timeout secret-not-logged'));
    await h.p.runDue();
    await h.p.drain();
    expect(h.p.isAvailable('i')).toBe(false);
    expect(h.store.rows).toHaveLength(2);
    vi.setSystemTime(160000);
    await h.p.runDue();
    await h.p.drain();
    expect(h.store.rows.at(-1)!.quality).toBe('BASELINE');
  });
  it('failed target refresh revokes cached polling scope', async () => {
    const h = setup();
    await h.p.runDue();
    await h.p.drain();
    h.listTargets.mockRejectedValueOnce(new Error('db unavailable'));
    vi.setSystemTime(140000);
    await h.p.runDue();
    await h.p.drain();
    expect(h.p.status().monitoredDevices).toBe(0);
  });
  it('rejects duplicate or out of order persistence', async () => {
    const h = setup();
    await h.p.runDue();
    await h.p.drain();
    h.reader.read.mockResolvedValueOnce([base(100000)]);
    vi.setSystemTime(120000);
    await h.p.runDue();
    await h.p.drain();
    expect(h.store.rows).toHaveLength(1);
  });
  it('stop waits for requests, drops late results and prevents new requests', async () => {
    const h = setup();
    let finish!: (v: FastCounterReading[]) => void;
    h.reader.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await h.p.runDue();
    const stopped = h.p.stop();
    finish([base(100000)]);
    await stopped;
    await h.p.runDue();
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    expect(h.store.rows).toHaveLength(0);
  });
  it('feature flag defaults OFF and invalid scope/config fail closed', () => {
    expect(fastPollerConfig({}).mode).toBe('OFF');
    expect(() => fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'ENFORCE' })).toThrow();
    expect(() => fastPollerConfig({ MITIGATION_FAST_CONCURRENCY: '999' })).toThrow();
    expect(() => fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'typo' })).toThrow();
  });
});
