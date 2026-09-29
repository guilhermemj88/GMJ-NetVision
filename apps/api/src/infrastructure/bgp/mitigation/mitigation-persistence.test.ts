import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import type { MitigationProfileInput } from './mitigation-repository';

const baseProfile: MitigationProfileInput = {
  deviceId: 'device-1',
  policyName: 'HORIZONTE_IP_40GB',
  interfaceId: 'interface-1',
  detectedBandwidthBps: 40_000_000_000n,
  bandwidthSource: 'DESCRIPTION',
  prefixLimit: 500,
  mode: 'AUTO',
  enabled: true,
  triggerPercent: 90,
  recoveryPercent: 70,
  triggerSamples: 3,
  recoverySamples: 12,
  checkIntervalSeconds: 5,
  mitigationRt: '268568:660',
};

describe('InMemoryMitigationRepository', () => {
  it('creates then updates a profile via upsert', async () => {
    const repository = new InMemoryMitigationRepository();

    const created = await repository.upsertProfile(baseProfile);
    expect(created.id).toBeTruthy();
    expect(created.mode).toBe('AUTO');
    expect(created.prefixLimit).toBe(500);

    const updated = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: 'HORIZONTE_IP_40GB',
      mode: 'ALERT_ONLY',
      bandwidthOverrideBps: 10_000_000_000n,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.mode).toBe('ALERT_ONLY');
    expect(updated.bandwidthOverrideBps).toBe(10_000_000_000n);
    expect(updated.detectedBandwidthBps).toBe(40_000_000_000n);
    expect(updated.policyName).toBe('HORIZONTE_IP_40GB');
    expect(updated.deviceId).toBe('device-1');
  });

  it('keeps multiple peers for the same policy and replaces them atomically', async () => {
    const repository = new InMemoryMitigationRepository();
    const profile = await repository.upsertProfile(baseProfile);

    const peers = await repository.replaceProfilePeers(profile.id, [
      { peerId: 'peer-1', peerAddress: '10.0.0.1', addressFamily: 'IPV4', primary: true },
      { peerAddress: '10.0.0.2', addressFamily: 'IPV4' },
    ]);

    expect(peers).toHaveLength(2);
    expect(await repository.listProfilePeers(profile.id)).toHaveLength(2);

    const replaced = await repository.replaceProfilePeers(profile.id, [
      { peerAddress: '10.0.0.3', addressFamily: 'IPV4', primary: true },
    ]);
    expect(replaced).toHaveLength(1);
    expect(await repository.listProfilePeers(profile.id)).toHaveLength(1);
  });

  it('keeps bandwidth canonical in bps (no Gbps source of truth)', async () => {
    const repository = new InMemoryMitigationRepository();
    const profile = await repository.upsertProfile(baseProfile);

    expect(profile.detectedBandwidthBps).toBe(40_000_000_000n);
    expect(profile.bandwidthOverrideBps).toBeNull();
    expect(profile).not.toHaveProperty('bandwidthGbps');
    expect(profile).not.toHaveProperty('bandwidthBps');
    expect(profile).not.toHaveProperty('bandwidthOverrideGbps');

    await repository.setProfileBandwidthOverride(profile.id, 10_000_000_000n);
    expect((await repository.getProfile(profile.id))?.bandwidthOverrideBps).toBe(10_000_000_000n);

    await repository.setProfileBandwidthOverride(profile.id, null);
    expect((await repository.getProfile(profile.id))?.bandwidthOverrideBps).toBeNull();
  });

  it('enforces a single runtime row per profile and preserves counters/state', async () => {
    const repository = new InMemoryMitigationRepository();
    const profile = await repository.upsertProfile(baseProfile);

    await repository.upsertRuntime(profile.id, {
      state: 'TRIGGER_PENDING',
      currentTrafficBps: 45_000_000_000n,
      peakTrafficBps: 48_000_000_000n,
      triggerCounter: 2,
      plannedNode: 3,
    });
    await repository.upsertRuntime(profile.id, {
      triggerCounter: 3,
      state: 'MITIGATING',
    });

    const runtime = await repository.getRuntime(profile.id);
    expect(runtime).not.toBeNull();
    expect(runtime?.profileId).toBe(profile.id);
    expect(runtime?.state).toBe('MITIGATING');
    expect(runtime?.triggerCounter).toBe(3);
    expect(runtime?.currentTrafficBps).toBe(45_000_000_000n);
    expect(runtime?.peakTrafficBps).toBe(48_000_000_000n);
  });

  it('records simulations and events and lists them newest-first', async () => {
    const repository = new InMemoryMitigationRepository();
    const profile = await repository.upsertProfile(baseProfile);

    const simulation = await repository.createSimulation({
      profileId: profile.id,
      simulatedTrafficBps: 50_000_000_000n,
      calculatedThresholdBps: 36_000_000_000n,
      result: 'WOULD_MITIGATE',
      plannedNode: 4,
      plannedPolicy: 'MIT_40G',
      plannedRt: '268568:660',
      affectedPeers: ['10.0.0.1'],
      commandPreview: ['apply extcommunity rt 268568:660'],
      notificationPublished: true,
    });

    expect(simulation.result).toBe('WOULD_MITIGATE');
    expect(simulation.affectedPeers).toEqual(['10.0.0.1']);
    expect(simulation.notificationPublished).toBe(true);
    expect(simulation).not.toHaveProperty('webhookSent');

    const event = await repository.createEvent({
      profileId: profile.id,
      simulationId: simulation.id,
      type: 'SIMULATION',
      previousState: 'NORMAL',
      newState: 'MITIGATING',
      trafficBps: 50_000_000_000n,
      thresholdBps: 36_000_000_000n,
      success: true,
      verified: false,
    });

    expect(event.profileId).toBe(profile.id);
    expect((await repository.listEvents(profile.id)).length).toBe(1);
    expect((await repository.listSimulations(profile.id)).length).toBe(1);
  });

  it('recovers state from a new repository instance sharing the same store', async () => {
    const first = new InMemoryMitigationRepository();
    const profile = await first.upsertProfile(baseProfile);
    await first.upsertRuntime(profile.id, {
      state: 'RECOVERY_PENDING',
      recoveryCounter: 11,
      plannedNode: 6,
    });
    await first.createEvent({ profileId: profile.id, type: 'STATE_CHANGE', newState: 'RECOVERY_PENDING' });

    // A "nova instância" do worker enxerga apenas o store persistido, não
    // variáveis em memória do processo anterior.
    const second = new InMemoryMitigationRepository(first.storeRef);
    expect(await second.getProfile(profile.id)).not.toBeNull();
    expect((await second.getRuntime(profile.id))?.state).toBe('RECOVERY_PENDING');
    expect((await second.getRuntime(profile.id))?.recoveryCounter).toBe(11);
    expect((await second.listEvents(profile.id)).length).toBe(1);
  });

  it('deleteProfile removes the profile and its children', async () => {
    const repository = new InMemoryMitigationRepository();
    const profile = await repository.upsertProfile(baseProfile);
    await repository.replaceProfilePeers(profile.id, [{ peerAddress: '10.0.0.1' }]);
    await repository.upsertRuntime(profile.id, { state: 'NORMAL' });
    await repository.createSimulation({ profileId: profile.id, result: 'NO_ACTION' });
    await repository.createEvent({ profileId: profile.id, type: 'DELETE' });

    await repository.deleteProfile(profile.id);

    expect(await repository.getProfile(profile.id)).toBeNull();
    expect(await repository.listProfilePeers(profile.id)).toHaveLength(0);
    expect(await repository.getRuntime(profile.id)).toBeNull();
    expect(await repository.listSimulations(profile.id)).toHaveLength(0);
    expect(await repository.listEvents(profile.id)).toHaveLength(0);
  });
});

