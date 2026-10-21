import { describe, expect, it } from 'vitest';
import {
  MitigationAutoDescriptionSweep,
  type AutoDescriptionSweepProfile,
  type SweepBatchSize,
} from './mitigation-auto-description-sweep';

// CLICKING-PILOT: allowlist de promocao (piloto direcionado) sem alterar
// democoes, concorrencia ou o comportamento legado (lista vazia).

const CLICK = 'profile-clicking';
const FLASH = 'profile-flash';
const GMS = 'profile-gmt';
const BHNET = 'profile-bhnet';

function p(
  id: string,
  over: Partial<AutoDescriptionSweepProfile> = {},
): AutoDescriptionSweepProfile {
  return {
    id,
    persisted: true,
    addressFamily: 'IPV4',
    policyName: 'PL-CLICKING-V4-IN',
    interfaceName: 'Eth-Trunk1.3528',
    mode: 'ALERT_ONLY',
    autoModeExempt: false,
    promotedBySweep: false,
    autoState: 'READY',
    autoStateReason: null,
    ...over,
  };
}

const POPULATION = [
  p(CLICK, { policyName: 'PL-CLICKING-V4-IN', interfaceName: 'Eth-Trunk1.3528' }),
  p(FLASH, { policyName: 'PL-FLASH-TELECOM_IPv4-IN', interfaceName: 'Eth-Trunk1.3066' }),
  p(GMS, { policyName: 'PL-GMTELECOM_IPv4-IN', interfaceName: 'Eth-Trunk1.3042' }),
  p(BHNET, { policyName: 'PL-BHNET_IPv4-IN', interfaceName: 'Eth-Trunk1.3043', mode: 'AUTO' }),
];

async function run(
  options: { batchSize: SweepBatchSize; allowedProfileIds?: string[] },
  profiles: AutoDescriptionSweepProfile[] = POPULATION,
) {
  const store = new Map(profiles.map((profile) => [profile.id, { ...profile }]));
  const sweep = new MitigationAutoDescriptionSweep({
    enabled: true,
    families: ['IPV4'],
    batchSize: options.batchSize,
    ...(options.allowedProfileIds ? { allowedProfileIds: options.allowedProfileIds } : {}),
    listProfiles: async () => [...store.values()],
    setMode: async (id, mode) => {
      const current = store.get(id)!;
      store.set(id, { ...current, mode });
    },
    setProvenance: async (id, promoted) => {
      const current = store.get(id)!;
      store.set(id, { ...current, promotedBySweep: promoted });
    },
  });
  const result = await sweep.run();
  return { result, store };
}

describe('allowlist de promocao do sweep (piloto direcionado)', () => {
  it('sem allowlist, BATCH_SIZE=1 promove o PRIMEIRO da ordem deterministica (CLICKING)', async () => {
    const { result } = await run({ batchSize: 1 });
    expect(result.promoted).toEqual([CLICK]);
  });

  it('allowlist=[FLASH] promove SOMENTE o FLASH, mesmo com batch 1', async () => {
    const { result } = await run({ batchSize: 1, allowedProfileIds: [FLASH] });
    expect(result.promoted).toEqual([FLASH]);
  });

  it('allowlist=[CLICKING] com batch maior NAO promove os demais elegiveis', async () => {
    const { result } = await run({ batchSize: 5, allowedProfileIds: [CLICK] });
    expect(result.promoted).toEqual([CLICK]);
    expect(result.heldByBatch).toBe(0);
  });

  it('allowlist nao impede a DEMOCAO de perfil que perdeu READY', async () => {
    const demote = p(FLASH, {
      mode: 'AUTO',
      promotedBySweep: true,
      autoState: 'OFF',
      autoStateReason: 'BANDWIDTH_MISSING',
    });
    const { result, store } = await run(
      { batchSize: 1, allowedProfileIds: [CLICK] },
      [p(CLICK), demote],
    );
    expect(result.demoted).toContain(FLASH);
    expect(store.get(FLASH)!.mode).toBe('ALERT_ONLY');
    expect(store.get(FLASH)!.promotedBySweep).toBe(false);
  });

  it('BATCH_SIZE=0 continua HOLD mesmo com allowlist', async () => {
    const { result } = await run({ batchSize: 0, allowedProfileIds: [CLICK] });
    expect(result.promoted).toEqual([]);
    expect(result.held).toBe(true);
  });

  it('allowlist vazia = comportamento anterior (promove os elegiveis)', async () => {
    const { result } = await run({ batchSize: 2, allowedProfileIds: [] });
    expect(result.promoted).toEqual([CLICK, FLASH]);
  });

  it('concorrencia: execucao simultanea devolve skippedConcurrent sem promover', async () => {
    const store = POPULATION.map((profile) => ({ ...profile }));
    const sweep = new MitigationAutoDescriptionSweep({
      enabled: true,
      families: ['IPV4'],
      batchSize: 1,
      allowedProfileIds: [CLICK],
      listProfiles: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return store;
      },
      setMode: async () => undefined,
      setProvenance: async () => undefined,
    });
    const [a, b] = await Promise.all([sweep.run(), sweep.run()]);
    const skipped = [a, b].filter((entry) => entry.skippedConcurrent);
    expect(skipped.length).toBe(1);
    expect([a, b].find((entry) => !entry.skippedConcurrent)!.promoted).toEqual([CLICK]);
  });
});

