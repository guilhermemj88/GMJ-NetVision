import { describe, expect, it, vi } from 'vitest';
import { makeHost } from '../../test-fixtures';
import type { HuaweiVplsSnmpCollector } from './huawei-vpls-snmp';
import type { MplsRepository } from './mpls-repository';
import { MplsPollingService } from './mpls-polling-service';

describe('MplsPollingService', () => {
  it('isolates an MPLS timeout and persists only a safe failure state', async () => {
    const collector = {
      collect: vi.fn().mockRejectedValue(new Error('SNMP timeout connecting to 10.100.101.8:161')),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;
    const host = makeHost({
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
    });

    const result = await new MplsPollingService(collector, repository).poll(
      host,
      'protected-community',
    );

    expect(result).toMatchObject({
      supported: null,
      error: 'SNMP timeout connecting to 10.100.101.8:161',
    });
    expect(repository.saveFailure).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(repository.saveFailure).mock.calls)).not.toContain(
      'protected-community',
    );
  });

  it('persists partial data and records failed columns as a collection failure', async () => {
    const collectedAt = new Date('2026-08-25T12:00:00.000Z');
    const collector = {
      collect: vi.fn().mockResolvedValue({
        supported: true,
        collectedAt,
        errors: ['PW .8: SNMP timeout'],
        collectedColumns: { vsi: [3, 6, 7, 33], pw: [6, 7, 13, 14] },
        vsis: [],
      }),
    } as unknown as HuaweiVplsSnmpCollector;
    const repository = {
      saveCollection: vi.fn().mockResolvedValue(undefined),
      saveFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as MplsRepository;
    const host = makeHost({
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
    });

    const result = await new MplsPollingService(collector, repository).poll(host, 'community');

    expect(repository.saveCollection).toHaveBeenCalledOnce();
    expect(repository.saveFailure).toHaveBeenCalledWith(
      host.id,
      collectedAt,
      'Falha parcial na coleta MPLS: PW .8: SNMP timeout',
    );
    expect(result).toMatchObject({
      supported: true,
      error: 'Falha parcial na coleta MPLS: PW .8: SNMP timeout',
    });
  });
});
