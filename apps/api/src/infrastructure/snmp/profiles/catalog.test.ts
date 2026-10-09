import { describe, expect, it } from 'vitest';
import {
  selectOpticalCapability,
  selectOpticalScalarSemantics,
  selectPppOnlineOid,
  selectSnmpProfile,
} from './catalog';
import { HUAWEI_PPP_ONLINE_OID, MIKROTIK_PPP_ONLINE_OID } from './ppp-oids';

describe('SNMP profile catalog', () => {
  it('selects generic when no vendor identity matches', () => {
    expect(selectSnmpProfile({ vendor: 'Other' }).id).toBe('generic');
  });

  it('selects Huawei generic from sysObjectID', () => {
    expect(selectSnmpProfile({ sysObjectId: '1.3.6.1.4.1.2011.2.23.1' }).id).toBe('huawei-generic');
    expect(selectSnmpProfile({ vendor: 'Huawei', model: 'Unknown' }).id).toBe('huawei-generic');
  });

  it('prioritizes S6730 and NE8000 model profiles', () => {
    expect(selectSnmpProfile({ vendor: 'Huawei', model: 'S6730-H48X6C' }).id).toBe('huawei-s6730');
    expect(selectSnmpProfile({ vendor: 'Huawei', model: 'NetEngine NE8000 F1A' }).id).toBe('huawei-ne8000');
    // sysObjectID real do F1A-8H20Q validado em campo (2026-10-09).
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysObjectId: '1.3.6.1.4.1.2011.2.360.1.5',
    }).id).toBe('huawei-ne8000');
  });

  it('identifica o S6750-H por modelo, sysDescr ou sysObjectID real', () => {
    expect(selectSnmpProfile({ vendor: 'Huawei', model: 'S6750-H' }).id).toBe('huawei-s6750');
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysDescr: 'Huawei YunShan OS CloudEngine S6750-H V600R024C00SPC500',
    }).id).toBe('huawei-s6750');
    // sysObjectID real do equipamento validado (1.3.6.1.4.1.2011.2.23.1247).
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysObjectId: '1.3.6.1.4.1.2011.2.23.1247',
    }).id).toBe('huawei-s6750');
  });

  it('identifica o MA5800-X15 (access) e declara optica UNSUPPORTED', () => {
    expect(selectSnmpProfile({ vendor: 'Huawei', model: 'MA5800-X15' }).id).toBe('huawei-ma5800');
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysDescr: 'Huawei Integrated Access Software',
    }).id).toBe('huawei-ma5800');
    // sysObjectID real da OLT validada (1.3.6.1.4.1.2011.2.316).
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysObjectId: '1.3.6.1.4.1.2011.2.316',
    }).id).toBe('huawei-ma5800');
    const capability = selectOpticalCapability({ vendor: 'Huawei', model: 'MA5800-X15' });
    expect(capability.capabilities.table).toBe(false);
    expect(capability.scalarEncoding).toBe('UNSUPPORTED');
    expect(capability.warningThresholdEncoding).toBe('UNSUPPORTED');
  });

  it('matcher do S6750 e estrito: YunShan/CloudEngine sem S6750 nao viram S6750', () => {
    // YunShan sem evidencia de S6750 (S67xx/S57xx nao validados) fica no generico.
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysDescr: 'Huawei YunShan OS V600R024C00SPC500',
    }).id).toBe('huawei-generic');
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysDescr: 'Huawei CloudEngine S5731-H48T4XC YunShan OS',
    }).id).toBe('huawei-generic');
    // Outro CloudEngine S6 continua sendo o profile do proprio modelo.
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysDescr: 'Huawei CloudEngine S6730-H48X6C',
    }).id).toBe('huawei-s6730');
    expect(selectSnmpProfile({ vendor: 'Huawei', model: 'S6730-H48X6C' }).id).toBe('huawei-s6730');
    expect(selectSnmpProfile({ vendor: 'Huawei', model: 'NE8000 F1A-C' }).id).toBe('huawei-ne8000');
    // sysObjectID de outro modelo nao casa o OID real do S6750.
    expect(selectSnmpProfile({
      vendor: 'Huawei',
      sysObjectId: '1.3.6.1.4.1.2011.2.23.1246',
    }).id).toBe('huawei-generic');
  });

  it('capability F1A: CENTI_DBM agregado com lanes inteiras centi-dBm', () => {
    const capability = selectOpticalCapability({ vendor: 'Huawei', model: 'NE8000 F1A-C' });
    expect(capability.scalarEncoding).toBe('CENTI_DBM');
    expect(capability.scalarSemantics).toBe('AGGREGATED_LANES');
    expect(capability.laneEncoding).toBe('INT_CENTI_DBM');
    expect(capability.laneBiasEncoding).toBe('UNSUPPORTED');
    expect(capability.capabilities).toEqual({
      table: true,
      scalarPower: true,
      alarmThresholds: true,
      laneBias: false,
      lanes: true,
      warnings: true,
      minMax: true,
    });
    expect(selectOpticalScalarSemantics({ vendor: 'Huawei', model: 'NE8000 F1A-C' }))
      .toBe('AGGREGATED_LANES');
  });

  it('capability S6730: micro-watts lane 0, lanes decimais centi-dBm e bias mA', () => {
    const capability = selectOpticalCapability({ vendor: 'Huawei', model: 'S6730-H48X6C' });
    expect(capability.scalarEncoding).toBe('MICRO_WATTS');
    expect(capability.scalarSemantics).toBe('LANE_0');
    expect(capability.laneEncoding).toBe('DECIMAL_CENTI_DBM');
    expect(capability.laneBiasEncoding).toBe('DECIMAL_MA');
    expect(capability.warningThresholdEncoding).toBe('CENTI_DBM');
    expect(capability.minMaxEncoding).toBe('UNSUPPORTED');
  });

  it('capability S6750: centi-dBm lane 0, lanes dBm, sem WARNING e sem min/max', () => {
    const capability = selectOpticalCapability({ vendor: 'Huawei', model: 'S6750-H' });
    expect(capability.scalarEncoding).toBe('CENTI_DBM');
    expect(capability.scalarSemantics).toBe('LANE_0');
    expect(capability.laneEncoding).toBe('DECIMAL_DBM');
    expect(capability.capabilities.warnings).toBe(false);
    expect(capability.capabilities.minMax).toBe(false);
  });

  it('Huawei generico preserva o historico e NUNCA assume agregado', () => {
    const capability = selectOpticalCapability({ vendor: 'Huawei', model: 'Desconhecido' });
    expect(capability.scalarEncoding).toBe('MICRO_WATTS');
    expect(capability.scalarSemantics).toBe('UNKNOWN');
    expect(capability.laneEncoding).toBe('DECIMAL_DBM');
    expect(capability.capabilities.table).toBe(true);
  });

  it('outros vendors: capability optica UNSUPPORTED (nenhum walk e tentado)', () => {
    for (const identity of [{ vendor: 'MikroTik' }, { vendor: 'Other' }]) {
      const capability = selectOpticalCapability(identity);
      expect(capability.capabilities.table).toBe(false);
      expect(capability.scalarEncoding).toBe('UNSUPPORTED');
      expect(selectOpticalScalarSemantics(identity)).toBe('UNKNOWN');
    }
  });

  it('declara o dialeto CLI read-only por familia (nada e executado no polling)', () => {
    expect(selectSnmpProfile({ sysObjectId: '1.3.6.1.4.1.2011.2.360.1.5' }).cli).toEqual({
      opticalDiagnosis: 'display interface {interface}',
      version: 'display version',
    });
    expect(selectSnmpProfile({ model: 'S6730-H48X6C' }).cli).toEqual({
      opticalDiagnosis: 'display transceiver diagnosis interface {interface}',
      opticalVerbose: 'display transceiver verbose interface {interface}',
      version: 'display version',
    });
    expect(selectSnmpProfile({ sysObjectId: '1.3.6.1.4.1.2011.2.23.1247' }).cli).toEqual({
      opticalDiagnosis: 'display interface {interface} transceiver verbose',
      version: 'display version',
    });
    // MA5800: optico PON e dominio XPON (fase futura) - so versao/board.
    expect(selectSnmpProfile({ model: 'MA5800-X15' }).cli).toEqual({ version: 'display version' });
    expect(selectSnmpProfile({ vendor: 'Huawei', model: 'Desconhecido' }).cli?.opticalVerbose)
      .toBe('display transceiver verbose interface {interface}');
    expect(selectSnmpProfile({ vendor: 'Other' }).cli).toBeUndefined();
  });

  it('resolves Huawei and MikroTik PPP OIDs without inventing values', () => {
    expect(selectPppOnlineOid({ vendor: 'Huawei', model: 'NE40E-X8A' })).toBe(HUAWEI_PPP_ONLINE_OID);
    expect(selectPppOnlineOid({ vendor: 'MikroTik', sysDescr: 'RouterOS 7' })).toBe(
      MIKROTIK_PPP_ONLINE_OID,
    );
    expect(selectPppOnlineOid({ vendor: 'Juniper' })).toBeNull();
    expect(selectPppOnlineOid({ vendor: 'Datacom' })).toBeNull();
    // OLT MA5800 nao declara PPP online (dominio de acesso, nao BRAS).
    expect(selectPppOnlineOid({ vendor: 'Huawei', model: 'MA5800-X15' })).toBeNull();
  });
});