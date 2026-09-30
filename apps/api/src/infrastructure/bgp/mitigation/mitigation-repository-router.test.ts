import { describe, expect, it, vi } from 'vitest';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  createCachedSchemaCheck,
  RoutingMitigationRepository,
} from './mitigation-repository-router';
import type { MitigationRepository } from './mitigation-repository';

/** Simula o Prisma sem a migration aplicada: toda operacao estoura. */
function failingRepository(): MitigationRepository {
  const memory = new InMemoryMitigationRepository();
  return new Proxy(memory, {
    get(target, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(target, property, receiver);
      return async () => {
        throw new Error('relation "BgpMitigationProfile" does not exist');
      };
    },
  });
}

const profileInput = {
  deviceId: 'device-1',
  policyName: 'PL-HORIZONTES_IPv4-IN',
  interfaceId: 'if-1',
  detectedBandwidthBps: 40_000_000_000n,
  bandwidthSource: 'DESCRIPTION' as const,
};

describe('RoutingMitigationRepository', () => {
  it('usa o banco quando o schema esta migrado', async () => {
    const primary = new InMemoryMitigationRepository();
    const fallback = new InMemoryMitigationRepository();
    const repository = new RoutingMitigationRepository(primary, fallback, async () => true);

    const profile = await repository.upsertProfile(profileInput);

    await expect(primary.getProfile(profile.id)).resolves.toMatchObject({
      policyName: profileInput.policyName,
    });
    expect(await fallback.listProfiles()).toHaveLength(0);
  });

  it('usa o espelho em memoria quando a migration ainda nao foi aplicada', async () => {
    const primary = failingRepository();
    const fallback = new InMemoryMitigationRepository();
    const repository = new RoutingMitigationRepository(primary, fallback, async () => false);

    const profile = await repository.upsertProfile(profileInput);
    await repository.replaceProfilePeers(profile.id, [{ peerAddress: '10.200.200.106' }]);

    expect(await fallback.listProfiles()).toHaveLength(1);
    expect(await fallback.listProfilePeers(profile.id)).toHaveLength(1);
    // A listagem do servico passa pelo mesmo roteador.
    expect(await repository.listProfiles()).toHaveLength(1);
  });

  it('cai no espelho em memoria quando o probe falha', async () => {
    const primary = failingRepository();
    const fallback = new InMemoryMitigationRepository();
    const repository = new RoutingMitigationRepository(primary, fallback, async () => {
      throw new Error('database offline');
    });

    const profile = await repository.upsertProfile(profileInput);

    expect(await fallback.getProfile(profile.id)).not.toBeNull();
  });
});

describe('createCachedSchemaCheck', () => {
  it('consulta o probe uma vez por janela de cache', async () => {
    const probe = vi.fn(async () => ({ migrationReady: false, databaseReady: true }));
    let now = 1_000;
    const check = createCachedSchemaCheck(probe, 15_000, () => now);

    expect(await check()).toBe(false);
    now += 5_000;
    expect(await check()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);

    now += 20_000;
    await check();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('trata falha do probe como "nao pronto"', async () => {
    const check = createCachedSchemaCheck(async () => {
      throw new Error('offline');
    });
    await expect(check()).resolves.toBe(false);
  });
});
