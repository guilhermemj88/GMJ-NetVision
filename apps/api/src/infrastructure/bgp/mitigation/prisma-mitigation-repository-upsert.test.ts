import { describe, expect, it, vi } from 'vitest';
import { PrismaMitigationRepository } from './prisma-mitigation-repository';

// REGRESSAO: o CREATE do upsertProfile precisa gravar addressFamily explicito.
// Sem isso, um target IPv6 era criado com o default IPV4 do schema e o proximo
// discovery tentava criar de novo -> colisao na unique (P2002) -> warning de
// "nao foi possivel persistir o profile".

type UpsertArgs = {
  where: { deviceId_interfaceId_addressFamily_policyName: Record<string, string | undefined> };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

function fakePrisma() {
  const calls: UpsertArgs[] = [];
  const prisma = {
    bgpMitigationProfile: {
      upsert: vi.fn(async (args: UpsertArgs) => {
        calls.push(args);
        return {
          id: 'profile-1',
          deviceId: args.where.deviceId_interfaceId_addressFamily_policyName.deviceId,
          policyName: args.where.deviceId_interfaceId_addressFamily_policyName.policyName,
          addressFamily: args.create.addressFamily ?? args.update.addressFamily ?? 'IPV4',
          interfaceId: args.where.deviceId_interfaceId_addressFamily_policyName.interfaceId,
          detectedBandwidthBps: null, bandwidthSource: 'UNKNOWN', bandwidthOverrideBps: null,
          prefixLimit: 100, mode: 'ALERT_ONLY', enabled: true, triggerPercent: 90,
          recoveryPercent: 70, triggerSamples: 3, recoverySamples: 12,
          checkIntervalSeconds: 5, mitigationRt: '268568:660', mitigationExcluded: false,
          mitigationExclusionReason: null, mitigationExclusionNote: null,
          createdAt: new Date(), updatedAt: new Date(),
        };
      }),
    },
  };
  return { prisma, calls };
}

const base = {
  deviceId: 'device-1',
  policyName: 'PL-HORIZONTES_IPv6-IN',
  interfaceId: 'if-1',
  detectedBandwidthBps: 40_000_000_000n,
  bandwidthSource: 'DESCRIPTION' as const,
};

describe('upsertProfile — addressFamily no CREATE', () => {
  it('IPv6 e gravado como IPV6 (nao cai no default IPV4)', async () => {
    const { prisma, calls } = fakePrisma();
    const repo = new PrismaMitigationRepository(prisma as never);
    const row = await repo.upsertProfile({ ...base, addressFamily: 'IPV6' });
    expect(calls[0]!.create.addressFamily).toBe('IPV6');
    expect(calls[0]!.where.deviceId_interfaceId_addressFamily_policyName.addressFamily).toBe('IPV6');
    expect(row.addressFamily).toBe('IPV6');
  });

  it('mesma identidade IPv6: udpate sem duplicar (mesmo id, mesma chave)', async () => {
    const { prisma, calls } = fakePrisma();
    const repo = new PrismaMitigationRepository(prisma as never);
    const a = await repo.upsertProfile({ ...base, addressFamily: 'IPV6' });
    const b = await repo.upsertProfile({ ...base, addressFamily: 'IPV6', mode: 'AUTO' });
    expect(a.id).toBe(b.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.where.deviceId_interfaceId_addressFamily_policyName.addressFamily).toBe('IPV6');
    expect(calls[1]!.create.addressFamily).toBe('IPV6');
  });

  it('IPv4 explicito e default sem addressFamily continuam IPV4 (sem regressao)', async () => {
    const { prisma, calls } = fakePrisma();
    const repo = new PrismaMitigationRepository(prisma as never);
    await repo.upsertProfile({ ...base, policyName: 'PL-X_IPv4-IN', addressFamily: 'IPV4' });
    await repo.upsertProfile({ ...base, policyName: 'PL-Y_IPv4-IN' });
    expect(calls[0]!.create.addressFamily).toBe('IPV4');
    expect(calls[1]!.create.addressFamily).toBe('IPV4');
  });

  it('IPv4 e IPv6 na MESMA device/interface geram chaves distintas', async () => {
    const { prisma, calls } = fakePrisma();
    const repo = new PrismaMitigationRepository(prisma as never);
    await repo.upsertProfile({ ...base, addressFamily: 'IPV4' });
    await repo.upsertProfile({ ...base, addressFamily: 'IPV6' });
    expect(calls[0]!.where.deviceId_interfaceId_addressFamily_policyName.addressFamily).toBe('IPV4');
    expect(calls[1]!.where.deviceId_interfaceId_addressFamily_policyName.addressFamily).toBe('IPV6');
    expect(calls[0]!.create.addressFamily).not.toBe(calls[1]!.create.addressFamily);
  });
});