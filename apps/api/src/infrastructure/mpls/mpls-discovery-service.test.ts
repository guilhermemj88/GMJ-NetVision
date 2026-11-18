import { describe, expect, it } from 'vitest';
import type { MplsLdpPeer } from '@gmj/shared';
import type { CollectedMplsVsi, HuaweiVplsCollection } from './huawei-vpls-snmp';
import {
  HUAWEI_VPLS_AC_WALK_COLUMNS,
  HUAWEI_VPLS_PW_WALK_COLUMNS,
  HUAWEI_VPLS_VSI_WALK_COLUMNS,
} from './huawei-vpls-oids';
import type { HuaweiVsiSshReading } from './huawei-vsi-ssh';
import { parseHuaweiVsiVerbose } from './huawei-vsi-ssh-parser';
import { mergeMplsDiscovery } from './mpls-discovery-service';

const COLLECTED_AT = new Date('2026-11-18T12:00:00.000Z');

function snmpVsi(name: string, overrides: Partial<CollectedMplsVsi> = {}): CollectedMplsVsi {
  return {
    name,
    signalingType: 'BGP',
    rd: '65000:100',
    vsiId: 100,
    status: 'UP',
    operationalStatus: 'UP',
    adminStatus: 'UP',
    mtu: 1500,
    vcType: 'ETHERNET',
    tunnelPolicy: null,
    description: null,
    statusObserved: true,
    statusComplete: true,
    acs: [],
    pws: [],
    ...overrides,
  };
}

function snmpCollection(vsis: CollectedMplsVsi[] = []): HuaweiVplsCollection {
  const supported = vsis.length > 0;
  return {
    supported,
    collectedAt: COLLECTED_AT,
    errors: [],
    capabilities: { vsi: supported, ac: supported, pw: supported },
    collectedColumns: {
      vsi: supported ? [...HUAWEI_VPLS_VSI_WALK_COLUMNS] : [],
      ac: supported ? [...HUAWEI_VPLS_AC_WALK_COLUMNS] : [],
      pw: supported ? [...HUAWEI_VPLS_PW_WALK_COLUMNS] : [],
    },
    vsis,
  };
}

function sshReading(
  verbose: string,
  overrides: Partial<HuaweiVsiSshReading> = {},
): HuaweiVsiSshReading {
  return {
    available: true,
    supported: true,
    collectedAt: COLLECTED_AT,
    vsis: parseHuaweiVsiVerbose(verbose),
    ldpPeers: [],
    l2vcs: [],
    warnings: [],
    errorSafe: null,
    ...overrides,
  };
}

const LDP_UP = `**VSI Name               : VSI-GERENCIA
  VSI State              : up
  VSI ID                 : 100
  VSI Signaling Type     : ldp
  *Peer Router ID        : 10.20.30.40
   Negotiated MTU        : 1500
   Local VC Label        : 1024
   Remote VC Label       : 1025
   VC Type               : ethernet
   VC State              : up
   Link ID               : 1
   Local AC Interface    : GE0/0/1
`;

const LDP_DOWN = `**VSI Name               : VSI-CLIENTE
  VSI State              : down
  VSI ID                 : 200
  VSI Signaling Type     : ldp
  *Peer Router ID        : 10.20.30.50
   VC State              : down
   Link ID               : 2
`;