describe('BGP mitigation persistence schema', () => {
  const migrationPath = resolve(
    process.cwd(),
    'prisma/migrations/20260929000000_add_bgp_ddos_mitigation/migration.sql',
  );

  it('declares the requested foreign keys with explicit delete behavior', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toMatch(/BgpMitigationProfile_deviceId_fkey[\s\S]+ON DELETE CASCADE/);
    expect(migration).toMatch(/BgpMitigationProfile_interfaceId_fkey[\s\S]+ON DELETE SET NULL/);
    expect(migration).toMatch(/BgpMitigationProfilePeer_profileId_fkey[\s\S]+ON DELETE CASCADE/);
    expect(migration).toMatch(/BgpMitigationProfilePeer_peerId_fkey[\s\S]+ON DELETE SET NULL/);
    expect(migration).toMatch(/BgpMitigationRuntime_profileId_fkey[\s\S]+ON DELETE CASCADE/);
    expect(migration).toMatch(/BgpMitigationSimulation_userId_fkey[\s\S]+ON DELETE SET NULL/);
    expect(migration).toMatch(/BgpMitigationEvent_simulationId_fkey[\s\S]+ON DELETE SET NULL/);
  });

  it('enforces a single runtime row per profile and a unique device/policy pair', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE UNIQUE INDEX "BgpMitigationRuntime_profileId_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "BgpMitigationProfile_deviceId_policyName_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "BgpMitigationProfilePeer_profileId_peerAddress_key"');
  });

  it('persists bandwidth only as bps BigInt and never as Float/Decimal', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const profile = schema.slice(
      schema.indexOf('model BgpMitigationProfile {'),
      schema.indexOf('model BgpMitigationProfilePeer {'),
    );

    // Whitespace-insensitive: `prisma format` realinha as colunas do bloco.
    expect(profile).toMatch(/^\s*detectedBandwidthBps\s+BigInt\?$/m);
    expect(profile).toMatch(/^\s*bandwidthOverrideBps\s+BigInt\?$/m);
    expect(profile).not.toMatch(/^\s*bandwidthGbps\s/m);
    expect(profile).not.toMatch(/^\s*bandwidthBps\s/m);
    expect(profile).not.toMatch(/^\s*bandwidthOverrideGbps\s/m);
    expect(profile).not.toMatch(/bandwidth\w*\s+(Float|Decimal)/i);
  });

  it('declares notificationPublished instead of webhookSent', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const simulation = schema.slice(
      schema.indexOf('model BgpMitigationSimulation {'),
      schema.indexOf('model BgpMitigationEvent {'),
    );

    expect(simulation).toMatch(/^\s*notificationPublished\s+Boolean\s+@default\(false\)$/m);
    expect(simulation).not.toContain('webhookSent');
  });

  it('keeps the migration aligned with the bps/notification columns', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('"detectedBandwidthBps" BIGINT');
    expect(migration).toContain('"bandwidthOverrideBps" BIGINT');
    expect(migration).toContain('"notificationPublished" BOOLEAN NOT NULL DEFAULT false');
    expect(migration).not.toMatch(/bandwidthGbps|bandwidthBps|bandwidthOverrideGbps|webhookSent/);
  });

  it('uses structured JSON only where appropriate and never stores SSH credentials', () => {
    const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const mitigation = schema.slice(
      schema.indexOf('model BgpMitigationProfile {'),
      schema.indexOf('model MplsDeviceState {'),
    );

    expect(mitigation).toMatch(/^\s*affectedPeers\s+Json\?$/m);
    expect(mitigation).toMatch(/^\s*commandPreview\s+Json\?$/m);
    expect(mitigation).not.toMatch(/password|token|secret|ssh.*raw/i);
  });
});
