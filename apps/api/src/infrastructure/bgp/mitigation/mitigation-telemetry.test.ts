import { describe, expect, it, vi } from 'vitest';
import type { BgpMitigationProfileDto } from '@gmj/shared';
import { diagnoseMitigationTelemetry, type DiagnosticInterface } from './mitigation-telemetry';
import { InterfaceTrafficSource } from '../../../worker/mitigation/mitigation-traffic-source';

const at = new Date('2026-10-18T12:00:00Z');
const profile = (over: Partial<BgpMitigationProfileDto> = {}) =>
  ({
    id: 'p',
    deviceId: 'd',
    interfaceId: 'i',
    interfaceName: 'Eth-Trunk1.3024',
    mode: 'ALERT_ONLY',
    autoTrafficDirection: null,
    addressFamily: 'IPV4',
    ...over,
  }) as BgpMitigationProfileDto;
const iface = (over: Partial<DiagnosticInterface> = {}): DiagnosticInterface => ({
  id: 'i',
  deviceId: 'd',
  name: 'Eth-Trunk1.3024',
  ifIndex: 151,
  adminStatus: 'UP',
  operStatus: 'UP',
  sample: { id: 's', at, rx: 232301595, tx: 1878975895, usable: true, operStatus: 'UP' },
  ...over,
});
const options = () => ({
  now: () => at,
  maxAgeMs: 45_000,
  envDirections: {},
  readInterface: vi.fn(async () => iface()),
  authorization: (p: BgpMitigationProfileDto) =>
    p.mode === 'AUTO' ? ['AUTO_EXECUTION_DISABLED'] : ['PROFILE_MODE_NOT_AUTO'],
});

