import { describe, expect, it, vi } from 'vitest';
import { makeHost } from '../../test-fixtures';
import type { HuaweiVplsSnmpCollector } from './huawei-vpls-snmp';
import type { HuaweiVsiSshService } from './huawei-vsi-ssh';
import type { MplsRepository } from './mpls-repository';
import { MplsPollingService } from './mpls-polling-service';
import { parseHuaweiL2vc } from './huawei-vsi-ssh-parser';
import { classifyMplsSshFailure, mplsSshFailureOf } from './mpls-ssh-failure';

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

function reading(overrides: Record<string, unknown>) {
  return {
    available: false,
    supported: null,
    collectedAt: COLLECTED_AT,
    vsis: [],
    ldpPeers: [],
    l2vcs: [],
    l2vcSummary: { total: 0, up: 0, down: 0 },
    warnings: [],
    errorSafe: null,
    ...overrides,
  };
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    saveCollection: vi.fn().mockResolvedValue(undefined),
    touchPolling: vi.fn().mockResolvedValue(undefined),
    saveFailure: vi.fn().mockResolvedValue(undefined),
    isSshFallbackEnabled: vi.fn().mockResolvedValue(true),
    acquireSshLease: vi.fn().mockResolvedValue({ ok: true, leaseId: 'l1' }),
    releaseSshLease: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MplsRepository;
}

const L2VC_READING = () =>
  reading({
    available: true,
    supported: true,
    l2vcs: parseHuaweiL2vc(` *client interface       : Vlanif900 is up
  session state          : up
  AC status              : up
  VC state               : up
  VC ID                  : 900
  destination            : 10.0.0.5`),
    l2vcSummary: { total: 1, up: 1, down: 0 },
  });

describe('A1-b — classificacao da falha de CLI', () => {
  it('reconhece os motivos que o coletor normaliza', () => {
    expect(classifyMplsSshFailure('SSH authentication failed')).toBe('AUTH');
    expect(classifyMplsSshFailure('SSH connection timeout')).toBe('TIMEOUT');
    expect(classifyMplsSshFailure('SSH host is unreachable')).toBe('UNREACHABLE');
    expect(classifyMplsSshFailure('connect ECONNREFUSED 10.0.0.1:22')).toBe('REFUSED');
    expect(classifyMplsSshFailure('SSH command failed')).toBe('NO_RESPONSE');
    expect(classifyMplsSshFailure('SSH não está habilitado para este host')).toBe(
      'NOT_CONFIGURED',
    );
    expect(classifyMplsSshFailure('algo inesperado')).toBe('OTHER');
  });

  it('somente ausencia de leitura conta como falha; leitura vazia e evidencia', () => {
    expect(mplsSshFailureOf(reading({ available: true, supported: true }))).toBeNull();
    expect(mplsSshFailureOf(reading({ available: false, supported: false }))).toBeNull();
    expect(
      mplsSshFailureOf(reading({ available: false, errorSafe: 'SSH authentication failed' })),
    ).toBe('AUTH');
  });
});

describe('A1-b — falha de SSH nao rebaixa a descoberta', () => {
  const casos: Array<[string, Record<string, unknown>, string]> = [
    ['connection refused', reading({ errorSafe: 'ECONNREFUSED 10.100.101.8:22' }), 'REFUSED'],
    ['timeout', reading({ errorSafe: 'SSH connection timeout' }), 'TIMEOUT'],
    ['falha de autenticacao', reading({ errorSafe: 'SSH authentication failed' }), 'AUTH'],
    ['sessao encerrada antes da resposta', reading({ errorSafe: 'SSH command failed' }), 'NO_RESPONSE'],
  ];

  for (const [nome, valor, esperado] of casos) {
    it(`${nome}: preserva o estado e apenas avanca o polling`, async () => {
      const ssh = { readVsi: vi.fn().mockResolvedValue(valor) } as unknown as HuaweiVsiSshService;
      const repo = repository();
      const service = new MplsPollingService(emptyCollector(), repo, ssh);

      const outcome = await service.poll(host(), 'community');

      expect(outcome.discoveryState).toBe('UNKNOWN');
      expect(outcome.sshFailure).toBe(esperado);
      expect(repo.saveCollection).not.toHaveBeenCalled();
      expect(repo.touchPolling).toHaveBeenCalledTimes(1);
      expect(repo.saveFailure).toHaveBeenCalledWith(
        'huawei-mpls',
        expect.any(Date),
        expect.stringContaining(esperado),
      );
    });
  }

  it('excecao do servico SSH tambem e falha, nao ausencia de servico', async () => {
    const ssh = {
      readVsi: vi.fn().mockRejectedValue(new Error('Timed out while waiting for handshake')),
    } as unknown as HuaweiVsiSshService;
    const repo = repository();
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const outcome = await service.poll(host(), 'community');

    expect(outcome.discoveryState).toBe('UNKNOWN');
    expect(outcome.sshFailure).toBe('TIMEOUT');
    expect(repo.saveCollection).not.toHaveBeenCalled();
    expect(repo.touchPolling).toHaveBeenCalledTimes(1);
  });

  it('coleta VALIDA sem VSI continua sendo evidencia de ausencia', async () => {
    const ssh = {
      readVsi: vi.fn().mockResolvedValue(reading({ available: true, supported: true })),
    } as unknown as HuaweiVsiSshService;
    const repo = repository();
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const outcome = await service.poll(host(), 'community');

    expect(outcome.discoveryState).toBe('NOT_FOUND');
    expect(outcome.sshFailure ?? null).toBeNull();
    expect(repo.saveCollection).toHaveBeenCalledTimes(1);
  });

  it('VPWS/L2VC confirmado antes da falha nao vira INCOMPLETE', async () => {
    const ssh = {
      readVsi: vi
        .fn()
        .mockResolvedValueOnce(L2VC_READING())
        .mockResolvedValue(reading({ errorSafe: 'SSH authentication failed' })),
    } as unknown as HuaweiVsiSshService;
    const repo = repository();
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
    try {
      const primeiro = await service.poll(host(), 'community');
      expect(primeiro.discoveryState).toBe('FOUND_L2VC');

      // Forca a cadencia: sem VSI na MIB o CLI roda de novo em 2 minutos.
      vi.setSystemTime(new Date('2026-11-18T12:03:00.000Z'));
      const segundo = await service.poll(host(), 'community');

      expect(segundo.discoveryState).toBe('UNKNOWN');
      expect(segundo.discoveryState).not.toBe('INCOMPLETE');
      expect(segundo.sshFailure).toBe('AUTH');
      // A coleta anterior permanece intacta: nada foi sobrescrito.
      expect(repo.saveCollection).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('comando nao suportado pelo VRP e veredito, nao falha de coleta', async () => {
    const ssh = {
      readVsi: vi
        .fn()
        .mockResolvedValue(reading({ available: false, supported: false, errorSafe: 'unrecognized command' })),
    } as unknown as HuaweiVsiSshService;
    const repo = repository();
    const service = new MplsPollingService(emptyCollector(), repo, ssh);

    const outcome = await service.poll(host(), 'community');

    expect(outcome.sshFailure ?? null).toBeNull();
    expect(repo.saveCollection).toHaveBeenCalledTimes(1);
    expect(outcome.discoveryState).toBe('UNSUPPORTED');
  });
});
