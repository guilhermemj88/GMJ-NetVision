// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import type { MplsHostOverview, MplsPw } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import {
  MplsCollectionWarning,
  MplsContent,
  MplsUnavailableState,
  mplsDiscoveryStateLabel,
} from './mpls-panel';
import { normalizeMplsOverview } from '@/lib/mpls-overview';

function pw(remoteIp: string, pwId: number, status: MplsPw['status']): MplsPw {
  return {
    id: `pw-${pwId}`,
    hostId: 'host-1',
    mplsVsiId: 'vsi-1',
    vsiName: 'GERENCIA',
    pwId,
    remoteIp,
    remoteHostId: pwId === 4 ? 'remote-4' : null,
    remoteHost:
      pwId === 4 ? { id: 'remote-4', name: 'BHE-LIKEE-6730-MPLS-01', hostname: 'bhe-likee' } : null,
    tunnelPolicy: 'LDP',
    pwType: 'NORMAL',
    inboundLabel: pwId === 4 ? 36323 : 10_000 + pwId,
    outboundLabel: pwId === 4 ? 35937 : 20_000 + pwId,
    status,
    state: status === 'UP' ? 'UP' : 'DOWN',
    workingState: 'MASTER',
    upStartTime: status === 'UP' ? '2026-08-01T00:00:00.000Z' : null,
    upSumTime: null,
    source: 'SNMP',
    lastSeenAt: '2026-08-25T12:00:00.000Z',
    createdAt: '2026-08-25T12:00:00.000Z',
    updatedAt: '2026-08-25T12:00:00.000Z',
  };
}

const peers = ['10.100.101.0', '10.100.101.3', '10.100.101.5', '10.100.101.11', '10.100.101.255'];
const overview: MplsHostOverview = {
  supported: true,
  discoveryState: 'FOUND_MIXED',
  capabilities: { vsi: true, ac: false, pw: true },
  source: 'SNMP',
  sources: ['SNMP'],
  ldpPeers: [],
  l2vcCircuits: [],
  conflicts: [],
  lastPollingAt: '2026-08-25T12:00:00.000Z',
  lastSuccessAt: '2026-08-25T12:00:00.000Z',
  lastErrorSafe: null,
  summary: {
    vsiTotal: 1,
    vsiUp: 0,
    vsiDown: 0,
    vsiDegraded: 1,
    vsiAdminDown: 0,
    vsiUnknown: 0,
    pwTotal: 5,
    pwUp: 4,
    pwDown: 1,
  },
  vsis: [
    {
      id: 'vsi-1',
      hostId: 'host-1',
      name: 'GERENCIA',
      signalingType: 'LDP',
      rd: '4.6424:99',
      vsiId: 99,
      status: 'DEGRADED',
      operationalStatus: 'UP',
      adminStatus: 'UP',
      mtu: 1500,
      vcType: 'UNKNOWN',
      tunnelPolicy: 'LDP',
      description: 'Gestão',
      memberDiscovery: null,
      vlanId: null,
      localInterfaceId: null,
      source: 'SNMP',
      lastSeenAt: '2026-08-25T12:00:00.000Z',
      createdAt: '2026-08-25T12:00:00.000Z',
      updatedAt: '2026-08-25T12:00:00.000Z',
      acs: [],
      pws: peers.map((remoteIp, position) =>
        pw(remoteIp, position + 1, position === 4 ? 'DOWN' : 'UP'),
      ),
    },
  ],
};

