import { describe, expect, it } from 'vitest';
import { normalizeMplsOverview } from './mpls-overview';

/** Resposta da API ANTERIOR ao release MPLS/SSH (sem descoberta SSH). */
const apiAntiga = {
  supported: true,
  capabilities: { vsi: true, ac: true, pw: true },
  source: 'SNMP',
  lastPollingAt: '2026-11-18T12:00:00.000Z',
  lastSuccessAt: '2026-11-18T11:59:00.000Z',
  lastErrorSafe: null,
  summary: {
    vsiTotal: 1,
    vsiUp: 1,
    vsiDown: 0,
    vsiDegraded: 0,
    pwTotal: 1,
    pwUp: 1,
    pwDown: 0,
  },
  vsis: [
    {
      id: 'vsi-1',
      hostId: 'h1',
      name: 'CLIENTE_A',
      signalingType: 'ldp',
      rd: null,
      status: 'UP',
      operationalStatus: 'UP',
      adminStatus: 'UP',
      mtu: 1500,
      vcType: 'vlan',
      tunnelPolicy: null,
      description: null,
      vlanId: null,
      localInterfaceId: null,
      source: 'SNMP',
      lastSeenAt: '2026-11-18T11:59:00.000Z',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-18T11:59:00.000Z',
      acs: [],
      pws: [],
    },
  ],
};

describe('P5 — painel MPLS tolerante ao DTO da API antiga', () => {
  it('completa colecoes ausentes com lista vazia', () => {
    const overview = normalizeMplsOverview(apiAntiga);
    expect(overview.ldpPeers).toEqual([]);
    expect(overview.l2vcCircuits).toEqual([]);
    expect(overview.conflicts).toEqual([]);
    expect(overview.sources).toEqual([]);
    expect(overview.diagnosticEnabled).toBeUndefined();
  });

  it('nao inventa estado de descoberta: API antiga fica UNKNOWN, nunca NOT_FOUND', () => {
    expect(normalizeMplsOverview(apiAntiga).discoveryState).toBe('UNKNOWN');
    expect(normalizeMplsOverview({ supported: false }).discoveryState).toBe('UNSUPPORTED');
    expect(normalizeMplsOverview({ ...apiAntiga, discoveryState: 'FOUND_L2VC' }).discoveryState).toBe(
      'FOUND_L2VC',
    );
    expect(
      normalizeMplsOverview({ ...apiAntiga, discoveryState: 'INVENTADO' }).discoveryState,
    ).toBe('UNKNOWN');
  });

  it('resumo sem os contadores novos nao vira NaN', () => {
    const overview = normalizeMplsOverview(apiAntiga);
    expect(overview.summary).toMatchObject({
      vsiTotal: 1,
      vsiUp: 1,
      vsiAdminDown: 0,
      vsiUnknown: 0,
    });
    expect(JSON.stringify(overview.summary)).not.toContain('null');
  });

  it('deriva o resumo quando a resposta nao traz nenhum', () => {
    const { summary: _omitido, ...semResumo } = apiAntiga;
    const overview = normalizeMplsOverview(semResumo);
    expect(overview.summary.vsiTotal).toBe(1);
    expect(overview.summary.vsiUp).toBe(1);
  });

  it('deriva capacidades quando a API antiga nao declarava', () => {
    const { capabilities: _omitido, ...semCapacidades } = apiAntiga;
    const overview = normalizeMplsOverview(semCapacidades);
    expect(overview.capabilities).toEqual({ vsi: true, ac: false, pw: false });
  });

  it('VSI sem acs/pws nao quebra o painel', () => {
    const overview = normalizeMplsOverview({
      ...apiAntiga,
      vsis: [{ ...apiAntiga.vsis[0], acs: undefined, pws: undefined }],
    });
    expect(overview.vsis[0]?.acs).toEqual([]);
    expect(overview.vsis[0]?.pws).toEqual([]);
  });

  it('resposta vazia ou invalida vira overview seguro', () => {
    for (const payload of [null, undefined, {}, [], 'erro']) {
      const overview = normalizeMplsOverview(payload);
      expect(overview.supported).toBe(false);
      expect(overview.vsis).toEqual([]);
      expect(overview.discoveryState).toBe('UNSUPPORTED');
    }
  });

  it('nao descarta os campos do contrato novo', () => {
    const overview = normalizeMplsOverview({
      ...apiAntiga,
      discoveryState: 'CONFLICT',
      sources: ['SNMP', 'SSH'],
      diagnosticEnabled: true,
      diagnosticTrust: 'AVAILABLE',
      ldpPeers: [{ peerLdpId: '10.0.0.1:0', state: 'UP', source: 'SSH' }],
      l2vcCircuits: [{ name: 'Vlanif900', vcId: 900, state: 'UP', source: 'SSH' }],
      conflicts: [{ vsiName: 'CLIENTE_A', field: 'status', snmpValue: 'UP', sshValue: 'DOWN' }],
    });
    expect(overview.discoveryState).toBe('CONFLICT');
    expect(overview.sources).toEqual(['SNMP', 'SSH']);
    expect(overview.diagnosticEnabled).toBe(true);
    expect(overview.diagnosticTrust).toBe('AVAILABLE');
    expect(overview.ldpPeers).toHaveLength(1);
    expect(overview.l2vcCircuits).toHaveLength(1);
    expect(overview.conflicts).toHaveLength(1);
  });

  it('descarta fonte desconhecida em vez de exibi-la', () => {
    expect(normalizeMplsOverview({ ...apiAntiga, sources: ['SNMP', 'CDP'] }).sources).toEqual([
      'SNMP',
    ]);
  });
});
