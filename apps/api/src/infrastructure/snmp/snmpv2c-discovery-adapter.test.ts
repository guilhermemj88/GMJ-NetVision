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
      // Lanes: o CSV do S6730 e centi-dBm — sem /100 o RX seria descartado.
      expect(enriched?.opticalLanes).toEqual([
        { lane: 0, rxPowerDbm: -13.73, txPowerDbm: 0.76, biasCurrentMa: 47.89 },
        { lane: 1, rxPowerDbm: -12.27, txPowerDbm: 0.77, biasCurrentMa: 67.46 },
        { lane: 2, rxPowerDbm: -13.12, txPowerDbm: 0.67, biasCurrentMa: 47.9 },
        { lane: 3, rxPowerDbm: -12.94, txPowerDbm: 0.44, biasCurrentMa: 51.08 },
      ]);
      expect(enriched?.opticalLaneSource).toBe('SNMP');
      // .13-.16 preservados: -21.48 / -2.50 / -2.50 / +6.50.
      expect(enriched?.opticalThresholds?.scalar).toEqual({
        rx: { lowAlarmDbm: -21.48, highAlarmDbm: -2.5, lowSource: 'DEVICE', highSource: 'DEVICE' },
        tx: { lowAlarmDbm: -2.5, highAlarmDbm: 6.5, lowSource: 'DEVICE', highSource: 'DEVICE' },
      });
    });
    it('familia nao classificada: UNKNOWN nao decodifica scalar, mas mantem lanes e thresholds', async () => {
      walkOptical('100GE0/0/1', 9001, {
        raw: 18,
        rawTx: -74,
        rxLow: -1231,
        rxLane: '0.19,0.69',
      });
      const [enriched] = await new SnmpV2cDiscoveryAdapter({} as HostRepository).enrichOpticalPower(
        { ...baseHost, vendor: 'VendorDesconhecido', model: '' } as unknown as HostRecord,
        [ifaceNamed('100GE0/0/1')],
        'secret',
      );

      expect(enriched?.rxPowerDbm).toBeUndefined();
      expect(enriched?.txPowerDbm).toBeUndefined();
      expect(enriched?.opticalSource).toBeUndefined();
      expect(enriched?.opticalLanes).toHaveLength(2);
      expect(enriched?.opticalThresholds?.scalar.rx.lowAlarmDbm).toBe(-12.31);
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