describe('telemetry diagnostic independent of direction and execution', () => {
  it('shows both real rates without a direction and never authorizes execution', async () => {
    const result = await diagnoseMitigationTelemetry([profile()], options());
    expect(result.entries[0]!).toMatchObject({
      telemetryAvailable: true,
      rxBps: '232301595',
      txBps: '1878975895',
      blockedReason: 'DIRECTION_NOT_CONFIGURED',
      directionSource: null,
      executionAuthorized: false,
    });
  });
  it.each(['RX', 'TX'] as const)('reads persisted %s ahead of ENV', async (direction) => {
    const result = await diagnoseMitigationTelemetry(
      [profile({ autoTrafficDirection: direction })],
      { ...options(), envDirections: { p: 'rx' } },
    );
    expect(result.entries[0]!).toMatchObject({
      direction,
      directionSource: 'PROFILE',
      telemetryAvailable: true,
    });
  });
  it('identifies ENV fallback', async () =>
    expect(
      (await diagnoseMitigationTelemetry([profile()], { ...options(), envDirections: { p: 'tx' } }))
        .entries[0]!,
    ).toMatchObject({ direction: 'TX', directionSource: 'ENV' }));
  it('herda a direcao da INTERFACE e mantem a precedencia PROFILE > ENV > INTERFACE', async () => {
    const fromInterface = await diagnoseMitigationTelemetry(
      [profile({ interfaceTrafficDirection: 'TX' })],
      options(),
    );
    expect(fromInterface.entries[0]!).toMatchObject({
      direction: 'TX',
      directionSource: 'INTERFACE',
      telemetryAvailable: true,
      executionAuthorized: false,
      blockedReason: null,
    });
    expect(fromInterface.entries[0]!.reasons).not.toContain('DIRECTION_NOT_CONFIGURED');
    const fromProfile = await diagnoseMitigationTelemetry(
      [profile({ autoTrafficDirection: 'RX', interfaceTrafficDirection: 'TX' })],
      { ...options(), envDirections: { p: 'tx' } },
    );
    expect(fromProfile.entries[0]!).toMatchObject({
      direction: 'RX',
      directionSource: 'PROFILE',
    });
    const fromEnv = await diagnoseMitigationTelemetry(
      [profile({ interfaceTrafficDirection: 'TX' })],
      { ...options(), envDirections: { p: 'rx' } },
    );
    expect(fromEnv.entries[0]!).toMatchObject({ direction: 'RX', directionSource: 'ENV' });
  });
  it('direcao herdada autoriza execucao somente quando nada mais bloqueia', async () => {
    const result = await diagnoseMitigationTelemetry(
      [profile({ mode: 'AUTO', interfaceTrafficDirection: 'TX', autoPromotedBySweep: false })],
      { ...options(), authorization: () => [] },
    );
    expect(result.entries[0]!).toMatchObject({
      direction: 'TX',
      directionSource: 'INTERFACE',
      telemetryAvailable: true,
      executionAuthorized: true,
      executionBlocks: [],
    });
    const swept = await diagnoseMitigationTelemetry(
      [profile({ mode: 'AUTO', interfaceTrafficDirection: 'TX' })],
      options(),
    );
    expect(swept.entries[0]!.executionAuthorized).toBe(false);
  });
  it('reads shared v4/v6 once and keeps independent mode/direction/authorization', async () => {
    const deps = options();
    const result = await diagnoseMitigationTelemetry(
      [
        profile({ id: 'v4', mode: 'AUTO', autoTrafficDirection: 'TX', autoPromotedBySweep: true }),
        profile({ id: 'v6', addressFamily: 'IPV6' }),
      ],
      deps,
    );
    expect(deps.readInterface).toHaveBeenCalledTimes(1);
    expect(result.entries.map((e) => e.rxBps)).toEqual(['232301595', '232301595']);
    expect(result.entries[1]!).toMatchObject({
      direction: null,
      mode: 'ALERT_ONLY',
      executionAuthorized: false,
      sharedCounterProfileIds: ['v4', 'v6'],
    });
    expect(result.entries[0]!.executionBlocks).toContain('AUTO_EXECUTION_DISABLED');
  });
  it.each<[string, () => DiagnosticInterface | null]>([
    [
      'SAMPLE_STALE',
      () => iface({ sample: { ...iface().sample!, at: new Date(at.getTime() - 45001) } }),
    ],
    ['INVALID_SAMPLE', () => iface({ sample: { ...iface().sample!, tx: NaN } })],
    ['INVALID_SAMPLE', () => iface({ deviceId: 'other' })],
    [
      'INVALID_SAMPLE',
      () => iface({ sample: { ...iface().sample!, at: new Date(at.getTime() + 1) } }),
    ],
    ['SAMPLE_NOT_FOUND', () => iface({ sample: null })],
    ['INTERFACE_ADMIN_DOWN', () => iface({ adminStatus: 'DOWN' })],
    ['INTERFACE_NOT_UP', () => iface({ operStatus: 'DOWN' })],
    ['INTERFACE_NOT_FOUND', () => null],
  ])('reports %s without treating it as SNMP failure', async (reason, value) => {
    const result = await diagnoseMitigationTelemetry([profile({ autoTrafficDirection: 'TX' })], {
      ...options(),
      readInterface: async () => value(),
    });
    expect(result.entries[0]!.reasons).toContain(reason);
    expect(result.entries[0]!.telemetryAvailable).toBe(false);
    expect(result.entries[0]!.reasons).not.toContain('COLLECTION_UNAVAILABLE');
  });
  it('reports missing link and proven source failure separately', async () => {
    expect(
      (await diagnoseMitigationTelemetry([profile({ interfaceId: null })], options())).entries[0]!
        .reasons,
    ).toContain('INTERFACE_NOT_LINKED');
    expect(
      (
        await diagnoseMitigationTelemetry([profile()], {
          ...options(),
          readInterface: async () => {
            throw Error('db');
          },
        })
      ).entries[0]!.reasons,
    ).toContain('COLLECTION_UNAVAILABLE');
  });
  it.each(['ALERT_ONLY', 'DISABLED', 'AUTO'] as const)(
    'keeps %s measurements distinct from execution permission',
    async (mode) => {
      const result = await diagnoseMitigationTelemetry(
        [profile({ mode, autoTrafficDirection: 'RX', autoPromotedBySweep: false })],
        options(),
      );
      expect(result.entries[0]!.telemetryAvailable).toBe(true);
      expect(result.entries[0]!.executionAuthorized).toBe(false);
    },
  );
  it('existing actuator traffic port remains fail closed without direction and selects RX/TX correctly', async () => {
    const read = vi.fn(async () => ({
      interfaceId: 'i',
      deviceId: 'd',
      rxBps: 232301595,
      txBps: 1878975895,
      timestamp: at,
      usable: true,
    }));
    const target = {
      profileId: 'p',
      interfaceId: 'i',
      deviceId: 'd',
      bandwidthBps: 10_000_000_000n,
    };
    expect(
      await new InterfaceTrafficSource(
        { latestTraffic: read },
        { maxAgeMs: 45000, now: () => at },
      ).sampleWithId(target),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
    for (const direction of ['rx', 'tx'] as const)
      expect(
        (
          await new InterfaceTrafficSource(
            { latestTraffic: read },
            { direction, maxAgeMs: 45000, now: () => at },
          ).sampleWithId(target)
        )?.bps,
      ).toBe(direction === 'rx' ? 232301595n : 1878975895n);
  });
});