describe('mergeMplsDiscovery', () => {
  it('encontra VSI LDP estatica UP quando a MIB nao devolve entrada alguma', () => {
    const result = mergeMplsDiscovery({
      snmp: snmpCollection(),
      ssh: sshReading(LDP_UP),
    });

    expect(result.discoveryState).toBe('FOUND_UP');
    expect(result.sources).toEqual(['SNMP', 'SSH']);
    expect(result.collection.supported).toBe(true);
    expect(result.collection.vsis).toHaveLength(1);
    expect(result.collection.vsis[0]).toMatchObject({
      name: 'VSI-GERENCIA',
      signalingType: 'LDP',
      status: 'UP',
      operationalStatus: 'UP',
      source: 'SSH',
      mtu: 1500,
      vcType: 'ETHERNET',
    });
    expect(result.collection.vsis[0]?.pws[0]).toMatchObject({
      pwId: 1,
      remoteIp: '10.20.30.40',
      inboundLabel: 1024,
      outboundLabel: 1025,
      status: 'UP',
      source: 'SSH',
    });
    expect(result.collection.vsis[0]?.acs[0]).toMatchObject({
      interfaceName: 'GE0/0/1',
      ifIndex: null,
      source: 'SSH',
    });
  });

  it('classifica VSI LDP DOWN como FOUND_DOWN', () => {
    const result = mergeMplsDiscovery({ snmp: snmpCollection(), ssh: sshReading(LDP_DOWN) });

    expect(result.discoveryState).toBe('FOUND_DOWN');
    expect(result.collection.vsis[0]).toMatchObject({ status: 'DOWN', operationalStatus: 'DOWN' });
  });

  it('mantem VSI sinalizada por BGP do equipamento', () => {
    const result = mergeMplsDiscovery({
      snmp: null,
      ssh: sshReading(`**VSI Name               : VSI-BGP
  VSI State              : up
  VSI ID                 : 300
  VSI RD                 : 65000:300
  VSI Signaling Type     : bgp
`),
    });

    expect(result.discoveryState).toBe('FOUND_UP');
    expect(result.sources).toEqual(['SSH']);
    expect(result.collection.vsis[0]).toMatchObject({ signalingType: 'BGP', rd: '65000:300' });
  });

  it('lista multiplas VSIs do mesmo equipamento sem duplicar', () => {
    const result = mergeMplsDiscovery({
      snmp: snmpCollection([
        snmpVsi('VSI-GERENCIA', { signalingType: 'LDP' }),
        snmpVsi('VSI-SO-SNMP', {
          signalingType: 'BGP',
          status: 'DOWN',
          operationalStatus: 'DOWN',
        }),
      ]),
      ssh: sshReading(`${LDP_UP}${LDP_DOWN}`),
    });

    expect(result.collection.vsis.map((vsi) => vsi.name)).toEqual([
      'VSI-CLIENTE',
      'VSI-GERENCIA',
      'VSI-SO-SNMP',
    ]);
    expect(result.discoveryState).toBe('FOUND_MIXED');
    // A VSI que as duas fontes viram continua unica; a que so o SNMP viu fica.
    expect(result.collection.vsis.find((vsi) => vsi.name === 'VSI-GERENCIA')?.source).toBe('SSH');
    expect(result.collection.vsis.find((vsi) => vsi.name === 'VSI-SO-SNMP')?.source).toBeUndefined();
    expect(result.conflicts).toEqual([]);
  });

  it('registra conflito com as duas evidencias quando SNMP e SSH divergem', () => {
    const result = mergeMplsDiscovery({
      snmp: snmpCollection([
        snmpVsi('VSI-GERENCIA', { status: 'DOWN', operationalStatus: 'DOWN' }),
      ]),
      ssh: sshReading(LDP_UP),
    });

    expect(result.discoveryState).toBe('CONFLICT');
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        { vsiName: 'VSI-GERENCIA', field: 'status', snmpValue: 'DOWN', sshValue: 'UP' },
        {
          vsiName: 'VSI-GERENCIA',
          field: 'signalingType',
          snmpValue: 'BGP',
          sshValue: 'LDP',
        },
      ]),
    );
    // A leitura viva da CLI prevalece, mas a evidencia SNMP fica guardada.
    expect(result.collection.vsis[0]?.status).toBe('UP');
    expect(result.collection.vsis[0]?.signalingType).toBe('LDP');
  });

  it('preserva a coleta SNMP quando o SSH nao responde', () => {
    const result = mergeMplsDiscovery({
      snmp: snmpCollection([snmpVsi('VSI-BGP')]),
      ssh: null,
    });

    expect(result.discoveryState).toBe('FOUND_UP');
    expect(result.sources).toEqual(['SNMP']);
    expect(result.collection.vsis[0]?.name).toBe('VSI-BGP');
    expect(result.collection.vsis[0]?.source).toBeUndefined();
  });

  it('nao conclui ausencia de servico quando MIB e SSH falham', () => {
    const result = mergeMplsDiscovery({ snmp: null, ssh: null });

    expect(result.discoveryState).toBe('INCOMPLETE');
    expect(result.collection.supported).toBe(false);
    expect(result.sources).toEqual([]);
  });

  it('marca INCOMPLETE quando a MIB vem vazia e o SSH falha por timeout', () => {
    const result = mergeMplsDiscovery({
      snmp: snmpCollection(),
      ssh: sshReading('', {
        available: false,
        supported: null,
        vsis: [],
        errorSafe: 'SSH connection timeout',
      }),
    });

    expect(result.discoveryState).toBe('INCOMPLETE');
    expect(result.collection.supported).toBe(false);
  });

  it('marca UNSUPPORTED quando o VRP nao reconhece VSI e a MIB esta vazia', () => {
    const result = mergeMplsDiscovery({
      snmp: snmpCollection(),
      ssh: sshReading('', { available: false, supported: false, vsis: [] }),
    });

    expect(result.discoveryState).toBe('UNSUPPORTED');
    expect(result.collection.supported).toBe(false);
  });

  it('so declara NOT_FOUND quando uma fonte concluiu a leitura sem VSI', () => {
    const result = mergeMplsDiscovery({ snmp: snmpCollection(), ssh: sshReading('') });

    expect(result.discoveryState).toBe('NOT_FOUND');
    expect(result.collection.supported).toBe(true);
    expect(result.collection.vsis).toEqual([]);
  });

  it('propaga as sessoes LDP como transporte, com peer DOWN visivel', () => {
    const ldpPeers: MplsLdpPeer[] = [
      {
        peerLdpId: '10.20.30.40:0',
        state: 'UP',
        statusText: 'Operational',
        localLdpId: '10.20.30.41:0',
        role: 'Passive',
        name: 'rr-sba',
        sessionAgeSeconds: 30,
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
    ];
    const result = mergeMplsDiscovery({
      snmp: snmpCollection(),
      ssh: sshReading(LDP_UP, { ldpPeers }),
    });

    expect(result.ldpPeers).toHaveLength(2);
    expect(result.ldpPeers[1]?.state).toBe('DOWN');
    expect(result.collection.ldpPeers).toHaveLength(2);
  });

  it('nao inventa pseudowire quando o link id nao veio no CLI', () => {
    const result = mergeMplsDiscovery({
      snmp: null,
      ssh: sshReading(`**VSI Name               : VSI-SEM-LINK
  VSI State              : up
  VSI Signaling Type     : ldp
  *Peer Router ID        : 10.20.30.60
   VC State              : up
`),
    });

    expect(result.collection.vsis[0]?.pws).toEqual([]);
  });

  it('mantem as colunas SNMP coletadas para nao sobrescrever campo nao lido', () => {
    const snmp = snmpCollection([snmpVsi('VSI-BGP')]);
    const result = mergeMplsDiscovery({ snmp, ssh: null });

    expect(result.collection.collectedColumns.vsi).toEqual(snmp.collectedColumns.vsi);
  });
});
