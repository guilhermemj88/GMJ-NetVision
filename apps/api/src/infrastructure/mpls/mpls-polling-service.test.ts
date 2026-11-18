import { describe, expect, it, vi } from 'vitest';
import { makeHost } from '../../test-fixtures';
import type { CollectedMplsVsi, HuaweiVplsSnmpCollector } from './huawei-vpls-snmp';
import type { HuaweiVsiSshService } from './huawei-vsi-ssh';
import type { MplsRepository } from './mpls-repository';
import { MplsPollingService } from './mpls-polling-service';
import { parseHuaweiL2vc, parseHuaweiVsiVerbose } from './huawei-vsi-ssh-parser';

const COLLECTED_AT = new Date('2026-08-25T12:00:00.000Z');

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

function host(
  overrides: Partial<Awaited<ReturnType<typeof makeHost>>> = {},
) {
  return makeHost({
    id: 'huawei-mpls',
    hostname: 'SBA-GEN-6730-MPLS-01',
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
    sshEnabled: true,
    ssh: {
      host: '10.100.101.8',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
    ...overrides,
  });
}

function sshService(reading: Awaited<ReturnType<HuaweiVsiSshService['readVsi']>>) {
  return { readVsi: vi.fn().mockResolvedValue(reading) } as unknown as HuaweiVsiSshService;
}

const SSH_VSI = parseHuaweiVsiVerbose(`**VSI Name               : VSI-GERENCIA
  VSI State              : up
  VSI Signaling Type     : ldp
  *Peer Router ID        : 10.20.30.40
   VC State              : up
   Link ID               : 1
`);

describe('MplsPollingService', () => {
  it('isola um timeout SNMP e persiste estado inconclusivo seguro', async () => {
    const collector = {
      collect: vi.fn().mockRejectedValue(new Error('SNMP timeout connecting to 10.100.101.8:161')),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;

    const result = await new MplsPollingService(collector, repository).poll(
      host(),
      'protected-community',
    );

    expect(result).toMatchObject({
      supported: false,
      discoveryState: 'INCOMPLETE',
      error: 'SNMP timeout connecting to 10.100.101.8:161',
    });
    expect(repository.saveFailure).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(repository.saveFailure).mock.calls)).not.toContain(
      'protected-community',
    );
    // O estado inconclusivo e persistido sem apagar o que ja era conhecido.
    expect(vi.mocked(repository.saveCollection).mock.calls[0]?.[1].discoveryState).toBe(
      'INCOMPLETE',
    );
  });

  it('persiste dados parciais e registra as colunas que falharam', async () => {
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: true,
        collectedAt: COLLECTED_AT,
        errors: ['PW .8: SNMP timeout'],
        capabilities: { vsi: true, ac: false, pw: null },
        collectedColumns: { vsi: [3, 6, 7, 33], ac: [2, 3, 4], pw: [6, 7, 13, 14] },
        vsis: [snmpVsi()],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;

    const result = await new MplsPollingService(collector, repository).poll(host(), 'community');

    expect(repository.saveCollection).toHaveBeenCalledOnce();
    expect(repository.saveFailure).toHaveBeenCalledWith(
      'huawei-mpls',
      COLLECTED_AT,
      'Falha parcial na coleta MPLS: PW .8: SNMP timeout',
    );
    expect(result).toMatchObject({
      supported: true,
      discoveryState: 'FOUND_UP',
      error: 'Falha parcial na coleta MPLS: PW .8: SNMP timeout',
    });
  });

  it('encontra VSI LDP via SSH mesmo com a MIB vazia', async () => {
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: false,
        collectedAt: COLLECTED_AT,
        errors: [],
        capabilities: { vsi: false, ac: false, pw: false },
        collectedColumns: { vsi: [], ac: [], pw: [] },
        vsis: [],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;

    const result = await new MplsPollingService(
      collector,
      repository,
      sshService({
        available: true,
        supported: true,
        collectedAt: COLLECTED_AT,
        vsis: SSH_VSI,
        ldpPeers: [],
        l2vcs: [],
        warnings: [],
        errorSafe: null,
      }),
    ).poll(host(), 'community');

    expect(result).toMatchObject({ supported: true, discoveryState: 'FOUND_UP' });
    expect(result.sources).toEqual(['SNMP', 'SSH']);
    const saved = vi.mocked(repository.saveCollection).mock.calls[0]?.[1];
    expect(saved?.vsis[0]).toMatchObject({ name: 'VSI-GERENCIA', source: 'SSH' });
  });

  it('coleta por SSH quando o SNMP nao esta configurado', async () => {
    const collector = { collect: vi.fn() } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;

    const result = await new MplsPollingService(
      collector,
      repository,
      sshService({
        available: true,
        supported: true,
        collectedAt: COLLECTED_AT,
        vsis: SSH_VSI,
        ldpPeers: [],
        l2vcs: [],
        warnings: [],
        errorSafe: null,
      }),
    ).poll(host({ snmpEnabled: false, snmp: null }), 'community');

    expect(collector.collect).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      supported: true,
      discoveryState: 'FOUND_UP',
      sources: ['SSH'],
    });
  });

  it('nao conclui ausencia quando MIB vazia e SSH nao reconhece o comando', async () => {
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: false,
        collectedAt: COLLECTED_AT,
        errors: [],
        capabilities: { vsi: false, ac: false, pw: false },
        collectedColumns: { vsi: [], ac: [], pw: [] },
        vsis: [],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;

    const result = await new MplsPollingService(
      collector,
      repository,
      sshService({
        available: false,
        supported: false,
        collectedAt: COLLECTED_AT,
        vsis: [],
        ldpPeers: [],
        l2vcs: [],
        warnings: ['VSI: comando não suportado pelo VRP'],
        errorSafe: 'O equipamento não reconheceu o comando de VSI/VPLS.',
      }),
    ).poll(host(), 'community');

    expect(result.discoveryState).toBe('UNSUPPORTED');
    expect(result.supported).toBe(false);
  });

  it('nao faz nada quando o host nao tem SNMP nem SSH', async () => {    const collector = { collect: vi.fn() } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn(),
      saveFailure: vi.fn(),
    } as unknown as MplsRepository;

    const result = await new MplsPollingService(collector, repository).poll(
      host({ snmpEnabled: false, snmp: null, sshEnabled: false, ssh: null }),
      'community',
    );

    expect(result).toMatchObject({ supported: null, discoveryState: 'UNKNOWN' });
    expect(repository.saveCollection).not.toHaveBeenCalled();
  });

  it('nao abre uma sessao SSH a cada poll quando a MIB ja entrega VSI', async () => {
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: true,
        collectedAt: COLLECTED_AT,
        errors: [],
        capabilities: { vsi: true, ac: true, pw: true },
        collectedColumns: { vsi: [3, 6, 7, 33], ac: [2], pw: [6] },
        vsis: [snmpVsi()],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;
    const ssh = sshService({
      available: true,
      supported: true,
      collectedAt: COLLECTED_AT,
      vsis: SSH_VSI,
      ldpPeers: [],
      l2vcs: [],
      warnings: [],
      errorSafe: null,
    });
    const service = new MplsPollingService(collector, repository, ssh);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
      await service.poll(host(), 'community');
      vi.setSystemTime(new Date('2026-11-18T12:01:00.000Z'));
      await service.poll(host(), 'community');
      expect(ssh.readVsi).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('repete a leitura CLI no ritmo do fallback quando a MIB segue vazia', async () => {
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: false,
        collectedAt: COLLECTED_AT,
        errors: [],
        capabilities: { vsi: false, ac: false, pw: false },
        collectedColumns: { vsi: [], ac: [], pw: [] },
        vsis: [],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;
    const ssh = sshService({
      available: true,
      supported: true,
      collectedAt: COLLECTED_AT,
      vsis: SSH_VSI,
      ldpPeers: [],
      l2vcs: [],
      warnings: [],
      errorSafe: null,
    });
    const service = new MplsPollingService(collector, repository, ssh);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
      await service.poll(host(), 'community');
      vi.setSystemTime(new Date('2026-11-18T12:03:00.000Z'));
      await service.poll(host(), 'community');
      expect(ssh.readVsi).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
it('nao sobrescreve o estado quando a rodada e so SNMP e a MIB segue sem VSI', async () => {
    // Host so de L2VC: a evidencia vem da CLI. Na rodada em que a CLI ainda
    // esta no intervalo de cadencia nao ha nada novo para gravar.
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: false,
        collectedAt: COLLECTED_AT,
        errors: [],
        capabilities: { vsi: false, ac: false, pw: false },
        collectedColumns: { vsi: [], ac: [], pw: [] },
        vsis: [],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;
    const ssh = sshService({
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
    });
    const service = new MplsPollingService(collector, repository, ssh);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
      const first = await service.poll(host(), 'community');
      vi.setSystemTime(new Date('2026-11-18T12:01:00.000Z'));
      const second = await service.poll(host(), 'community');

      expect(first.discoveryState).toBe('FOUND_L2VC');
      expect(repository.saveCollection).toHaveBeenCalledTimes(1);
      expect(repository.touchPolling).toHaveBeenCalledTimes(1);
      expect(second.discoveryState).toBe('UNKNOWN');
      expect(ssh.readVsi).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continua gravando quando a MIB entrega VSI, mesmo com a CLI no intervalo', async () => {
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
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;
    const ssh = sshService({
      available: true,
      supported: true,
      collectedAt: COLLECTED_AT,
      vsis: SSH_VSI,
      ldpPeers: [],
      l2vcs: [],
      warnings: [],
      errorSafe: null,
    });
    const service = new MplsPollingService(collector, repository, ssh);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
      await service.poll(host(), 'community');
      vi.setSystemTime(new Date('2026-11-18T12:01:00.000Z'));
      await service.poll(host(), 'community');

      expect(repository.saveCollection).toHaveBeenCalledTimes(2);
      expect(repository.touchPolling).not.toHaveBeenCalled();
      expect(ssh.readVsi).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('grava INCOMPLETE quando a CLI foi tentada e nao respondeu', async () => {
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: false,
        collectedAt: COLLECTED_AT,
        errors: [],
        capabilities: { vsi: false, ac: false, pw: false },
        collectedColumns: { vsi: [], ac: [], pw: [] },
        vsis: [],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      touchPolling: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;
    const ssh = sshService({
      available: false,
      supported: null,
      collectedAt: COLLECTED_AT,
      vsis: [],
      ldpPeers: [],
      l2vcs: [],
      warnings: [],
      errorSafe: 'SSH connection timeout',
    });
    const service = new MplsPollingService(collector, repository, ssh);

    const outcome = await service.poll(host(), 'community');

    expect(outcome.discoveryState).toBe('INCOMPLETE');
    expect(repository.saveCollection).toHaveBeenCalledTimes(1);
    expect(repository.touchPolling).not.toHaveBeenCalled();
  });
});