import { describe, expect, it } from 'vitest';
import {
  FAST_SAMPLING_WINDOW,
  isFastRoutedProfile,
  legacySamplingWindow,
  matchesAutoEvidence,
  samplingWindowForProfile,
  withinSamplingWindow,
} from './mitigation-sampling-policy';
import { fastBridgeConfig } from './fast-observation-bridge';
import { fastPollerConfig } from '../../infrastructure/snmp/fast-traffic-poller';
import type { MitigationTrafficSample } from './mitigation-traffic-source';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';

const epoch = Date.parse('2026-10-18T14:00:00Z');

const sample = (overrides: Partial<MitigationTrafficSample> = {}): MitigationTrafficSample => ({
  bps: 9_500_000_000n,
  sampleKey: 'legacy-1',
  occurredAt: new Date(epoch),
  rateStartAt: new Date(epoch - 126_000),
  continuityKey: 'ne8000:if3043:200:tx',
  ...overrides,
});

const config = (env: Record<string, string>, embedded: Record<string, string> = {}) => ({
  legacyMaxAgeMs: 600_000,
  bridge: fastBridgeConfig(env),
  embedded: fastPollerConfig(embedded),
});

describe('sampling contract: LEGACY keeps freshness only, FAST keeps freshness and continuity', () => {
  it('legacy window has no continuity rule', () => {
    expect(legacySamplingWindow(600_000)).toEqual({ maxAgeMs: 600_000, maxGapMs: null });
  });

  it('a bridge in SHADOW never changes the timing of the operational LEGACY source', () => {
    const shadow = config({
      MITIGATION_FAST_BRIDGE_MODE: 'SHADOW',
      MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'bhnet',
    });
    expect(samplingWindowForProfile('bhnet', shadow)).toEqual({
      maxAgeMs: 600_000,
      maxGapMs: null,
    });
    expect(isFastRoutedProfile('bhnet', shadow)).toBe(false);
  });

  it('only an ENFORCE scope routed to the profile applies the FAST window', () => {
    const enforce = config({
      MITIGATION_FAST_BRIDGE_MODE: 'ENFORCE',
      MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'bhnet,other',
      MITIGATION_FAST_ENFORCE_PROFILE_IDS: 'bhnet',
      MITIGATION_FAST_BRIDGE_WRITES_ENABLED: 'true',
    });
    expect(samplingWindowForProfile('bhnet', enforce)).toEqual(FAST_SAMPLING_WINDOW);
    expect(isFastRoutedProfile('bhnet', enforce)).toBe(true);
    expect(samplingWindowForProfile('other', enforce)).toEqual({
      maxAgeMs: 600_000,
      maxGapMs: null,
    });
    expect(isFastRoutedProfile('other', enforce)).toBe(false);
  });

  it('falls back to the legacy contract when no FAST source is routed', () => {
    const off = config({});
    expect(samplingWindowForProfile('bhnet', off)).toEqual({ maxAgeMs: 600_000, maxGapMs: null });
    const embedded = config(
      {},
      {
        MITIGATION_FAST_POLL_MODE: 'ENFORCE',
        MITIGATION_FAST_PROFILE_IDS: 'bhnet',
      },
    );
    expect(samplingWindowForProfile('bhnet', embedded)).toEqual({
      maxAgeMs: 15_000,
      maxGapMs: 15_000,
    });
  });
});

