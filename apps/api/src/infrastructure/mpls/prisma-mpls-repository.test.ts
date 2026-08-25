import { describe, expect, it } from 'vitest';
import { correlateMplsAcInterface, vlanIdFromMplsInterfaceName } from './prisma-mpls-repository';

describe('MPLS AC interface correlation', () => {
  it('correlates GERENCIA ifIndex 43 and derives VLAN 99 from the real interface name', () => {
    const interfaces = new Map([
      [43, { id: 'interface-43', ifIndex: 43, name: 'Vlanif99', alias: '99-GERENCIA' }],
    ]);

    expect(correlateMplsAcInterface(43, interfaces)).toEqual({
      interface: {
        id: 'interface-43',
        ifIndex: 43,
        name: 'Vlanif99',
        alias: '99-GERENCIA',
      },
      vlanId: 99,
    });
    expect(correlateMplsAcInterface(44, interfaces)).toBeNull();
  });

  it('does not infer VLAN from a non-Vlanif interface', () => {
    expect(vlanIdFromMplsInterfaceName('Eth-Trunk10.99')).toBeNull();
    expect(vlanIdFromMplsInterfaceName('vlanif4094')).toBe(4094);
    expect(vlanIdFromMplsInterfaceName('Vlanif4095')).toBeNull();
  });
});