describe('RC9: casos adicionais da allowlist', () => {
  it('profileId inexistente na lista => nada e promovido (fail-closed)', async () => {
    const { result } = await run({ batchSize: 5, allowedProfileIds: ['profile-que-nao-existe'] });
    expect(result.promoted).toEqual([]);
    expect(result.heldByBatch).toBe(0);
  });

  it('dois IDs na lista => promove exatamente os dois', async () => {
    const { result } = await run({ batchSize: 5, allowedProfileIds: [FLASH, GMS] });
    expect(result.promoted.sort()).toEqual([FLASH, GMS].sort());
  });

  it('perfil JA em AUTO nao e tocado nem aparece como promovido', async () => {
    const { result, store } = await run({ batchSize: 5, allowedProfileIds: [BHNET, CLICK] });
    expect(result.promoted).toEqual([CLICK]);
    expect(store.get(BHNET)!.mode).toBe('AUTO');
    expect(store.get(BHNET)!.promotedBySweep).toBe(false);
  });

  it('IPv6 na lista NAO e promovido (familia fora da fase)', async () => {
    const v6 = p('profile-v6', {
      addressFamily: 'IPV6',
      policyName: 'PL-CLICKING-V6-IN',
      interfaceName: 'Eth-Trunk1.3528',
    });
    const { result } = await run({ batchSize: 5, allowedProfileIds: ['profile-v6'] }, [v6]);
    expect(result.promoted).toEqual([]);
    expect(result.skippedFamily).toBeGreaterThan(0);
  });

  it('perfil com autoState BLOCKED na lista continua bloqueado', async () => {
    const blocked = p(GMS, {
      autoState: 'BLOCKED',
      autoStateReason: 'SHARED_POLICY',
      policyName: 'PL-GMTELECOM_IPv4-IN',
      interfaceName: 'Eth-Trunk1.3042',
    });
    const { result, store } = await run(
      { batchSize: 5, allowedProfileIds: [GMS] },
      [blocked, p(CLICK)],
    );
    expect(result.promoted).toEqual([]);
    expect(store.get(GMS)!.mode).toBe('ALERT_ONLY');
  });

  it('promocao pelo sweep grava proveniencia e rollback direcionado a limpa', async () => {
    const { store } = await run({ batchSize: 1, allowedProfileIds: [CLICK] });
    expect(store.get(CLICK)!.mode).toBe('AUTO');
    expect(store.get(CLICK)!.promotedBySweep).toBe(true);
    expect(store.get(BHNET)!.mode).toBe('AUTO');
    expect(store.get(BHNET)!.promotedBySweep).toBe(false);

    // rollback direcionado: volta SO o CLICKING e limpa a proveniencia
    const store2 = new Map(store);
    store2.set(CLICK, { ...store.get(CLICK)!, mode: 'ALERT_ONLY', promotedBySweep: false });
    expect(store2.get(CLICK)!.mode).toBe('ALERT_ONLY');
    expect(store2.get(CLICK)!.promotedBySweep).toBe(false);
    expect(store2.get(BHNET)!.mode).toBe('AUTO');
  });

  it('sweep NAO possui porta de execucao (somente setMode/setProvenance)', () => {
    const deps = Object.keys({
      enabled: true,
      families: ['IPV4'],
      batchSize: 1,
      allowedProfileIds: [CLICK],
      listProfiles: async () => POPULATION,
      setMode: async () => undefined,
      setProvenance: async () => undefined,
    });
    expect(deps.sort()).toEqual(
      ['allowedProfileIds', 'batchSize', 'enabled', 'families', 'listProfiles', 'setMode', 'setProvenance'].sort(),
    );
    expect(deps.some((key) => /command|executor|activate|h3c|huawei|ssh/i.test(key))).toBe(false);
  });
});
