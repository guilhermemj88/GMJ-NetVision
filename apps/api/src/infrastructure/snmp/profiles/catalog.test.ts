import { describe, expect, it } from 'vitest';
import { selectPppOnlineOid, selectSnmpProfile } from './catalog';
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

  it('resolves Huawei and MikroTik PPP OIDs without inventing values', () => {
    expect(selectPppOnlineOid({ vendor: 'Huawei', model: 'NE40E-X8A' })).toBe(HUAWEI_PPP_ONLINE_OID);
    expect(selectPppOnlineOid({ vendor: 'MikroTik', sysDescr: 'RouterOS 7' })).toBe(
      MIKROTIK_PPP_ONLINE_OID,
    );
    expect(selectPppOnlineOid({ vendor: 'Juniper' })).toBeNull();
    expect(selectPppOnlineOid({ vendor: 'Datacom' })).toBeNull();
  });
});
