import { describe, expect, it } from 'vitest';
import {
  parseHuaweiL2vc,
  parseHuaweiL2vcSummary,
  parseHuaweiLdpRemotePeers,
  parseHuaweiLdpSessions,
  parseHuaweiVsiNames,
  parseHuaweiVsiVerbose,
} from './huawei-vsi-ssh-parser';

// Saidas no formato do VRP (S-series). Fixtures sinteticas: os valores sao os
// que o equipamento imprime, sem inventar campos ausentes.
const VSI_VERBOSE = `Total VSI number              : 2

**VSI Name               : VSI-GERENCIA
  VSI Index              : 0
  VSI State              : up
  VSI ID                 : 100
  VSI Description        : Gestao
  VSI Signaling Type     : ldp
  VSI Tunnel Policy      : -
  *Peer Router ID        : 10.20.30.40
   Negotiated MTU        : 1500
   Local VC Label        : 1024
   Remote VC Label       : 1025
   VC Type               : ethernet
   VC State              : up
   Link ID               : 1
   Local AC Interface    : GE0/0/1

**VSI Name               : VSI-CLIENTE
  VSI State              : down
  VSI ID                 : 200
  VSI Signaling Type     : ldp
  *Peer Router ID        : 10.20.30.50
   VC State              : down
   Link ID               : 2
   Local AC Interface    : GE0/0/2
`;

describe('parseHuaweiVsiVerbose', () => {
  it('extrai uma VSI LDP estatica UP com peer, labels e AC', () => {
    const [vsi] = parseHuaweiVsiVerbose(VSI_VERBOSE);

    expect(vsi).toMatchObject({
      name: 'VSI-GERENCIA',
      vsiId: 100,
      operationalStatus: 'UP',
      signalingType: 'LDP',
      description: 'Gestao',
      mtu: 1500,
      vcType: 'ETHERNET',
      tunnelPolicy: null,
      acInterfaceNames: ['GE0/0/1'],
    });
    expect(vsi?.peers).toEqual([
      {
        remoteRouterId: '10.20.30.40',
        linkId: 1,
        localLabel: 1024,
        remoteLabel: 1025,
        state: 'UP',
        mtu: 1500,
        vcType: 'ETHERNET',
        tunnelPolicy: null,
        acInterfaceName: 'GE0/0/1',
      },
    ]);
  });

  it('mantem VSI LDP DOWN como DOWN, sem inventar estado', () => {
    const [, down] = parseHuaweiVsiVerbose(VSI_VERBOSE);

    expect(down).toMatchObject({
      name: 'VSI-CLIENTE',
      vsiId: 200,
      operationalStatus: 'DOWN',
      signalingType: 'LDP',
    });
    expect(down?.peers[0]).toMatchObject({ remoteRouterId: '10.20.30.50', state: 'DOWN' });
  });

  it('preserva VSI sinalizada por BGP e o RD', () => {
    const [vsi] = parseHuaweiVsiVerbose(`
**VSI Name               : VSI-BGP
  VSI State              : up
  VSI ID                 : 300
  VSI RD                 : 65000:300
  VSI Signaling Type     : bgp
`);

    expect(vsi).toMatchObject({ name: 'VSI-BGP', signalingType: 'BGP', rd: '65000:300' });
  });

  it('registra a descoberta de membros somente quando o VRP a declara', () => {
    const [staticVsi] = parseHuaweiVsiVerbose(`**VSI Name               : VSI-ESTATICA
  VSI State              : up
  Peer Discovery         : disable
`);
    const [dynamicVsi] = parseHuaweiVsiVerbose(`**VSI Name               : VSI-DINAMICA
  VSI State              : up
  VSI Peer Discovery     : enable
`);

    expect(staticVsi?.peerDiscovery).toBe('STATIC');
    expect(dynamicVsi?.peerDiscovery).toBe('DYNAMIC');
    expect(parseHuaweiVsiVerbose('**VSI Name : V\n')[0]?.peerDiscovery).toBeNull();
  });

  it('devolve todas as VSIs do mesmo equipamento', () => {
    const vsis = parseHuaweiVsiVerbose(VSI_VERBOSE);
    expect(vsis.map((vsi) => vsi.name)).toEqual(['VSI-GERENCIA', 'VSI-CLIENTE']);
  });

  it('nao inventa campos quando a saida vem incompleta', () => {
    const [vsi] = parseHuaweiVsiVerbose('**VSI Name               : VS-1\n');

    expect(vsi).toMatchObject({
      name: 'VS-1',
      vsiId: null,
      operationalStatus: 'UNKNOWN',
      adminStatus: 'UNKNOWN',
      signalingType: 'UNKNOWN',
      mtu: null,
      vcType: 'UNKNOWN',
      peers: [],
      acInterfaceNames: [],
    });
  });

  it('ignora lixo e saida vazia sem lancar', () => {
    expect(parseHuaweiVsiVerbose('')).toEqual([]);
    expect(parseHuaweiVsiVerbose('Error: Unrecognized command found at "^" position.')).toEqual(
      [],
    );
  });
});