describe('withinSamplingWindow', () => {
  it('AUTO-ALL dynamic profiles use the strict embedded window and are Growth eligible', () => {
    const dynamic = config({}, { MITIGATION_FAST_POLL_MODE: 'ENFORCE',
      MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED: '1', MITIGATION_FAST_NORMAL_SECONDS: '5' });
    expect(isFastRoutedProfile('newly-discovered', dynamic)).toBe(true);
    expect(samplingWindowForProfile('newly-discovered', dynamic)).toEqual({ maxAgeMs:15000, maxGapMs:15000 });
  });
  const legacy = legacySamplingWindow(600_000);

  it('accepts the real BHNET cadence (126 s and 248 s) under LEGACY', () => {
    for (const intervalMs of [126_000, 248_000]) {
      const s = sample({
        occurredAt: new Date(epoch + intervalMs),
        rateStartAt: new Date(epoch),
      });
      expect(withinSamplingWindow(s, epoch + intervalMs + 1_000, legacy)).toBe(true);
    }
  });

  it('applies the published 600 s freshness boundary', () => {
    expect(
      withinSamplingWindow(sample({ occurredAt: new Date(epoch - 599_000), rateStartAt: null }), epoch, legacy),
    ).toBe(true);
    expect(
      withinSamplingWindow(sample({ occurredAt: new Date(epoch - 600_000), rateStartAt: null }), epoch, legacy),
    ).toBe(true);
    expect(
      withinSamplingWindow(sample({ occurredAt: new Date(epoch - 601_000), rateStartAt: null }), epoch, legacy),
    ).toBe(false);
  });

  it('keeps FAST strict on age and on continuity', () => {
    const ok = sample({
      occurredAt: new Date(epoch - 10_000),
      rateStartAt: new Date(epoch - 20_000),
    });
    expect(withinSamplingWindow(ok, epoch, FAST_SAMPLING_WINDOW)).toBe(true);
    expect(
      withinSamplingWindow({ ...ok, occurredAt: new Date(epoch - 31_000) }, epoch, FAST_SAMPLING_WINDOW),
    ).toBe(false);
    const gap = sample({
      occurredAt: new Date(epoch - 10_000),
      rateStartAt: new Date(epoch - 60_000),
    });
    expect(withinSamplingWindow(gap, epoch, FAST_SAMPLING_WINDOW)).toBe(false);
  });

  it('rejects absent samples and negative rates', () => {
    expect(withinSamplingWindow(null, epoch, legacy)).toBe(false);
    expect(withinSamplingWindow(sample({ bps: -1n }), epoch, legacy)).toBe(false);
  });
});

describe('matchesAutoEvidence', () => {
  const legacy = legacySamplingWindow(600_000);
  const s = sample({
    occurredAt: new Date(epoch - 80_000),
    rateStartAt: new Date(epoch - 206_000),
  });
  const evidence = { sampleAt: s.occurredAt!.toISOString(), continuityKey: s.continuityKey! };

  it('revalidates the same sample with the source window', () => {
    expect(matchesAutoEvidence(s, evidence, legacy, epoch)).toBe(true);
    expect(matchesAutoEvidence(s, evidence, FAST_SAMPLING_WINDOW, epoch)).toBe(false);
    expect(matchesAutoEvidence(s, evidence, legacy, epoch + 600_001)).toBe(false);
  });

  it('rejects continuity changes and older samples', () => {
    expect(matchesAutoEvidence({ ...s, continuityKey: 'changed' }, evidence, legacy, epoch)).toBe(
      false,
    );
    expect(
      matchesAutoEvidence({ ...s, occurredAt: new Date(epoch + 1) }, evidence, legacy, epoch),
    ).toBe(false);
  });
});

describe('engine contract', () => {
  const target: MitigationAutoTargetState = {
    profileId: 'p',
    deviceId: 'd',
    interfaceId: null,
    customer: null,
    mode: 'AUTO',
    snapshotAvailable: true,
    readiness: 'READY',
    prefixStatus: 'SAFE',
    blockedReason: null,
    mitigationExcluded: false,
    runtimeState: null,
    effectiveBandwidthBps: null,
    bogonNode: null,
    mitigationNode: null,
    sharedPolicy: false,
    peerAddresses: [],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
  };

  it('refuses to start without an explicit sampling policy', () => {
    expect(
      () =>
        new MitigationAutoEngine({
          globalMode: 'AUTO',
          execution: { executor: 'MOCK', liveWrite: false, allowedDeviceIds: [] },
          targets: { list: async () => [target] },
          traffic: { sample: async () => null, sampleWithId: async () => null },
          exclusions: { listPeerExclusions: async () => [] },
          runtime: { get: async () => null, save: async () => undefined },
          commands: { execute: async () => ({ ok: false, status: 'X', verified: false }) },
        } as never),
    ).toThrow('MITIGATION_AUTO_SAMPLING_REQUIRED');
  });
});
