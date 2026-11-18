/**
 * FIXTURES SINTETICAS.
 *
 * Reproduzem o FORMATO das saidas VRP, nao capturas reais de NE8000/NE40E.
 * O unico dado real do repositorio sao as capturas de S6750/S6730 em
 * ../../__fixtures__/bhe-vta-*. Ao homologar NE8000/NE40E (ver
 * docs/VSI_MCP_DIAGNOSTICS.md), substituir estas fixtures por capturas reais
 * sanitizadas e promover a celula correspondente da matriz de capacidades.
 */

export const NE_VERSION = `<NE8-LAB>display version
Huawei Versatile Routing Platform Software
VRP (R) software, Version 8.221 (NE8000 V800R022C10SPC500)
Copyright (C) 2012-2024 Huawei Technologies Co., Ltd.
HUAWEI NE8000 F1A uptime is 120 days, 3 hours, 11 minutes
<NE8-LAB>`;

const vsiHeader = (name: string, encap: string, mtu = 1500) => `
 ***VSI Name               : ${name}
    Work Mode              : normal
    VSI Index              : 7
    PW Signaling           : ldp
    Encapsulation Type     : ${encap}
    MTU                    : ${mtu}
    VSI State              : up
`;

const ac = (name: string, state = 'up') => `
    Interface Name         : ${name}
    State                  : ${state}
    Ac Block State         : unblocked
    Access Port            : false
`;

const pw = (peer: string, local: number, remote: number, state = 'up') => `
  **PW Information:

   *Peer Ip Address        : ${peer}
    PW State               : ${state}
    Local VC Label         : ${local}
    Remote VC Label        : ${remote}
    PW Type                : label
    Tunnel ID              : 0x0000000001004c4b81
    Tnl Type               : ldp
    OutInterface           : --
`;

/** Cenario A: interface fisica E subinterface na mesma VSI. */
export const SCEN_A_VSI = `<PE-A>display vsi name L2-PPPOE-3901 verbose
${vsiHeader('L2-PPPOE-3901', 'vlan')}${ac('GigabitEthernet1/0/1')}${ac('GigabitEthernet1/0/1.3901')}${pw('10.0.0.2', 1000, 2000)}<PE-A>`;

export const SCEN_A_PARENT_CFG = `<PE-A>display current-configuration interface GigabitEthernet1/0/1
#
interface GigabitEthernet1/0/1
 undo shutdown
 mode l2
 l2 binding vsi L2-PPPOE-3901
#
<PE-A>`;

export const SCEN_A_SUB_CFG = `<PE-A>display current-configuration interface GigabitEthernet1/0/1.3901
#
interface GigabitEthernet1/0/1.3901 mode l2
 encapsulation qinq vid 3901 ce-vid 100 to 200
 rewrite pop double
 l2 binding vsi L2-PPPOE-3901
#
<PE-A>`;

/** Controle: so a subinterface esta ligada. */
export const SCEN_A_CONTROL_VSI = `<PE-A>display vsi name L2-PPPOE-3901 verbose
${vsiHeader('L2-PPPOE-3901', 'vlan')}${ac('GigabitEthernet1/0/1.3901')}${pw('10.0.0.2', 1000, 2000)}<PE-A>`;

/** Cenario B: ponta A converte 50 -> 502 (stacking); ponta B termina Dot1Q 502. */
export const SCEN_B_VSI_A = `<NE8-A>display vsi name SVC-50-502 verbose
${vsiHeader('SVC-50-502', 'vlan')}${ac('GigabitEthernet2/0/1.50')}${pw('10.0.0.9', 3000, 4000)}<NE8-A>`;
export const SCEN_B_VSI_B = `<NE40-B>display vsi name SVC-50-502 verbose
${vsiHeader('SVC-50-502', 'vlan')}${ac('GigabitEthernet3/0/2.502')}${pw('10.0.0.1', 4000, 3000)}<NE40-B>`;
export const SCEN_B_CFG_A = `<NE8-A>display current-configuration interface GigabitEthernet2/0/1.50
#
interface GigabitEthernet2/0/1.50 mode l2
 qinq stacking vlan 50 stack-vlan 502
 l2 binding vsi SVC-50-502
#
<NE8-A>`;
export const SCEN_B_CFG_B = `<NE40-B>display current-configuration interface GigabitEthernet3/0/2.502
#
interface GigabitEthernet3/0/2.502 mode l2
 encapsulation dot1q vid 502
 l2 binding vsi SVC-50-502
#
<NE40-B>`;

export const MAC_WITH_AC_AND_PW = `<PE>display mac-address vsi X
MAC Address    VLAN/VSI/BD                       Learned-From        Type
-------------------------------------------------------------------------------
0011-2233-4455 -/-/X                             GE1/0/1.3901        dynamic
0011-2233-4466 -/-/X                             10.0.0.2            dynamic
-------------------------------------------------------------------------------
Total items displayed = 2
<PE>`;

/** Lado A do cenario B: o MAC do AC e aprendido na subinterface que E o AC daquela VSI (nome abreviado, como o equipamento mostra). */
export const MAC_SCEN_B_A = MAC_WITH_AC_AND_PW.replace('GE1/0/1.3901        ', 'GE2/0/1.50          ');

export const MAC_ONLY_PW = `<PE>display mac-address vsi X
MAC Address    VLAN/VSI/BD                       Learned-From        Type
-------------------------------------------------------------------------------
0011-2233-4466 -/-/X                             10.0.0.2            dynamic
-------------------------------------------------------------------------------
Total items displayed = 1
<PE>`;

export const MAC_EMPTY = `<PE>display mac-address vsi X
Total items displayed = 0
<PE>`;
