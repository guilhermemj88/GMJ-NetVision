import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeHost } from '../../test-fixtures';
import type { HuaweiVplsSnmpCollector } from './huawei-vpls-snmp';
import type { HuaweiVsiSshService } from './huawei-vsi-ssh';
import type { MplsRepository } from './mpls-repository';
import { MplsPollingService } from './mpls-polling-service';
import { parseHuaweiL2vc } from './huawei-vsi-ssh-parser';

const COLLECTED_AT = new Date('2026-11-18T12:00:00.000Z');

function host() {
  return makeHost({
    id: 'huawei-mpls',
    hostname: 'ELOI MENDES - SW MPLS',
    vendor: 'Huawei',
    model: 'S6730-H48X6C',
    sshEnabled: true,
    ssh: {
      host: '10.100.101.8',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
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
  } as never);
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

function sshWithL2vc(): HuaweiVsiSshService {
  return {
    readVsi: vi.fn().mockResolvedValue({
      available: true,
      supported: true,
      collectedAt: COLLECTED_AT,
      vsis: [],
      ldpPeers: [],
      l2vcs: parseHuaweiL2vc(` *client interface       : Vlanif900 is up
  session state          : up
  AC status              : up
  VC state               : up
  VC ID                  : 900
  destination            : 10.0.0.5`),
      l2vcSummary: { total: 1, up: 1, down: 0 },
      warnings: [],
      errorSafe: null,
    }),
  } as unknown as HuaweiVsiSshService;
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    saveCollection: vi.fn().mockResolvedValue(undefined),
    touchPolling: vi.fn().mockResolvedValue(undefined),
    saveFailure: vi.fn().mockResolvedValue(undefined),
    isSshFallbackEnabled: vi.fn().mockResolvedValue(true),
    acquireSshLease: vi.fn().mockResolvedValue({ ok: true, leaseId: 'lease-1' }),
    releaseSshLease: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MplsRepository;
}

describe('P6 — orcamento negado NAO rebaixa o estado', () => {
  afterEach(() => vi.useRealTimers());

  it('concorrencia negada: preserva FOUND_L2VC e apenas avanca o polling', async () => {
    const ssh = sshWithL2vc();
    const repo = repository();
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
    const first = await service.poll(host(), 'community');
    expect(first.discoveryState).toBe('FOUND_L2VC');
    expect(repo.saveCollection).toHaveBeenCalledTimes(1);
    expect(ssh.readVsi).toHaveBeenCalledTimes(1);

    // A partir daqui o orcamento persistente nega (outra instancia ocupou).
    vi.mocked(repo.acquireSshLease!).mockResolvedValue({ ok: false, denial: 'CONCURRENCY' });
    vi.setSystemTime(new Date('2026-11-18T12:03:00.000Z'));
    const second = await service.poll(host(), 'community');

    expect(ssh.readVsi).toHaveBeenCalledTimes(1); // nenhuma sessao nova
    expect(repo.saveCollection).toHaveBeenCalledTimes(1); // nada sobrescrito
    expect(repo.touchPolling).toHaveBeenCalledTimes(1);
    expect(second.discoveryState).toBe('UNKNOWN'); // nunca INCOMPLETE
  });

  it('orcamento por hora negado tambem nao rebaixa', async () => {
    const ssh = sshWithL2vc();
    const repo = repository({
      acquireSshLease: vi.fn().mockResolvedValue({ ok: false, denial: 'BUDGET' }),
    });
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const outcome = await service.poll(host(), 'community');

    expect(ssh.readVsi).not.toHaveBeenCalled();
    expect(repo.saveCollection).not.toHaveBeenCalled();
    expect(repo.touchPolling).toHaveBeenCalledTimes(1);
    expect(outcome.discoveryState).toBe('UNKNOWN');
  });

  it('timeout devolve nao-evidencia e nao derruba a coleta', async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    const ssh = { readVsi: vi.fn().mockReturnValue(never) } as unknown as HuaweiVsiSshService;
    const repo = repository();
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const polling = service.poll(host(), 'community');
    await vi.advanceTimersByTimeAsync(46_000);
    const outcome = await polling;

    expect(outcome.discoveryState).toBe('UNKNOWN');
    expect(repo.saveCollection).not.toHaveBeenCalled();
    expect(repo.touchPolling).toHaveBeenCalledTimes(1);
    expect(repo.releaseSshLease).not.toHaveBeenCalled(); // vaga volta quando a sessao encerrar
  });

  it('leitura real (executada) continua gravando o estado', async () => {
    const ssh = sshWithL2vc();
    const repo = repository();
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const outcome = await service.poll(host(), 'community');

    expect(outcome.discoveryState).toBe('FOUND_L2VC');
    expect(repo.saveCollection).toHaveBeenCalledTimes(1);
    expect(repo.acquireSshLease).toHaveBeenCalledTimes(1);
    expect(repo.releaseSshLease).toHaveBeenCalledTimes(1);
  });

  it('dois servicos com o MESMO repositorio respeitam o limite compartilhado', async () => {
    // Simula duas instancias (processos) usando o mesmo orcamento persistente.
    let active = 0;
    let released = 0;
    const shared = repository({
      acquireSshLease: vi.fn(async () => {
        if (active >= 1) return { ok: false as const, denial: 'CONCURRENCY' as const };
        active += 1;
        return { ok: true as const, leaseId: `lease-${active}` };
      }),
      releaseSshLease: vi.fn(async () => {
        active -= 1;
        released += 1;
      }),
    });

    let unblock: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const sshA = {
      readVsi: vi.fn(async () => {
        await slow;
        return { available: true, supported: true, collectedAt: COLLECTED_AT, vsis: [], ldpPeers: [], l2vcs: [], warnings: [], errorSafe: null };
      }),
    } as unknown as HuaweiVsiSshService;
    const sshB = { readVsi: vi.fn() } as unknown as HuaweiVsiSshService;

    const a = new MplsPollingService(emptyCollector(), shared, sshA);
    const b = new MplsPollingService(
      emptyCollector(),
      shared,
      sshB,
      { isSshEnabledForDevice: async () => true },
    );

    const pollA = a.poll(host(), 'community');
    // deixa A adquirir a vaga e travar na leitura lenta
    await new Promise((resolve) => setTimeout(resolve, 0));

    const outcomeB = await b.poll(host(), 'community');
    expect(outcomeB.discoveryState).toBe('UNKNOWN');
    expect(sshB.readVsi).not.toHaveBeenCalled();

    unblock();
    await pollA;
    expect(released).toBe(1);
  });
});
