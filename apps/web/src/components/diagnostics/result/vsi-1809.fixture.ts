import type {
  VsiDiagnosticCheck,
  VsiDiagnosticEndpointAccess,
  VsiDiagnosticResult,
} from '@gmj/shared';

/**
 * Caso produtivo de referencia (execucao 04778b69-…, VSI 1809-L2L-VCONLINE-QinQ),
 * reconstruido a partir do resultado relatado e do audit log. Somente para testes
 * e validacao visual: nao contem saida real de equipamento nem segredo.
 */
const LOCAL = 'host-17341ed0-2785-475f-8ec6-e4efd843cd69';
const REMOTE = 'host-feb52fc5-2ddc-41f3-b3d0-69f9eb177a90';
const AT = '2026-10-26T13:52:10.000Z';

function check(
  id: string,
  category: VsiDiagnosticCheck['category'],
  label: string,
  hostId: string,
  message: string,
): VsiDiagnosticCheck {
  return {
    id,
    category,
    label,
    status: 'OK',
    hostId,
    message,
    evidence: [],
    durationMs: 0,
    certainty: 'CONFIRMED',
    required: true,
  };
}

export function access(
  hostId: string,
  name: string,
  patch: Partial<VsiDiagnosticEndpointAccess> = {},
): VsiDiagnosticEndpointAccess {
  return {
    hostId,
    name,
    sshUsername: 'guilherme3',
    commandAuthorization: 'CONFIRMED_FOR_EXECUTED_COMMANDS',
    executedCommands: 7,
    acceptedCommands: 7,
    devicePrivilegeLevel: 'NOT_VERIFIED',
    ...patch,
  };
}

const commands = [
  'screen-length 0 temporary',
  'display version',
  'display mpls ldp',
  'display ip interface brief',
  'display vsi name 1809-L2L-VCONLINE-QinQ verbose',
];

export const VSI_1809_IDS = { LOCAL, REMOTE } as const;

