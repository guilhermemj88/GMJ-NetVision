import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHost } from '../../test-fixtures';
import type { CollectedMplsVsi, HuaweiVplsSnmpCollector } from './huawei-vpls-snmp';
import type { HuaweiVsiSshReading, HuaweiVsiSshService } from './huawei-vsi-ssh';
import type { MplsRepository } from './mpls-repository';
import { MplsPollingService } from './mpls-polling-service';
import {
  decideMplsSsh,
  MplsSshGovernor,
  mplsSshPlatform,
  type MplsSshDenyReason,
} from './mpls-ssh-policy';

const COLLECTED_AT = new Date('2026-11-18T12:00:00.000Z');

function host(overrides: Record<string, unknown> = {}) {
  return makeHost({
    id: 'huawei-mpls',
    hostname: 'ELOI MENDES - SW MPLS',
    vendor: 'Huawei',
    model: 'S6730-H48X6C',
    deviceType: 'switch',
    snmpEnabled: false,
    snmp: null,
    sshEnabled: true,
    ssh: {
      host: '10.100.101.8',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
    ...overrides,
  } as never);
}

function snmpVsi(name = 'VSI-GERENCIA'): CollectedMplsVsi {
  return {
    name,
    signalingType: 'LDP',
    rd: null,
    vsiId: 100,
    status: 'UP',
    operationalStatus: 'UP',
    adminStatus: 'UP',
    mtu: 1500,
    vcType: 'ETHERNET',
    tunnelPolicy: null,
    description: null,
    statusObserved: true,
    statusComplete: true,
    acs: [],
    pws: [],
  };
}

function emptyCollector(): HuaweiVplsSnmpCollector {
  return {
    collect: vi.fn().mockResolvedValue({
      supported: false,
      collectedAt: COLLECTED_AT,
      errors: [],
      capabilities: { vsi: false, ac: false, pw: false },
      collectedColumns: { vsi: [], ac: [], pw: [] },
      vsis: [],
    }),
  } as unknown as HuaweiVplsSnmpCollector;
}

function snmpConfig() {
  return {
    version: 'SNMP_V2C' as const,
    host: '10.100.101.8',
    port: 161,
    username: '',
    securityLevel: 'NO_AUTH_NO_PRIV' as const,
    authProtocol: null,
    privacyProtocol: null,
    credentialConfigured: true,
  };
}

function repository(sshEnabled: boolean | (() => Promise<boolean>)): MplsRepository {
  return {
    saveCollection: vi.fn().mockResolvedValue(undefined),
    touchPolling: vi.fn().mockResolvedValue(undefined),
    saveFailure: vi.fn().mockResolvedValue(undefined),
    isSshFallbackEnabled:
      typeof sshEnabled === 'function' ? vi.fn(sshEnabled) : vi.fn().mockResolvedValue(sshEnabled),
  } as unknown as MplsRepository;
}

function sshService(): HuaweiVsiSshService & { readVsi: ReturnType<typeof vi.fn> } {
  const reading: HuaweiVsiSshReading = {
    available: true,
    supported: true,
    collectedAt: COLLECTED_AT,
    vsis: [],
    ldpPeers: [],
    l2vcs: [],
    warnings: [],
    errorSafe: null,
  };
  return {
    readVsi: vi.fn().mockResolvedValue(reading),
  } as unknown as HuaweiVsiSshService & { readVsi: ReturnType<typeof vi.fn> };
}

describe('A1 — plataforma autorizada a receber CLI MPLS', () => {
  it('aceita Huawei VRP de switch/roteador', () => {
    expect(mplsSshPlatform(host() as never)).toBe('HUAWEI_VRP');
    expect(mplsSshPlatform(host({ model: 'NE40E-X8A' }) as never)).toBe('HUAWEI_VRP');
  });

  it('recusa Juniper, OLT, modelo nao-VRP e fabricante desconhecido', () => {
    expect(mplsSshPlatform(host({ vendor: 'Juniper', model: 'MX204' }) as never)).toBe(
      'UNSUPPORTED',
    );
    expect(mplsSshPlatform(host({ deviceType: 'olt' }) as never)).toBe('UNSUPPORTED');
    expect(mplsSshPlatform(host({ vendor: 'Huawei', model: 'MA5800-X7' }) as never)).toBe(
      'UNSUPPORTED',
    );
    expect(mplsSshPlatform(host({ vendor: '', model: '' }) as never)).toBe('UNSUPPORTED');
    expect(mplsSshPlatform(host({ vendor: 'ZTE', model: 'C320' }) as never)).toBe('UNSUPPORTED');
  });
});

describe('A1 — decisao do fallback CLI', () => {
  const enabled = async () => true;
  const disabled = async () => false;

  it('libera somente Huawei VRP com SSH configurado E habilitacao explicita', async () => {
    await expect(
      decideMplsSsh({ device: host() as never, isEnabledForDevice: enabled }),
    ).resolves.toEqual({ allowed: true, reason: 'ALLOWED' });
  });

  it('nega quando o equipamento nao foi habilitado (default)', async () => {
    await expect(
      decideMplsSsh({ device: host() as never, isEnabledForDevice: disabled }),
    ).resolves.toEqual({ allowed: false, reason: 'NOT_ENABLED_FOR_DEVICE' });
  });

  it('nega Juniper e OLT mesmo com habilitacao ligada', async () => {
    await expect(
      decideMplsSsh({
        device: host({ vendor: 'Juniper', model: 'MX204' }) as never,
        isEnabledForDevice: enabled,
      }),
    ).resolves.toEqual({ allowed: false, reason: 'PLATFORM_NOT_HUAWEI_VRP' });
    await expect(
      decideMplsSsh({ device: host({ deviceType: 'olt' }) as never, isEnabledForDevice: enabled }),
    ).resolves.toEqual({ allowed: false, reason: 'PLATFORM_NOT_HUAWEI_VRP' });
  });

  it('nega quando o host nao tem SSH configurado', async () => {
    await expect(
      decideMplsSsh({
        device: host({ sshEnabled: false, ssh: null }) as never,
        isEnabledForDevice: enabled,
      }),
    ).resolves.toEqual({ allowed: false, reason: 'SSH_NOT_CONFIGURED' });
  });
});

describe('A1 — orcamento de sessoes SSH', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('limita sessoes simultaneas', () => {
    const governor = new MplsSshGovernor({ maxConcurrentSessions: 2 });
    expect(governor.tryAcquire()).toBeNull();
    expect(governor.tryAcquire()).toBeNull();
    expect(governor.tryAcquire()).toBe('CONCURRENCY');
    governor.release();
    expect(governor.tryAcquire()).toBeNull();
  });

  it('limita sessoes por hora e reabre a janela', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
    const governor = new MplsSshGovernor({ maxConcurrentSessions: 5, sessionBudgetPerHour: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(governor.tryAcquire()).toBeNull();
      governor.release();
    }
    expect(governor.tryAcquire()).toBe('BUDGET');
    vi.setSystemTime(new Date('2026-11-18T13:00:01.000Z'));
    expect(governor.tryAcquire()).toBeNull();
  });

  it('devolve o resultado de timeout e libera a vaga quando a sessao realmente encerra', async () => {
    const governor = new MplsSshGovernor({ sessionTimeoutMs: 20, maxConcurrentSessions: 1 });
    let finish: (value: string) => void = () => {};
    const hanging = new Promise<string>((resolve) => {
      finish = resolve;
    });

    const result = await governor.run('host-1', () => hanging, () => 'sem-evidencia');
    expect(result.value).toBe('sem-evidencia');
    // P6: timeout NAO e evidencia — quem chama precisa saber que nada rodou.
    expect(result.executed).toBe(false);
    // A vaga continua ocupada: a sessao SSH ainda esta aberta no transporte.
    expect(governor.activeSessions).toBe(1);
    expect(governor.tryAcquire()).toBe('CONCURRENCY');
    finish('ok');
    await Promise.resolve();
    await Promise.resolve();
    expect(governor.activeSessions).toBe(0);
  });
});