describe('MplsContent', () => {
  it('shows a multipoint VSI with every peer and keeps VLAN unknown without heuristics', () => {
    const html = renderToStaticMarkup(<MplsContent overview={overview} events={[]} />);

    expect(html).toContain('GERENCIA');
    expect(html).toContain('VLAN N/D');
    expect(html).toContain('4/5 UP');
    for (const remoteIp of peers) expect(html).toContain(remoteIp);
    expect(html).toContain('BHE-LIKEE-6730-MPLS-01');
    expect(html).toContain('Equipamento não identificado');
    expect(html).toContain('Detalhes técnicos');
    expect(html).toContain('36323');
    expect(html).toContain('35937');
    expect(html).not.toMatch(/HUAWEI|1\.3\.6\.1/);
  });

  it('distinguishes a collection error from an unsupported capability', () => {
    const failedOverview: MplsHostOverview = {
      ...overview,
      supported: false,
      discoveryState: 'UNKNOWN',
      lastErrorSafe: 'SNMP timeout',
      vsis: [],
    };
    const failedHtml = renderToStaticMarkup(<MplsUnavailableState overview={failedOverview} />);
    expect(failedHtml).toContain('Falha na coleta MPLS');
    expect(failedHtml).not.toContain('MPLS não disponível');

    const unsupportedHtml = renderToStaticMarkup(
      <MplsUnavailableState
        overview={{
          ...failedOverview,
          discoveryState: 'UNSUPPORTED',
          lastErrorSafe: null,
          lastSuccessAt: overview.lastSuccessAt,
        }}
      />,
    );
    expect(unsupportedHtml).toContain('MPLS não disponível');
    expect(unsupportedHtml).not.toContain('Falha na coleta MPLS');

    const pendingHtml = renderToStaticMarkup(
      <MplsUnavailableState
        overview={{
          ...failedOverview,
          discoveryState: 'UNKNOWN',
          lastErrorSafe: null,
          lastSuccessAt: null,
        }}
      />,
    );
    expect(pendingHtml).toContain('MPLS ainda não coletado');
    expect(pendingHtml).not.toContain('MPLS não disponível');
  });

  it('never claims MPLS absence when the discovery was merely inconclusive', () => {
    const inconclusive: MplsHostOverview = {
      ...overview,
      supported: false,
      discoveryState: 'INCOMPLETE',
      sources: ['SNMP'],
      lastErrorSafe: null,
      lastSuccessAt: overview.lastSuccessAt,
      vsis: [],
    };
    const html = renderToStaticMarkup(<MplsUnavailableState overview={inconclusive} />);

    expect(html).toContain('Coleta MPLS incompleta');
    expect(html).toContain('não comprova ausência de VSI');
    expect(html).not.toContain('MPLS não disponível');
    expect(html).not.toContain('HUAWEI-VPLS-EXT-MIB');
  });

  it('reports an empty but conclusive read as no VSI configured', () => {
    const empty: MplsHostOverview = {
      ...overview,
      supported: false,
      discoveryState: 'NOT_FOUND',
      sources: ['SNMP', 'SSH'],
      lastErrorSafe: null,
      vsis: [],
    };
    const html = renderToStaticMarkup(<MplsUnavailableState overview={empty} />);

    expect(html).toContain('Nenhuma VSI configurada');
    expect(html).toContain('Fontes: SNMP + SSH');
    expect(html).not.toContain('MPLS não disponível');
  });

  it('separates LDP transport from the VSI service and shows the source', () => {
    const html = renderToStaticMarkup(
      <MplsContent
        overview={{
          ...overview,
          sources: ['SNMP', 'SSH'],
          ldpPeers: [
            {
              peerLdpId: '10.20.30.40:0',
              state: 'UP',
              statusText: 'Operational',
              localLdpId: '10.20.30.41:0',
              role: 'Passive',
              name: 'rr-sba',
              sessionAgeSeconds: 3661,
              source: 'SSH',
            },
            {
              peerLdpId: '10.20.30.50:0',
              state: 'DOWN',
              statusText: 'OpenSent',
              localLdpId: null,
              role: 'Active',
              name: null,
              sessionAgeSeconds: null,
              source: 'SSH',
            },
          ],
        }}
        events={[]}
      />,
    );

    expect(html).toContain('Transporte MPLS · sessões LDP');
    expect(html).toContain('10.20.30.40:0');
    expect(html).toContain('Operational');
    expect(html).toContain('local 10.20.30.41:0');
    expect(html).toContain('OpenSent');
    expect(html).toContain('Fonte: SSH');
    expect(html).toContain('mpls-source-tag');
  });

  it('shows both evidences when SNMP and SSH disagree', () => {    const html = renderToStaticMarkup(
      <MplsContent
        overview={{
          ...overview,
          discoveryState: 'CONFLICT',
          sources: ['SNMP', 'SSH'],
          conflicts: [
            {
              vsiName: 'GERENCIA',
              field: 'status',
              snmpValue: 'DOWN',
              sshValue: 'UP',
            },
          ],
        }}
        events={[]}
      />,
    );

    expect(html).toContain('Informações conflitantes entre SNMP e SSH');
    expect(html).toContain('SNMP DOWN × SSH UP');
  });

  it('warns about a partial failure while keeping supported MPLS data visible', () => {
    const html = renderToStaticMarkup(
      <MplsCollectionWarning overview={{ ...overview, lastErrorSafe: 'PW .8: SNMP timeout' }} />,
    );
    expect(html).toContain('Falha na coleta MPLS');
    expect(html).toContain('PW .8: SNMP timeout');
  });

  it('shows correlated AC details and PW as N/D when that capability is absent', () => {
    const vsi = overview.vsis[0]!;
    const acOnlyOverview: MplsHostOverview = {
      ...overview,
      capabilities: { vsi: true, ac: true, pw: false },
      summary: {
        ...overview.summary,
        vsiUp: 1,
        vsiDegraded: 0,
        pwTotal: 0,
        pwUp: 0,
        pwDown: 0,
      },
      vsis: [
        {
          ...vsi,
          status: 'UP',
          vlanId: 99,
          localInterfaceId: 'interface-43',
          acs: [
            {
              id: 'ac-43',
              hostId: 'host-1',
              mplsVsiId: vsi.id,
              vsiName: vsi.name,
              ifIndex: 43,
              interfaceId: 'interface-43',
              interface: {
                id: 'interface-43',
                name: 'Vlanif99',
                alias: '99-GERENCIA',
                ifIndex: 43,
              },
              status: 'UP',
              upStartTimeRaw: '2025/09/17 20:49:53',
              upSumTimeRaw: 29537970,
              source: 'SNMP',
              lastSeenAt: vsi.lastSeenAt,
              createdAt: vsi.createdAt,
              updatedAt: vsi.updatedAt,
            },
          ],
          pws: [],
        },
      ],
    };

    const html = renderToStaticMarkup(<MplsContent overview={acOnlyOverview} events={[]} />);

    expect(html).toContain('VLAN 99');
    expect(html).toContain('Vlanif99');
    expect(html).toContain('99-GERENCIA');
    expect(html).toContain('ifIndex 43');
    expect(html).toContain('N/D — não disponível nas fontes consultadas');
    expect(html).toContain('PW não disponível via SNMP neste equipamento');
    expect(html).not.toContain('0 / 0 UP');
  });

  it('makes UNKNOWN visible in the summary', () => {
    const html = renderToStaticMarkup(
      <MplsContent
        overview={{
          ...overview,
          summary: { ...overview.summary, vsiDegraded: 0, vsiUnknown: 1 },
          vsis: [{ ...overview.vsis[0]!, status: 'UNKNOWN' }],
        }}
        events={[]}
      />,
    );
    expect(html).toContain('Unknown');
  });

  // Cenário homologado no S6730S: sem VSI, serviço existe como L2VC (VPWS).
  it('lista serviços L2VC (VPWS) quando o equipamento não tem VSI', () => {
    const html = renderToStaticMarkup(
      <MplsContent
        overview={{
          ...overview,
          supported: true,
          discoveryState: 'FOUND_L2VC',
          sources: ['SNMP', 'SSH'],
          vsis: [],
          summary: {
            ...overview.summary,
            vsiTotal: 0,
            vsiUp: 0,
            vsiDegraded: 0,
            pwTotal: 0,
            pwUp: 0,
            pwDown: 0,
          },
          l2vcCircuits: [
            {
              name: 'Vlanif900',
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
              source: 'SSH',
            },
            {
              name: 'Vlanif901',
              vcId: 901,
              destination: '10.0.0.6',
              state: 'DOWN',
              acState: 'DOWN',
              sessionState: 'UP',
              vcType: 'VLAN',
              mtu: null,
              localLabel: 1025,
              remoteLabel: 1025,
              tunnelPolicy: null,
              source: 'SSH',
            },
          ],
        }}
        events={[]}
      />,
    );

    expect(html).toContain('Serviços ponto a ponto · L2VC (VPWS)');
    expect(html).toContain('Vlanif900');
    expect(html).toContain('10.0.0.5');
    expect(html).toContain('labels 1024/1024');
    expect(html).toContain('Vlanif901');
    expect(html).toContain('Nenhuma VSI/VPLS configurada');
    expect(html).toContain('Fonte: SSH');
  });

  it('rotula o estado FOUND_L2VC', () => {
    expect(mplsDiscoveryStateLabel('FOUND_L2VC')).toContain('L2VC');
  });

  it('P5: renderiza o DTO da API antiga sem quebrar', () => {
    // Resposta do release anterior ao MPLS/SSH: sem ldpPeers, l2vcCircuits,
    // conflicts, sources, discoveryState e sem os contadores novos do resumo.
    const antiga = normalizeMplsOverview({
      supported: true,
      capabilities: { vsi: true, ac: true, pw: true },
      source: 'SNMP',
      lastPollingAt: '2026-08-25T12:00:00.000Z',
      lastSuccessAt: '2026-08-25T12:00:00.000Z',
      lastErrorSafe: null,
      summary: { vsiTotal: 1, vsiUp: 1, vsiDown: 0, vsiDegraded: 0, pwTotal: 0, pwUp: 0, pwDown: 0 },
      vsis: [
        {
          id: 'vsi-antiga',
          hostId: 'host-1',
          name: 'CLIENTE_ANTIGO',
          signalingType: 'LDP',
          status: 'UP',
          operationalStatus: 'UP',
          adminStatus: 'UP',
          mtu: 1500,
          vcType: 'VLAN',
          source: 'SNMP',
          lastSeenAt: '2026-08-25T11:59:00.000Z',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-25T11:59:00.000Z',
        },
      ],
    });

    const html = renderToStaticMarkup(<MplsContent overview={antiga} events={[]} />);
    expect(html).toContain('CLIENTE_ANTIGO');
    // Sem estado de descoberta nao se afirma ausencia de servico.
    expect(html).not.toContain('Nenhuma VSI/VPLS configurada');
  });

  it('P5: estado indisponivel da API antiga tambem renderiza', () => {
    const html = renderToStaticMarkup(
      <MplsUnavailableState overview={normalizeMplsOverview({ supported: false })} />,
    );
    expect(html).toContain('MPLS');
  });
});
