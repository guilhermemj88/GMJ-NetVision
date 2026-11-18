import { describe, expect, it } from 'vitest';
import {
  evaluatePlatformInventory,
  platformReason,
  type InventoryDeviceInput,
} from './platform-inventory';

function device(patch: Partial<InventoryDeviceInput> = {}): InventoryDeviceInput {
  return {
    id: 'd1',
    hostname: 'SW-1',
    vendor: 'Huawei',
    model: 'S6730-H48X6C',
    deviceType: 'switch',
    bgpMonitoringEnabled: false,
    bgpPeers: 0,
    autoPolicies: [],
    inMitigationAllowlist: false,
    ...patch,
  };
}

describe('M-D — inventario read-only de cadastro', () => {
  it('Huawei VRP valido mantem AUTO e BGP_ADMIN', () => {
    const report = evaluatePlatformInventory([
      device({ bgpMonitoringEnabled: true, bgpPeers: 12, autoPolicies: ['PL-X'], inMitigationAllowlist: true }),
    ]);
    expect(report.rows[0]!).toMatchObject({
      platform: 'HUAWEI_VRP',
      contexts: ['AUTO', 'BGP_ADMIN'],
      authorizedAfter: ['AUTO', 'BGP_ADMIN'],
      loses: [],
    });
    expect(report.blocking).toBe(false);
  });

  it('Juniper perde BGP_ADMIN', () => {
    const report = evaluatePlatformInventory([
      device({ vendor: 'Juniper', model: 'MX204', bgpPeers: 3, bgpMonitoringEnabled: true }),
    ]);
    expect(report.rows[0]!).toMatchObject({ platform: 'JUNIPER_JUNOS', loses: ['BGP_ADMIN'] });
    expect(report.rows[0]!.reason).toMatch(/Juniper/);
    expect(report.blocking).toBe(true);
  });

  it('OLT Huawei na allowlist perde AUTO', () => {
    const report = evaluatePlatformInventory([
      device({ model: 'MA5800-X7', deviceType: 'olt', inMitigationAllowlist: true }),
    ]);
    expect(report.rows[0]!.platform).toBe('HUAWEI_VRP');
    expect(report.rows[0]!.loses).toEqual(['AUTO']);
    expect(report.rows[0]!.reason).toMatch(/nao-VRP/);
  });

  it('fabricante ausente perde os dois contextos', () => {
    const report = evaluatePlatformInventory([
      device({ vendor: '', model: '', inMitigationAllowlist: true, bgpPeers: 5 }),
    ]);
    expect(report.rows[0]!).toMatchObject({ platform: 'UNSUPPORTED', loses: ['AUTO', 'BGP_ADMIN'] });
    expect(report.rows[0]!.reason).toMatch(/ausentes/);
  });

  it('fabricante/modelo contraditorios perdem autorizacao', () => {
    const report = evaluatePlatformInventory([
      device({ vendor: 'Huawei', model: 'MX204', bgpPeers: 1 }),
    ]);
    expect(report.rows[0]!.platform).toBe('UNSUPPORTED');
    expect(report.rows[0]!.loses).toEqual(['BGP_ADMIN']);
  });

  it('dispositivo sem contexto de autorizacao nao entra no relatorio', () => {
    const report = evaluatePlatformInventory([device({ vendor: '', model: '' })]);
    expect(report.rows).toHaveLength(0);
    expect(report.blocking).toBe(false);
  });

  it('resume por plataforma e sinaliza bloqueio', () => {
    const report = evaluatePlatformInventory([
      device({ id: 'a', hostname: 'A', bgpPeers: 1 }),
      device({ id: 'b', hostname: 'B', vendor: 'Juniper', model: 'MX204', bgpPeers: 1 }),
      device({ id: 'c', hostname: 'C', vendor: '', model: '', bgpPeers: 1 }),
    ]);
    expect(report.summary.devices).toBe(3);
    expect(report.summary.losing).toBe(2);
    expect(report.summary.byPlatform).toMatchObject({ HUAWEI_VRP: 1, JUNIPER_JUNOS: 1, UNSUPPORTED: 1 });
    expect(report.blocking).toBe(true);
    expect(report.rows.map((row) => row.hostname)).toEqual(['A', 'B', 'C']);
  });

  it('motivo distingue OLT de fabricante desconhecido', () => {
    expect(platformReason({ vendor: 'Huawei', model: 'MA5800-X7', deviceType: 'olt' })).toMatch(
      /nao-VRP/,
    );
    expect(platformReason({ vendor: 'Cisco', model: 'ASR9001', deviceType: 'router' })).toMatch(
      /nao suportados/,
    );
    expect(platformReason({ vendor: 'Huawei', model: 'NE8000', deviceType: 'router' })).toBe(
      'Huawei VRP confirmado',
    );
  });

  it('P4-a: piloto AUTO-ALL entra na checklist mesmo sem profile persistido', () => {
    const report = evaluatePlatformInventory([
      device({ hostname: 'BHE-VTA-F1A-BGP-01', inSinglePilot: true }),
      device({ id: 'd2', hostname: 'OUTRO', inSinglePilot: false }),
    ]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ hostname: 'BHE-VTA-F1A-BGP-01', contexts: ['AUTO'] });
  });

  it('P4-a: piloto em plataforma errada aparece como perda de AUTO', () => {
    const report = evaluatePlatformInventory([
      device({ hostname: 'F1A-JUNIPER', vendor: 'Juniper', model: 'MX204', inSinglePilot: true }),
    ]);
    expect(report.rows[0]!.loses).toEqual(['AUTO']);
    expect(report.blocking).toBe(true);
  });
});
