import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { HuaweiBgpSshService } from './huawei-bgp-ssh';
import { BgpPlatformProviders } from './bgp-platform-providers';
import type { BgpSshDiscoveryReading } from './bgp-ssh-discovery';
import type { BgpSnmpCollector } from './bgp-snmp-collector';
import type { HostRepository } from '../persistence/host-repository';

/**
 * P4 (2a auditoria): todas as LEITURAS do transporte Huawei passam por um unico
 * ponto (`createClient`). Se a plataforma nao for Huawei VRP comprovada, nenhuma
 * sessao SSH e aberta — nem para descobrir BGP, nem para ler configuracao de
 * mitigacao, route-policy, evidencia fisica ou rotas anunciadas.
 */
function device(patch: Record<string, unknown>): HostRecord {
  return {
    id: 'host-x',
    hostname: 'HOST-X',
    sshEnabled: true,
    ssh: { host: '10.0.0.1', port: 22, username: 'operator' },
    ...patch,
  } as unknown as HostRecord;
}

const PLATAFORMAS = [
  ['Juniper', { vendor: 'Juniper', model: 'MX204' }],
  ['OLT Huawei', { vendor: 'Huawei', model: 'MA5800-X7', deviceType: 'olt' }],
  ['fabricante ausente', { vendor: '', model: '' }],
  ['contraditorio', { vendor: 'Huawei', model: 'MX204' }],
] as const;

function service() {
  const factory = vi.fn();
  const repository = {
    getDecryptedSshCredentials: vi.fn().mockResolvedValue({ username: 'operator', password: 'x' }),
  } as unknown as HostRepository;
  return { factory, ssh: new HuaweiBgpSshService(repository, factory as never) };
}

describe('P4 — leituras Huawei recusam plataforma nao-Huawei sem abrir SSH', () => {
  /** Aceita rejeicao com o codigo da P4 ou resultado tipado que nao seja sucesso. */
  async function expectRefused(run: () => Promise<unknown>): Promise<void> {
    const outcome = await run().catch((error: unknown) => error);
    if (outcome instanceof Error) {
      // Recusa antecipada: plataforma (P4) ou guarda read-only — em ambos os
      // casos nada foi enviado ao equipamento.
      expect(outcome.message).toMatch(/HUAWEI_CLI_PLATFORM_NOT_SUPPORTED|READ_ONLY_VIOLATION/);
      return;
    }
    expect(JSON.stringify(outcome ?? null)).not.toMatch(/"status":"SUCCESS"/);
  }

  it.each(PLATAFORMAS)('%s: descoberta, anuncios, mitigacao, policy e evidencia', async (_n, patch) => {
    const { factory, ssh } = service();
    const target = device(patch);

    await expectRefused(() => ssh.discover(target));
    await expectRefused(() =>
      ssh.readAdvertisedRoutes(target, { peerAddress: '10.1.1.1', addressFamily: 'IPV4' }),
    );
    await expectRefused(() =>
      ssh.readAdminState(target, { peerAddress: '10.1.1.1', addressFamily: 'IPV4' }),
    );
    await expectRefused(() => ssh.readMitigationConfiguration(target));
    await expectRefused(() => ssh.readMitigationRoutePolicy(target, 'PL-X_IPv4-IN'));
    await expectRefused(() =>
      ssh.readMitigationDisplays(target, ['display bgp peer 10.1.1.1 verbose']),
    );
    await expectRefused(() =>
      ssh.applyAdminState(target, { peerAddress: '10.1.1.1', localAs: 65000n, action: 'DISABLE' }),
    );
    await expect(ssh.applyMitigationCommands(target, ['system-view'])).resolves.toMatchObject({
      ok: false,
    });

    expect(factory).not.toHaveBeenCalled();
  });

  it('Huawei VRP identificado continua sendo atendido', async () => {
    const { factory, ssh } = service();
    factory.mockImplementation(() => {
      throw new Error('parada controlada no teste');
    });

    // A chamada passa do gate de plataforma e chega ao transporte (que aqui
    // falha de proposito): e a prova de que o gate nao bloqueia Huawei valido.
    await expect(
      ssh.discover(device({ vendor: 'Huawei', model: 'S6730-H48X6C' })),
    ).rejects.toThrow(/parada controlada/);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('P4 — descoberta BGP por plataforma', () => {
  function providers() {
    const huaweiDiscover = vi.fn();
    const juniperDiscover = vi.fn();
    const collector = { collect: vi.fn().mockResolvedValue({ errors: [] }) } as unknown as BgpSnmpCollector;
    return {
      huaweiDiscover,
      platforms: new BgpPlatformProviders({
        huaweiSsh: { discover: huaweiDiscover } as never,
        juniperSsh: { discover: juniperDiscover } as never,
        huaweiSnmp: collector,
        juniperSnmp: collector,
      }),
    };
  }

  it('nao chama o provider Huawei para fabricante desconhecido', async () => {
    const { huaweiDiscover, platforms } = providers();
    const reading: BgpSshDiscoveryReading = await platforms.discover(
      device({ vendor: '', model: '' }),
    );
    expect(huaweiDiscover).not.toHaveBeenCalled();
    expect(reading.peers).toEqual([]);
    expect(reading.warnings.join(' ')).toMatch(/Plataforma nao homologada/);
  });

  it('chama o provider Huawei para Huawei VRP', async () => {
    const { huaweiDiscover, platforms } = providers();
    huaweiDiscover.mockResolvedValue({ peers: [], warnings: [] });
    await platforms.discover(device({ vendor: 'Huawei', model: 'NE8000' }));
    expect(huaweiDiscover).toHaveBeenCalledTimes(1);
  });
});