export const vsi1809Result: VsiDiagnosticResult = {
  diagnosticId: '04778b69-33e2-4242-baf9-6591381f8375',
  hostId: LOCAL,
  vsiId: 'vsi-1809-local',
  vsiName: '1809-L2L-VCONLINE-QinQ',
  operator: { id: 'admin', username: 'admin', role: 'ADMIN' },
  state: 'COMPLETED',
  stage: 'Concluído',
  progress: [
    { stage: 'Aguardando execução', at: '2026-10-26T13:52:00.000Z' },
    { stage: 'Correlacionando evidências', at: '2026-10-26T13:52:09.000Z' },
    { stage: 'Concluído', at: AT },
  ],
  startedAt: '2026-10-26T13:52:00.000Z',
  completedAt: AT,
  underlayClassification: 'UNDERLAY_REACHABLE',
  overallStatus: 'OK',
  summary:
    'Nenhuma falha foi identificada no underlay entre os PEs, no pseudowire ou nos attachment circuits avaliados.',
  local: {
    hostId: LOCAL,
    name: 'IIE-VSR-6730-MPLS-01',
    vsiId: 'vsi-1809-local',
    vsiName: '1809-L2L-VCONLINE-QinQ',
    loopback: {
      address: '10.100.101.5',
      interfaceName: 'LoopBack0',
      routingContext: 'GLOBAL',
      evidence: [],
    },
    association: 'LOCAL',
    observedVsi: {
      vsiId: null,
      status: 'UP',
      peers: [
        {
          address: '10.100.101.6',
          vcId: null,
          state: 'UP',
          inboundLabel: 38464,
          outboundLabel: 37134,
          tunnel: null,
        },
      ],
    },
  },
  remotes: [
    {
      hostId: REMOTE,
      name: 'RNS-FLOR-6730-MPLS-01',
      vsiId: 'vsi-1809-remote',
      vsiName: '1809-L2L-VCONLINE-QinQ',
      loopback: {
        address: '10.100.101.6',
        interfaceName: 'LoopBack0',
        routingContext: 'GLOBAL',
        evidence: [],
      },
      association: 'PERSISTED_REMOTE_ID',
      observedVsi: {
        vsiId: null,
        status: 'UP',
        peers: [
          {
            address: '10.100.101.5',
            vcId: null,
            state: 'UP',
            inboundLabel: 37134,
            outboundLabel: 38464,
            tunnel: null,
          },
        ],
      },
    },
  ],
  checks: [
    check(
      'l-lb',
      'UNDERLAY',
      'LoopBack atual',
      LOCAL,
      'CONFIRMED_LOOPBACK LoopBack0 10.100.101.5; GLOBAL.',
    ),
    check('l-vsi', 'VSI', 'VSI atual', LOCAL, 'VSI 1809-L2L-VCONLINE-QinQ: UP.'),
    check(
      'l-pw',
      'PW',
      'PW 10.100.101.6',
      LOCAL,
      'Peer observado 10.100.101.6; PW UP; labels 38464 / 37134.',
    ),
    check(
      'l-ac',
      'AC',
      'AC XGigabitEthernet0/0/6.1809',
      LOCAL,
      'XGigabitEthernet0/0/6.1809: físico UP, lógico UP.',
    ),
    check(
      'r-lb',
      'UNDERLAY',
      'LoopBack atual',
      REMOTE,
      'CONFIRMED_LOOPBACK LoopBack0 10.100.101.6; GLOBAL.',
    ),
    check('r-vsi', 'VSI', 'VSI atual', REMOTE, 'VSI 1809-L2L-VCONLINE-QinQ: UP.'),
    check(
      'r-pw',
      'PW',
      'PW 10.100.101.5',
      REMOTE,
      'Peer observado 10.100.101.5; PW UP; labels 37134 / 38464.',
    ),
    check(
      'r-ac',
      'AC',
      'AC XGigabitEthernet0/0/16.1809',
      REMOTE,
      'XGigabitEthernet0/0/16.1809: físico UP, lógico UP.',
    ),
    check(
      'recip',
      'PW',
      'Reciprocidade e labels',
      REMOTE,
      'Peers recíprocos e labels cruzados MATCH na execução atual.',
    ),
    check('reach-l', 'LOOPBACK_REACHABILITY', 'LOCAL', LOCAL, '3/3 respostas; perda 0%.'),
    check('reach-r', 'LOOPBACK_REACHABILITY', 'REMOTE', REMOTE, '3/3 respostas; perda 0%.'),
  ],
  evidence: [
    ...[LOCAL, REMOTE].flatMap((hostId, h) =>
      [
        ...commands,
        h === 0
          ? 'display interface XGigabitEthernet0/0/6.1809'
          : 'display interface XGigabitEthernet0/0/16.1809',
      ].map((command, i) => ({
        id: `ev-${h}-${i}`,
        diagnosticId: '04778b69-33e2-4242-baf9-6591381f8375',
        hostId,
        source: 'LIVE_SSH' as const,
        observedAt: AT,
        collectedAt: AT,
        command,
        output: `<${h === 0 ? 'IIE-VSR-6730-MPLS-01' : 'RNS-FLOR-6730-MPLS-01'}>${command}\n(saída sanitizada de referência)`,
        complete: true,
        durationMs: 120,
      })),
    ),
    {
      id: 'ev-ping-l',
      diagnosticId: '04778b69-33e2-4242-baf9-6591381f8375',
      hostId: LOCAL,
      source: 'LIVE_SSH',
      observedAt: AT,
      collectedAt: AT,
      command: 'ping -a 10.100.101.5 -c 3 10.100.101.6',
      output: '3 packet(s) transmitted\n3 packet(s) received\n0.00% packet loss',
      complete: true,
      durationMs: 2100,
    },
  ],
  probes: [
    {
      sourceHostId: LOCAL,
      destinationHostId: REMOTE,
      source: '10.100.101.5',
      destination: '10.100.101.6',
      routingContext: 'GLOBAL',
      lossPercent: 0,
      rttMs: { min: 3, avg: 4, max: 5 },
      hops: [],
      status: 'OK',
      transmitted: 3,
      received: 3,
      tracerouteNotExecutedReason: 'NOT_HOMOLOGATED',
    },
    {
      sourceHostId: REMOTE,
      destinationHostId: LOCAL,
      source: '10.100.101.6',
      destination: '10.100.101.5',
      routingContext: 'GLOBAL',
      lossPercent: 0,
      rttMs: { min: 3, avg: 4, max: 6 },
      hops: [],
      status: 'OK',
      transmitted: 3,
      received: 3,
      tracerouteNotExecutedReason: 'NOT_HOMOLOGATED',
    },
  ],
  warnings: [
    'Conclusão limitada às evidências e horários desta execução; não certifica toda a rede ou o serviço do cliente.',
    'Ping IP não comprova caminho físico, caminho completo da VSI, LSP ou entrega ao cliente.',
    'Traceroute real desabilitado: NOT_HOMOLOGATED.',
    'F1A, cliente final, porta física, CRC, LLDP e LSP detalhado não avaliados.',
  ],
  nextTests: [
    'Homologar o fluxo nativo completo pela API/WEB em release isolada, mediante nova autorização para testes ativos.',
  ],
  executionContext: {
    endpoints: [access(LOCAL, 'IIE-VSR-6730-MPLS-01'), access(REMOTE, 'RNS-FLOR-6730-MPLS-01')],
  },
};
