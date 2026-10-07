import { describe, expect, it } from 'vitest';
import { selectOpticalScalarEncoding, selectPppOnlineOid, selectSnmpProfile } from './catalog';
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

  it('YunShan sem evidencia de S6750 nao herda CENTI_DBM', () => {
    expect(selectOpticalScalarEncoding({
      vendor: 'Huawei',
      sysDescr: 'Huawei YunShan OS V600R024C00SPC500',
    })).toBe('MICRO_WATTS');
    expect(selectOpticalScalarEncoding({
      vendor: 'Huawei',
      sysDescr: 'Huawei CloudEngine S5731-H48T4XC YunShan OS',
    })).toBe('MICRO_WATTS');
    expect(selectOpticalScalarEncoding({
      vendor: 'Huawei',
      sysObjectId: '1.3.6.1.4.1.2011.2.23.1247',
    })).toBe('CENTI_DBM');
  });

  it('encoding do RAW .8/.9 vem do profile (nunca do sinal do valor)', () => {
    expect(selectOpticalScalarEncoding({ vendor: 'Huawei', model: 'S6750-H' })).toBe('CENTI_DBM');
    expect(selectOpticalScalarEncoding({ vendor: 'Huawei', model: 'S6730-H48X6C' })).toBe('MICRO_WATTS');
    expect(selectOpticalScalarEncoding({ vendor: 'Huawei', model: 'NE8000 F1A-C' })).toBe('MICRO_WATTS');
    // Huawei generico preserva o comportamento historico (uW) do parque VRP.
    expect(selectOpticalScalarEncoding({ vendor: 'Huawei', model: 'Desconhecido' })).toBe('MICRO_WATTS');
    // Outros vendors nao herdam decode Huawei: scalar fica em UNKNOWN.
    expect(selectOpticalScalarEncoding({ vendor: 'MikroTik' })).toBe('UNKNOWN');
    expect(selectOpticalScalarEncoding({ vendor: 'Other' })).toBe('UNKNOWN');
  });

  it('resolves Huawei and MikroTik PPP OIDs without inventing values', () => {
    expect(selectPppOnlineOid({ vendor: 'Huawei', model: 'NE40E-X8A' })).toBe(HUAWEI_PPP_ONLINE_OID);
    expect(selectPppOnlineOid({ vendor: 'MikroTik', sysDescr: 'RouterOS 7' })).toBe(
      MIKROTIK_PPP_ONLINE_OID,
    );
    expect(selectPppOnlineOid({ vendor: 'Juniper' })).toBeNull();
    expect(selectPppOnlineOid({ vendor: 'Datacom' })).toBeNull();
  });
});