describe('parseHuaweiVsiNames', () => {
  it('lista os nomes do resumo sem verbose', () => {
    const names = parseHuaweiVsiNames(`Total VSI number: 2
VSI Name                        VSI Index       VSI State
VSI-GERENCIA                    0               up
VSI-CLIENTE                     1               down`);
    expect(names).toEqual(['VSI-GERENCIA', 'VSI-CLIENTE']);
  });
});

describe('parseHuaweiLdpSessions', () => {
  it('le o formato tabular e separa sessao UP de DOWN', () => {
    const peers = parseHuaweiLdpSessions(`LDP Session(s) in Public Network
Codes: LAM(Label Advertisement Mode), SsnAge Unit: DDHHMM

PeerID             Status      LAM  SsnRole  SsnAge      KASent/Rcv
------------------ ----------- ---- -------- ----------- ---------
10.20.30.40:0       Operational DU   Passive  0000:00:01  10/10
10.20.30.50:0       OpenSent    DU   Active   0000:00:00  3/0`);

    expect(peers).toEqual([
      {
        peerLdpId: '10.20.30.40:0',
        state: 'UP',
        statusText: 'Operational',
        localLdpId: null,
        role: 'Passive',
        name: null,
        sessionAgeSeconds: 1,
        source: 'SSH',
      },
      {
        peerLdpId: '10.20.30.50:0',
        state: 'DOWN',
        statusText: 'OpenSent',
        localLdpId: null,
        role: 'Active',
        name: null,
        sessionAgeSeconds: 0,
        source: 'SSH',
      },
    ]);
  });

  it('le o formato em bloco com LDP ID local', () => {
    const [peer] = parseHuaweiLdpSessions(`
Peer LDP ID     : 10.20.30.40:0
Local LDP ID    : 10.20.30.41:0
Session State   : Operational
Session Age     : 0012:30:15
`);

    expect(peer).toMatchObject({
      peerLdpId: '10.20.30.40:0',
      state: 'UP',
      localLdpId: '10.20.30.41:0',
      sessionAgeSeconds: 12 * 3600 + 30 * 60 + 15,
    });
  });

  it('nao inventa sessao quando o comando nao trouxe nenhuma linha valida', () => {
    expect(parseHuaweiLdpSessions('Error: Unrecognized command found at "^" position.')).toEqual([]);
  });
});