describe('A1 — polling: nenhum comando Huawei fora da politica', () => {
  it('Huawei habilitado: le a CLI e registra a fonte SSH', async () => {
    const ssh = sshService();
    const service = new MplsPollingService(emptyCollector(), repository(true), ssh);

    const outcome = await service.poll(host() as never, 'community');

    expect(ssh.readVsi).toHaveBeenCalledTimes(1);
    expect(outcome.sshDeniedReason).toBeNull();
  });

  it('Huawei sem habilitacao: NAO abre SSH e nao rebaixa o estado anterior', async () => {
    const ssh = sshService();
    const repo = repository(false);
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const outcome = await service.poll(
      host({ snmpEnabled: true, snmp: snmpConfig() }) as never,
      'community',
    );

    expect(ssh.readVsi).not.toHaveBeenCalled();
    expect(repo.touchPolling).toHaveBeenCalledTimes(1);
    expect(repo.saveCollection).not.toHaveBeenCalled();
    expect(outcome.discoveryState).toBe('UNKNOWN');
    expect(outcome.sshDeniedReason).toBe<MplsSshDenyReason>('NOT_ENABLED_FOR_DEVICE');
  });

  it('F1A (NE8000, SSH ligado) nao inicia fallback automaticamente', async () => {
    const ssh = sshService();
    const repo = repository(false);
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    await service.poll(
      host({
        hostname: 'BHE-VTA-F1A-BGP-01',
        model: 'NE8000',
        snmpEnabled: true,
        snmp: snmpConfig(),
      }) as never,
      'community',
    );

    expect(ssh.readVsi).not.toHaveBeenCalled();
    expect(repo.saveCollection).not.toHaveBeenCalled();
    expect(repo.touchPolling).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Juniper', { vendor: 'Juniper', model: 'MX204' }],
    ['OLT Huawei', { vendor: 'Huawei', model: 'MA5800-X7', deviceType: 'olt' }],
    ['fabricante desconhecido', { vendor: '', model: '' }],
  ])('%s: nenhum comando Huawei executado nem com habilitacao ligada', async (_label, patch) => {
    const ssh = sshService();
    const repo = repository(true);
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const outcome = await service.poll(host(patch) as never, 'community');

    expect(ssh.readVsi).not.toHaveBeenCalled();
    expect(outcome.sshDeniedReason).toBe<MplsSshDenyReason>('PLATFORM_NOT_HUAWEI_VRP');
  });

  it('SNMP com evidencia continua sendo gravado mesmo com a CLI negada', async () => {
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: true,
        collectedAt: COLLECTED_AT,
        errors: [],
        capabilities: { vsi: true, ac: true, pw: true },
        collectedColumns: { vsi: [1], ac: [1], pw: [1] },
        vsis: [snmpVsi()],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const ssh = sshService();
    const repo = repository(false);
    const service = new MplsPollingService(collector, repo, ssh);

    await service.poll(
      host({
        snmpEnabled: true,
        snmp: {
          version: 'SNMP_V2C',
          host: '10.100.101.8',
          port: 161,
          username: '',
          securityLevel: 'NO_AUTH_NO_PRIV',
          authProtocol: null,
          privacyProtocol: null,
          credentialConfigured: true,
        },
      }) as never,
      'community',
    );

    expect(ssh.readVsi).not.toHaveBeenCalled();
    expect(repo.saveCollection).toHaveBeenCalledTimes(1);
  });

  it('falha ao ler a habilitacao mantem o fallback desligado', async () => {
    const ssh = sshService();
    const repo = repository(async () => {
      throw new Error('banco indisponivel');
    });
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const outcome = await service.poll(host() as never, 'community');

    expect(ssh.readVsi).not.toHaveBeenCalled();
    expect(outcome.sshDeniedReason).toBe<MplsSshDenyReason>('NOT_ENABLED_FOR_DEVICE');
  });

  it('repositorio sem isSshFallbackEnabled tambem mantem o fallback desligado', async () => {
    const ssh = sshService();
    const repo = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    await service.poll(host() as never, 'community');

    expect(ssh.readVsi).not.toHaveBeenCalled();
  });
});
