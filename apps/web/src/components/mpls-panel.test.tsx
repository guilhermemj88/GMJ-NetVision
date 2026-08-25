// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import type { MplsHostOverview, MplsPw } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { MplsCollectionWarning, MplsContent, MplsUnavailableState } from './mpls-panel';

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
  capabilities: { vsi: true, ac: false, pw: true },
  source: 'SNMP',
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
      lastErrorSafe: 'SNMP timeout',
      vsis: [],
    };
    const failedHtml = renderToStaticMarkup(<MplsUnavailableState overview={failedOverview} />);
    expect(failedHtml).toContain('Falha na coleta MPLS');
    expect(failedHtml).not.toContain('MPLS não disponível');

    const unsupportedHtml = renderToStaticMarkup(
      <MplsUnavailableState
        overview={{ ...failedOverview, lastErrorSafe: null, lastSuccessAt: overview.lastSuccessAt }}
      />,
    );
    expect(unsupportedHtml).toContain('MPLS não disponível');
    expect(unsupportedHtml).not.toContain('Falha na coleta MPLS');

    const pendingHtml = renderToStaticMarkup(
      <MplsUnavailableState
        overview={{ ...failedOverview, lastErrorSafe: null, lastSuccessAt: null }}
      />,
    );
    expect(pendingHtml).toContain('MPLS ainda não coletado');
    expect(pendingHtml).not.toContain('MPLS não disponível');
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
    expect(html).toContain('N/D — não disponível via SNMP');
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
});