describe('parseHuaweiLdpRemotePeers', () => {
  it('le o nome e o endereco dos remote-peers configurados', () => {
    const peers = parseHuaweiLdpRemotePeers(`
Remote Peer Information
-------------------------
 Remote Peer Name     : rr-sba
 Remote Peer IP       : 10.20.30.40
 LDP ID               : 10.20.30.41:0
`);

    expect(peers).toEqual([
      { name: 'rr-sba', ipAddress: '10.20.30.40', localLdpId: '10.20.30.41:0' },
    ]);
  });

  // Fixture sanitizada do S6730S real: nome entre aspas, IP do vizinho e LDP ID
  // local na mesma linha (duas chaves por linha).
  it('le o formato real com aspas e LDP ID local', () => {
    const peers = parseHuaweiLdpRemotePeers(`
                         LDP Remote Entity Information
 ------------------------------------------------------------------------------
 Remote Peer Name  : "sw-lab-alfenas"
 Remote Peer IP    : 10.0.0.1       LDP ID        : 10.0.0.9:0
 Transport Address : 10.0.0.9       Entity Status : Active
 ------------------------------------------------------------------------------
 Remote Peer Name  : "sw-lab-paraguacu"
 Remote Peer IP    : 10.0.0.2       LDP ID        : 10.0.0.9:0
 Transport Address : 10.0.0.9       Entity Status : Active`);

    expect(peers).toEqual([
      { name: 'sw-lab-alfenas', ipAddress: '10.0.0.1', localLdpId: '10.0.0.9:0' },
      { name: 'sw-lab-paraguacu', ipAddress: '10.0.0.2', localLdpId: '10.0.0.9:0' },
    ]);
  });

  it('devolve lista vazia quando o comando nao trouxe bloco de peer', () => {
    expect(parseHuaweiLdpRemotePeers('No remote peer')).toEqual([]);
  });
});

describe('parseHuaweiL2vc', () => {
  it('extrai AC, VC ID, destino, estado e labels do l2vc', () => {
    const [vc] = parseHuaweiL2vc(`Total ldp vc : 1

 *Client Interface     : GigabitEthernet0/0/1
  VC State             : up
  VC ID                : 100
  VC Type              : VLAN
  Destination          : 10.20.30.40
  Local VC Label       : 1024
  Remote VC Label      : 1025
  Tunnel Policy        : LDP`);

    expect(vc).toEqual({
      acInterfaceName: 'GigabitEthernet0/0/1',
      vcId: 100,
      destination: '10.20.30.40',
      state: 'UP',
      acState: 'UNKNOWN',
      sessionState: 'UNKNOWN',
      vcType: 'VLAN',
      mtu: null,
      localLabel: 1024,
      remoteLabel: 1025,
      tunnelPolicy: 'LDP',
    });
  });

  // Fixture sanitizada do S6730S real (ELOI MENDES - SW MPLS): duas chaves por
  // linha, estado no cabecalho do AC e total impresso.
  const S6730S_L2VC = ` Total LDP VC : 2     1 up       1 down

 *client interface       : Vlanif900 is up
  Administrator PW       : no
  session state          : up
  AC status              : up
  VC state               : up
  VC ID                  : 900
  VC type                : VLAN
  destination            : 10.0.0.5
  local VC label         : 1024         remote VC label      : 1024
  local VC MTU           : 1500         remote VC MTU        : 1500
  tunnel policy name     : --
  PW template name       : sw-lab-template

 *client interface       : Vlanif901 is down
  session state          : up
  AC status              : down
  VC state               : down
  VC ID                  : 901
  VC type                : VLAN
  destination            : 10.0.0.6
  local VC label         : 1025         remote VC label      : 1025
`;

  it('le o formato real do S6730S com duas chaves por linha', () => {
    const [up, down] = parseHuaweiL2vc(S6730S_L2VC);

    expect(up).toEqual({
      acInterfaceName: 'Vlanif900',
      vcId: 900,
      destination: '10.0.0.5',
      state: 'UP',
      acState: 'UP',
      sessionState: 'UP',
      vcType: 'VLAN',
      mtu: 1500,
      localLabel: 1024,
      remoteLabel: 1024,
      tunnelPolicy: null,
    });
    expect(down).toMatchObject({
      acInterfaceName: 'Vlanif901',
      vcId: 901,
      state: 'DOWN',
      acState: 'DOWN',
      sessionState: 'UP',
      destination: '10.0.0.6',
      localLabel: 1025,
      remoteLabel: 1025,
    });
  });

  it('le a linha de totais do l2vc', () => {
    expect(parseHuaweiL2vcSummary(S6730S_L2VC)).toEqual({ total: 2, up: 1, down: 1 });
    expect(parseHuaweiL2vcSummary('sem total')).toEqual({ total: null, up: null, down: null });
  });

  it('devolve lista vazia para saida nao reconhecida', () => {
    expect(parseHuaweiL2vc('Total ldp vc : 0')).toEqual([]);
  });
});
