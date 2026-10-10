import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import { SnmpClientImpl } from './snmp-client-impl';
import { SnmpV2cDiscoveryAdapter } from './snmpv2c-discovery-adapter';

const baseHost = {
  id: 'huawei-1', vendor: 'Huawei', interfaces: [], snmpEnabled: true,
  snmp: { host: '10.0.0.1', port: 161 },
} as unknown as HostRecord;

describe('SNMP IF-MIB interface discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves ifName, ifDescr and ifAlias and decodes Uint8Array text', async () => {
    vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
      const row = (value: string | number | Uint8Array) => [{ oid: `${oid}.501`, value }];
      if (oid === '1.3.6.1.2.1.2.2.1.1') return row(501);
      if (oid === '1.3.6.1.2.1.31.1.1.1.1') return row(new Uint8Array(Buffer.from('100GE0/0/1')));
      if (oid === '1.3.6.1.2.1.2.2.1.2') return row(new Uint8Array(Buffer.from('Huawei 100GE interface')));
      if (oid === '1.3.6.1.2.1.2.2.1.7') return row(1);
      if (oid === '1.3.6.1.2.1.2.2.1.8') return row(1);
      if (oid === '1.3.6.1.2.1.31.1.1.1.15') return row(100_000);
      if (oid === '1.3.6.1.2.1.31.1.1.1.18') return row(new Uint8Array(Buffer.from('BHE-LIKEE-6730-MPLS-01')));
      if (oid === '1.3.6.1.2.1.2.2.1.6') return row(new Uint8Array([0, 17, 34, 51, 68, 85]));
      return [];
    });
    const repository = {
      getDecryptedSnmpCredentials: vi.fn().mockResolvedValue({ community: 'secret' }),
    } as unknown as HostRepository;

    const [networkInterface] = await new SnmpV2cDiscoveryAdapter(repository)
      .discoverInterfaces(baseHost, 'secret');

    expect(networkInterface).toMatchObject({
      ifIndex: 501,
      name: '100GE0/0/1',
      description: 'Huawei 100GE interface',
      alias: 'BHE-LIKEE-6730-MPLS-01',
      speedBps: 100_000_000_000,
      adminStatus: 'UP',
      operStatus: 'UP',
      mac: '00:11:22:33:44:55',
      dataSources: ['SNMP'],
    });
    expect(networkInterface?.name).not.toContain(',');
    expect(networkInterface?.alias).not.toContain(',');
  });

  it('discoverInterfaceMetadata: IF-MIB puro, zero OID optico/capability', async () => {
    // Allowlist EXATA do IF-MIB metadata: qualquer walk fora dela (entity-extent
    // 2011.*, sysObjectId do probe, etc.) faz este teste falhar.
    const allowlist = new Set([
      '1.3.6.1.2.1.2.2.1.1',   // ifIndex
      '1.3.6.1.2.1.31.1.1.1.1', // ifName
      '1.3.6.1.2.1.2.2.1.2',   // ifDescr
      '1.3.6.1.2.1.2.2.1.7',   // ifAdminStatus
      '1.3.6.1.2.1.2.2.1.8',   // ifOperStatus
      '1.3.6.1.2.1.31.1.1.1.15', // ifHighSpeed
      '1.3.6.1.2.1.2.2.1.5',   // ifSpeed
      '1.3.6.1.2.1.31.1.1.1.18', // ifAlias
      '1.3.6.1.2.1.2.2.1.6',   // ifPhysAddress
    ]);
    const walked: string[] = [];
    vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
      const key = String(oid);
      walked.push(key);
      const row = (value: string | number | Uint8Array) => [{ oid: `${key}.248`, value }];
      if (key === '1.3.6.1.2.1.2.2.1.1') return row(248);
      if (key === '1.3.6.1.2.1.31.1.1.1.1') return row('Eth-Trunk1.3066');
      if (key === '1.3.6.1.2.1.2.2.1.2') return row('Trunk');
      if (key === '1.3.6.1.2.1.2.2.1.7') return row(1);
      if (key === '1.3.6.1.2.1.2.2.1.8') return row(1);
      if (key === '1.3.6.1.2.1.31.1.1.1.15') return row(10_000);
      if (key === '1.3.6.1.2.1.31.1.1.1.18') return row('FAST TELECOM_10G');
      if (key === '1.3.6.1.2.1.2.2.1.6') return row(new Uint8Array([0, 1, 2, 3, 4, 5]));
      return [];
    });
    const repository = {
      getDecryptedSnmpCredentials: vi.fn().mockResolvedValue({ community: 'secret' }),
    } as unknown as HostRepository;

    const [networkInterface] = await new SnmpV2cDiscoveryAdapter(repository)
      .discoverInterfaceMetadata(baseHost, 'secret');

    expect(networkInterface).toMatchObject({
      ifIndex: 248,
      name: 'Eth-Trunk1.3066',
      alias: 'FAST TELECOM_10G',
      speedBps: 10_000_000_000,
      adminStatus: 'UP',
      operStatus: 'UP',
      mac: '00:01:02:03:04:05',
      dataSources: ['SNMP'],
    });
    expect(networkInterface?.rxPowerDbm).toBeUndefined();
    expect(networkInterface?.txPowerDbm).toBeUndefined();
    expect(networkInterface?.opticalLanes).toBeUndefined();
    expect(networkInterface?.opticalSource).toBeUndefined();
    expect(walked.length).toBeGreaterThan(0);
    expect(walked.filter((oid) => !allowlist.has(oid))).toEqual([]);
  });

  it('correlates Huawei entity DDM by interface name and converts microWatts to dBm', async () => {
    vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
      if (oid === '1.3.6.1.2.1.47.1.1.1.1.7') {
        return [{ oid: `${oid}.9001`, value: new Uint8Array(Buffer.from('Optical module 100GE 0/0/1')) }];
      }
      if (oid === '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8') {
        return [{ oid: `${oid}.9001`, value: 500 }];
      }
      if (oid === '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.9') {
        return [{ oid: `${oid}.9001`, value: 1000 }];
      }
      if (oid === '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.31') {
        return [{ oid: `${oid}.9001`, value: '61.00,59.36,63.05,52.57' }];
      }
      if (oid === '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.32') {
        return [{ oid: `${oid}.9001`, value: '-3.71,-3.31,-3.09,-2.98' }];
      }
      if (oid === '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.33') {
        return [{ oid: `${oid}.9001`, value: '0.77,1.27,0.62,1.19' }];
      }
      return [];
    });
    const adapter = new SnmpV2cDiscoveryAdapter({} as HostRepository);
    const networkInterface = {
      id: 'if-1', deviceId: baseHost.id, name: '100GE0/0/1', description: '100GE0/0/1', alias: '',
      ifIndex: 1, mac: '', mtu: 1500, speedBps: 100_000_000_000, adminStatus: 'UP' as const,
      operStatus: 'UP' as const, rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0,
      rxErrors: 0, txErrors: 0, rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP' as const],
    };

    const [enriched] = await adapter.enrichOpticalPower(baseHost, [networkInterface], 'secret');
    expect(enriched).toMatchObject({
      rxPowerDbm: -3.01,
      txPowerDbm: 0,
      opticalSource: 'SNMP',
      opticalLaneSource: 'SNMP',
      opticalLanes: [
        { lane: 0, rxPowerDbm: -3.71, txPowerDbm: 0.77, biasCurrentMa: 61 },
        { lane: 1, rxPowerDbm: -3.31, txPowerDbm: 1.27, biasCurrentMa: 59.36 },
        { lane: 2, rxPowerDbm: -3.09, txPowerDbm: 0.62, biasCurrentMa: 63.05 },
        { lane: 3, rxPowerDbm: -2.98, txPowerDbm: 1.19, biasCurrentMa: 52.57 },
      ],
    });
    expect(enriched?.opticalUpdatedAt).toEqual(expect.any(String));
    expect(enriched?.opticalLanesUpdatedAt).toEqual(expect.any(String));
  });

  it('discovers two SNMP lanes even when no scalar DDM value is available', async () => {
    const walk = vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
      if (oid === '1.3.6.1.2.1.2.2.1.1') return [{ oid: `${oid}.77`, value: 77 }];
      if (oid === '1.3.6.1.2.1.31.1.1.1.1') return [{ oid: `${oid}.77`, value: '40GE0/0/7' }];
      if (oid === '1.3.6.1.2.1.2.2.1.2') return [{ oid: `${oid}.77`, value: '40GE0/0/7' }];
      if (oid === '1.3.6.1.2.1.47.1.1.1.1.7') {
        return [{ oid: `${oid}.16850457`, value: 'Optical module 40GE 0/0/7' }];
      }
      if (oid.endsWith('.1.32')) {
        return [{ oid: `${oid}.16850457`, value: '-4.1,-4.2' }];
      }
      return [];
    });

    const [networkInterface] = await new SnmpV2cDiscoveryAdapter({} as HostRepository)
      .discoverInterfaces(baseHost, 'secret');

    expect(networkInterface).toMatchObject({
      ifIndex: 77,
      name: '40GE0/0/7',
      opticalLaneSource: 'SNMP',
      opticalLanes: [
        { lane: 0, rxPowerDbm: -4.1, txPowerDbm: null },
        { lane: 1, rxPowerDbm: -4.2, txPowerDbm: null },
      ],
    });
    expect(networkInterface?.opticalSource).toBeUndefined();
    expect(walk).toHaveBeenCalledWith(
      '10.0.0.1',
      '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.32',
      expect.any(Object),
    );
  });

  it('ignores invalid or sentinel-like Huawei optical values', async () => {
    vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
      if (oid === '1.3.6.1.2.1.47.1.1.1.1.7') {
        return [{ oid: `${oid}.9001`, value: '100GE0/0/1' }];
      }
      if (oid.includes('2011.5.25.31.1.1.3.1')) {
        return [{ oid: `${oid}.9001`, value: 2147483647 }];
      }
      return [];
    });
    const adapter = new SnmpV2cDiscoveryAdapter({} as HostRepository);
    const networkInterface = {
      id: 'if-1', deviceId: baseHost.id, name: '100GE0/0/1', description: '', alias: '', ifIndex: 1,
      mac: '', mtu: 1500, speedBps: 1, adminStatus: 'UP' as const, operStatus: 'UP' as const,
      rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0, rxErrors: 0, txErrors: 0,
      rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP' as const],
    };
    expect(await adapter.enrichOpticalPower(baseHost, [networkInterface], 'secret')).toEqual([networkInterface]);
  });

  describe('fixtures reais de campo (F7.5)', () => {
    afterEach(() => vi.restoreAllMocks());

    const OIDS = {
      raw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8',
      rawTx: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.9',
      rxLow: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.13',
      rxHigh: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.14',
      txLow: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.15',
      txHigh: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.16',
      rxWarnLow: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.20',
      rxWarnHigh: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.21',
      txWarnLow: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.22',
      txWarnHigh: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.23',
      bias: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.31',
      rxLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.32',
      txLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.33',
    } as const;

    function ifaceNamed(name: string) {
      return {
        id: 'if-1', deviceId: baseHost.id, name, description: name, alias: '', ifIndex: 1,
        mac: '', mtu: 1500, speedBps: 100_000_000_000, adminStatus: 'UP' as const,
        operStatus: 'UP' as const, rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0,
        rxErrors: 0, txErrors: 0, rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP' as const],
      };
    }

    function walkOptical(
      entityName: string,
      index: number,
      values: Partial<Record<keyof typeof OIDS, string | number>>,
    ) {
      return vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
        if (oid === '1.3.6.1.2.1.47.1.1.1.1.7') {
          return [{ oid: `${oid}.${index}`, value: entityName }];
        }
        for (const [key, base] of Object.entries(OIDS)) {
          if (oid === base) {
            const value = values[key as keyof typeof OIDS];
            return value === undefined ? [] : [{ oid: `${oid}.${index}`, value }];
          }
        }
        return [];
      });
    }

    it('S6730 real: current em micro-watts e thresholds .13-.16 em centi-dBm (DEVICE)', async () => {
      walkOptical('XGigabitEthernet0/0/1', 67_469_390, {
        raw: 65,
        rawTx: 271,
        rxLow: -2201,
        rxHigh: -200,
        txLow: -1000,
        txHigh: -200,
      });
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, model: 'S6730-H48X6C' } as unknown as HostRecord,
        [ifaceNamed('XGigabitEthernet0/0/1')],
        'secret',
      );

      expect(enriched).toMatchObject({
        rxPowerDbm: -11.87,
        txPowerDbm: -5.67,
        opticalSource: 'SNMP',
        opticalThresholdSource: 'DEVICE',
        opticalThresholds: {
          version: 1,
          scalar: {
            rx: { lowAlarmDbm: -22.01, highAlarmDbm: -2, lowSource: 'DEVICE', highSource: 'DEVICE' },
            tx: { lowAlarmDbm: -10, highAlarmDbm: -2, lowSource: 'DEVICE', highSource: 'DEVICE' },
          },
          lanes: [],
        },
      });
    });

    it('S6750-H real: current centi-dBm, thresholds do modulo e lanes .32/.33 preservadas', async () => {
      walkOptical('100GE1/0/1', 16_850_434, {
        raw: 18,
        rawTx: -74,
        rxLow: -1231,
        rxHigh: 340,
        txLow: -1040,
        txHigh: 340,
        bias: '61,59,63,52',
        rxLane: '0.19,0.69,1.02,0.11',
        txLane: '-0.74,-0.69,-0.72,-0.76',
      });
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        {
          ...baseHost,
          model: 'S6750-H',
        } as unknown as HostRecord,
        [ifaceNamed('100GE1/0/1')],
        'secret',
        { sysDescr: 'Huawei YunShan OS CloudEngine S6750-H V600R024C00SPC500' },
      );

      // Regressao comprovada: 18 como uW daria -17.44 dBm; no YunShan e +0.18.
      expect(enriched?.rxPowerDbm).toBe(0.18);
      expect(enriched?.txPowerDbm).toBe(-0.74);
      expect(enriched?.opticalLanes).toEqual([
        { lane: 0, rxPowerDbm: 0.19, txPowerDbm: -0.74, biasCurrentMa: 61 },
        { lane: 1, rxPowerDbm: 0.69, txPowerDbm: -0.69, biasCurrentMa: 59 },
        { lane: 2, rxPowerDbm: 1.02, txPowerDbm: -0.72, biasCurrentMa: 63 },
        { lane: 3, rxPowerDbm: 0.11, txPowerDbm: -0.76, biasCurrentMa: 52 },
      ]);
      expect(enriched?.opticalThresholds?.scalar).toEqual({
        rx: { lowAlarmDbm: -12.31, highAlarmDbm: 3.4, lowSource: 'DEVICE', highSource: 'DEVICE' },
        tx: { lowAlarmDbm: -10.4, highAlarmDbm: 3.4, lowSource: 'DEVICE', highSource: 'DEVICE' },
      });
    });

    it('S6730 real 100G: lanes .32/.33 em centi-dBm (index 67502222 / 100GE0/0/2)', async () => {
      walkOptical('100GE0/0/2', 67_502_222, {
        raw: 42,
        rawTx: 1191,
        rxLow: -2148,
        rxHigh: -250,
        txLow: -250,
        txHigh: 650,
        bias: '47.89,67.46,47.90,51.08',
        rxLane: '-1372.63,-1226.95,-1311.58,-1294.14',
        txLane: '76.06,76.68,66.62,43.72',
      });
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, model: 'S6730-H48X6C' } as unknown as HostRecord,
        [ifaceNamed('100GE0/0/2')],
        'secret',
      );

      // Scalar continua MICRO_WATTS (42 uW / 1191 uW).
      expect(enriched?.rxPowerDbm).toBeCloseTo(-13.77, 2);
      expect(enriched?.txPowerDbm).toBeCloseTo(0.76, 2);
      // Lanes: o CSV do S6730 e centi-dBm e a resolucao do vendor e preservada
      // (2 casas em centi-dBm = 4 em dBm) — sem /100 o RX seria descartado.
      expect(enriched?.opticalLanes).toEqual([
        { lane: 0, rxPowerDbm: -13.7263, txPowerDbm: 0.7606, biasCurrentMa: 47.89 },
        { lane: 1, rxPowerDbm: -12.2695, txPowerDbm: 0.7668, biasCurrentMa: 67.46 },
        { lane: 2, rxPowerDbm: -13.1158, txPowerDbm: 0.6662, biasCurrentMa: 47.9 },
        { lane: 3, rxPowerDbm: -12.9414, txPowerDbm: 0.4372, biasCurrentMa: 51.08 },
      ]);
      expect(enriched?.opticalLaneSource).toBe('SNMP');
      // .13-.16 preservados: -21.48 / -2.50 / -2.50 / +6.50.
      expect(enriched?.opticalThresholds?.scalar).toEqual({
        rx: { lowAlarmDbm: -21.48, highAlarmDbm: -2.5, lowSource: 'DEVICE', highSource: 'DEVICE' },
        tx: { lowAlarmDbm: -2.5, highAlarmDbm: 6.5, lowSource: 'DEVICE', highSource: 'DEVICE' },
      });
    });
    it('vendor sem capability Huawei: nenhum walk optico e nenhum dado inventado', async () => {
      const walk = walkOptical('100GE0/0/1', 9001, {
        raw: 18,
        rawTx: -74,
        rxLow: -1231,
        rxLane: '0.19,0.69',
      });
      const original = ifaceNamed('100GE0/0/1');
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, vendor: 'VendorDesconhecido', model: '' } as unknown as HostRecord,
        [original],
        'secret',
      );

      // Sem profile Huawei nao existe capability optica declarada: nem a tabela
      // .8 e tocada (antes o coletor varria os OIDs Huawei em qualquer vendor).
      expect(enriched).toEqual(original);
      expect(walk).not.toHaveBeenCalled();
    });

    it('F1A real: scalar agregado em centi-dBm, lanes inteiras e warning do modulo', async () => {
      walkOptical('100GE0/1/48', 16_847_153, {
        raw: 601,
        rawTx: 586,
        rxLow: -1230,
        rxHigh: 339,
        txLow: -1040,
        txHigh: 339,
        rxWarnLow: -1030,
        rxWarnHigh: 239,
        txWarnLow: -760,
        txWarnHigh: 239,
        rxLane: '29,-33,-14,14',
        txLane: '-58,-22,-12,27',
      });
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, model: 'NE8000 F1A-C' } as unknown as HostRecord,
        [ifaceNamed('100GE0/1/48')],
        'secret',
        { sysDescr: 'Huawei VRP 8.220 NetEngine 8000 V800R022C00SPC600' },
      );

      // .8 = 601 => +6.01 dBm (antes: -2.21 dBm por ler como micro-watts).
      expect(enriched?.rxPowerDbm).toBe(6.01);
      expect(enriched?.txPowerDbm).toBe(5.86);
      expect(enriched?.opticalLanes).toEqual([
        { lane: 0, rxPowerDbm: 0.29, txPowerDbm: -0.58 },
        { lane: 1, rxPowerDbm: -0.33, txPowerDbm: -0.22 },
        { lane: 2, rxPowerDbm: -0.14, txPowerDbm: -0.12 },
        { lane: 3, rxPowerDbm: 0.14, txPowerDbm: 0.27 },
      ]);
      // .31 nao existe no F1A: nenhum bias e inventado.
      expect(enriched?.opticalLanes?.every((lane) => !('biasCurrentMa' in lane))).toBe(true);
      expect(enriched?.opticalThresholds?.scalar).toEqual({
        rx: {
          lowAlarmDbm: -12.3,
          highAlarmDbm: 3.39,
          lowWarningDbm: -10.3,
          highWarningDbm: 2.39,
          lowSource: 'DEVICE',
          highSource: 'DEVICE',
        },
        tx: {
          lowAlarmDbm: -10.4,
          highAlarmDbm: 3.39,
          lowWarningDbm: -7.6,
          highWarningDbm: 2.39,
          lowSource: 'DEVICE',
          highSource: 'DEVICE',
        },
      });
    });

    it('S6750 nao tem WARNING: o walk .20-.23 nao e tentado', async () => {
      const walk = walkOptical('100GE1/0/1', 16_850_434, {
        raw: 1,
        rawTx: -74,
        rxLow: -1231,
        rxHigh: 340,
        txLow: -1040,
        txHigh: 340,
        rxLane: '0.01,0.72,1.05,0.15',
      });
      await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, model: 'S6750-H' } as unknown as HostRecord,
        [ifaceNamed('100GE1/0/1')],
        'secret',
      );
      // A sonda confirma UMA vez que a coluna nao existe (diagnostico); nenhum
      // walk de COLETA (.20-.23 = 4 walks) e tentado.
      const warningWalks = walk.mock.calls.filter(([, oid]) =>
        /^1\.3\.6\.1\.4\.1\.2011\.5\.25\.31\.1\.1\.3\.1\.2[0-3]$/.test(oid));
      expect(warningWalks).toHaveLength(1);
    });

    it('MA5800 (optica UNSUPPORTED): nenhum walk optico e tentado contra a OLT', async () => {
      const walk = vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async () => []);
      const original = ifaceNamed('GigabitEthernet0/1/1');
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, model: 'MA5800-X15' } as unknown as HostRecord,
        [original],
        'secret',
        { sysDescr: 'Huawei Integrated Access Software', sysObjectId: '1.3.6.1.4.1.2011.2.316' },
      );

      expect(enriched).toEqual(original);
      expect(walk).not.toHaveBeenCalled();
    });

    it('aceita threshold parcial, descarta par incoerente e ignora o sentinela -1', async () => {
      walkOptical('100GE0/0/2', 9002, {
        rxLow: -1231,
        rxHigh: -1,
        txLow: 340,
        txHigh: -1040,
      });
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, model: 'S6750-H' } as unknown as HostRecord,
        [ifaceNamed('100GE0/0/2')],
        'secret',
      );

      expect(enriched?.opticalThresholds?.scalar).toEqual({
        // -1 e sentinela: nao vira -0.01 dBm. O par TX incoerente cai inteiro.
        rx: { lowAlarmDbm: -12.31, highAlarmDbm: null, lowSource: 'DEVICE', highSource: null },
        tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
      });
    });

    it('falha total de SNMP no bloco optico nao inventa leitura nem quebra o fluxo', async () => {
      vi.spyOn(SnmpClientImpl.prototype, 'walk').mockRejectedValue(new Error('timeout'));
      const original = ifaceNamed('100GE1/0/1');
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, model: 'S6750-H' } as unknown as HostRecord,
        [original],
        'secret',
      );
      expect(enriched).toEqual(original);
    });
  });
});
