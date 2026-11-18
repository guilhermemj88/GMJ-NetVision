import {
  composeVsiServiceDiagnosis,
  type VsiEvidenceRef,
  type VsiObserved,
  type VsiServiceComposeInput,
  type VsiServiceDiagnosis,
  type VsiTimePrecision,
} from '@gmj/shared';
import { VSI_FIXTURE_CAPTURES as C } from './captures';

/**
 * FIXTURES DE DESENVOLVIMENTO — nao sao resultado de execucao do NetVision.
 *
 * Os valores vem das capturas reais ja coletadas (ver `captures.ts`). O que NAO foi lido no
 * equipamento esta declarado como nao lido; nenhum estado de VSI/AC/PW da VSI 3072 foi inventado:
 * so existe o registro do inventario SNMP, marcado como tal. O veredito e os eixos NAO sao
 * escritos aqui: saem de `composeVsiServiceDiagnosis`.
 */

const ASSEMBLED_AT = '2026-11-16T14:00:00.000Z';

function lines(output: string, needles: string[]): number[] {
  return output
    .split('\n')
    .map((line, i) => (needles.some((n) => line.includes(n)) ? i + 1 : 0))
    .filter((n) => n > 0);
}

function ev(
  id: string,
  readingId: string,
  hostName: string,
  command: string | null,
  at: string,
  output: string,
  extra: Partial<VsiEvidenceRef> & { used?: string[]; precision?: VsiTimePrecision } = {},
): VsiEvidenceRef {
  const { used, precision, ...rest } = extra;
  const snmp = command === null;
  return {
    id,
    readingId,
    hostId: null,
    hostName,
    source: snmp ? 'PERSISTED_SNMP' : 'LIVE_SSH',
    command,
    collectedAt: at,
    observedAt: at,
    ...(precision ? { timePrecision: precision } : {}),
    complete: true,
    bytes: output.length,
    sha256: null,
    usedLines: used ? lines(output, used) : [],
    output,
    note: null,
    ...rest,
  };
}

function live<T>(value: T, readingId: string, evidenceId: string, observedAt: string, precision?: VsiTimePrecision): VsiObserved<T> {
  return { value, basis: 'LIVE_SSH', readingId, evidenceId, observedAt, ...(precision ? { timePrecision: precision } : {}), freshness: null };
}
function notRead<T>(hint?: { value: T; observedAt: string | null; stale?: boolean; evidenceId?: string | null; readingId?: string }): VsiObserved<T> {
  return {
    value: null,
    basis: 'NOT_READ',
    readingId: hint?.readingId ?? null,
    evidenceId: null,
    observedAt: null,
    freshness: null,
    ...(hint
      ? { inventoryHint: { value: hint.value, observedAt: hint.observedAt, stale: hint.stale ?? false, evidenceId: hint.evidenceId ?? null } }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* VSI 3066-BGP-FLASHTELECOM                                            */
/* ------------------------------------------------------------------ */

const S6750 = 'BHE-VTA-S6750-MPLS-01';
const FLOR = 'RNS-FLOR-6730-MPLS-01';
const T1 = '2026-11-09T14:46:00.000Z';
const T2 = '2026-11-09T21:16:00.000Z';

export const vsi3066Input: VsiServiceComposeInput = {
  engine: 'VSI_MCP',
  engineVersion: 'fixture',
  runId: 'fixture-vsi-3066',
  origin: 'FIXTURE',
  vsiName: '3066-BGP-FLASHTELECOM',
  operator: null,
  startedAt: ASSEMBLED_AT,
  completedAt: ASSEMBLED_AT,
  demonstration: {
    label: 'Fixture de desenvolvimento',
    provenance:
      'Capturas reais de 09/11/2026 no BHE-VTA-S6750 (duas leituras, 14:46Z e 21:16Z). Nenhuma leitura foi feita em 16/11. A ponta remota nunca foi lida.',
  },
  readings: [
    { id: 'r3066-1', kind: 'SSH_SESSION', hostId: 'demo-s6750', hostName: S6750, startedAt: T1, inThisRun: false, outcome: 'OK', scope: 'VSI, AC e PW' },
    { id: 'r3066-2', kind: 'SSH_SESSION', hostId: 'demo-s6750', hostName: S6750, startedAt: T2, inThisRun: false, outcome: 'OK', scope: 'tabela MAC, VLAN 3066 e configuração de interfaces' },
  ],
  evidence: [
    ev('e-vsi3066', 'r3066-1', S6750, 'display vsi name 3066-BGP-FLASHTELECOM verbose', T1, C.vsi3066, {
      used: ['VSI State', 'PW State', '    State   ', 'Peer Ip Address'],
      note: 'Trecho resumido da captura real: campos sem uso na tela foram omitidos.',
    }),
    ev('e-mac3066', 'r3066-2', S6750, 'display mac-address vsi 3066-BGP-FLASHTELECOM', T2, C.mac3066, {
      used: ['Eth-Trunk1 ', 'Eth-Trunk6'],
      note: 'MACs sanitizados: OUI preservado, 16 bits finais trocados.',
    }),
    ev('e-vlan3066', 'r3066-2', S6750, 'display vlan 3066', T2, C.vlan3066, { used: ['TG:Eth-Trunk1'] }),
    ev('e-trunk6', 'r3066-2', S6750, 'display current-configuration interface Eth-Trunk6', T2, C.trunk6, { used: ['allow-pass vlan 1602'] }),
    ev('e-vif3064', 'r3066-2', S6750, 'display current-configuration interface Vlanif3064', T2, C.vif3064, { used: ['l2 binding'] }),
  ],
  endpoints: [
    {
      hostId: 'demo-s6750',
      hostName: S6750,
      platform: 'S6750-H36C · YunShan V600R024C00SPC500',
      loopback: null,
      discoveredBy: 'REQUESTED',
      collection: 'READ',
      accessRole: null,
      vsi: live({ state: 'UP', signaling: 'bgp', encapsulation: 'vlan', mtu: 1500, rd: '268568:3066' }, 'r3066-1', 'e-vsi3066', T1),
      acs: [
        {
          interfaceName: 'Vlanif3066',
          state: live('UP', 'r3066-1', 'e-vsi3066', T1),
          blocked: false,
          role: null,
          carrier: 'Eth-Trunk1',
          vlan: '3066 tagged',
          detail: 'VLAN 3066 no Eth-Trunk1 pelo display vlan 3066; estado LACP do trunk não lido',
        },
      ],
      pws: [
        {
          peerAddress: '10.100.101.6',
          peerHostId: 'demo-flor',
          state: live('UP', 'r3066-1', 'e-vsi3066', T1),
          localLabel: 1016797,
          remoteLabel: 36464,
          tunnel: 'ldp',
          stale: false,
          detail: 'up desde 08/11 05:59 · control-word desabilitado · MAC flapping 0',
        },
      ],
      ethTrunks: [],
      eTrunks: [],
      mac: live({ total: 2, viaAc: 1, viaPw: 0, viaUnresolved: 1, byLearnedFrom: { 'Eth-Trunk1': 1, 'Eth-Trunk6': 1 } }, 'r3066-2', 'e-mac3066', T2),
      missingEvidence: [
        'leitura de hoje',
        'configuração de proteção (E-Trunk): a ausência não está comprovada',
        'interface de saída do LSP até 10.100.101.6',
        'tempo de aging da tabela MAC',
      ],
    },
    {
      hostId: 'demo-flor',
      hostName: FLOR,
      platform: null,
      loopback: '10.100.101.6',
      discoveredBy: 'PW_PEER',
      collection: 'NOT_READ',
      accessRole: null,
      vsi: notRead(),
      acs: [],
      pws: [
        {
          peerAddress: '',
          peerHostId: 'demo-s6750',
          state: notRead(),
          localLabel: 36464,
          remoteLabel: 1016797,
          tunnel: null,
          stale: false,
          detail: 'labels do inventário SNMP conferem com o outro lado; estado não lido',
        },
      ],
      ethTrunks: [],
      eTrunks: [],
      mac: notRead(),
      missingEvidence: ['toda a leitura ao vivo desta ponta, inclusive o tagging do AC'],
    },
  ],
  links: [{ aHostId: 'demo-s6750', bHostId: 'demo-flor', bAddress: '10.100.101.6', state: 'UP_ONE_SIDE', labelsMatch: true, findingIds: [] }],
  findings: [
    {
      id: 'f3066-mac',
      code: 'MAC_ORIGIN_UNRESOLVED',
      severity: 'INFO',
      certainty: 'CONFIRMED',
      impactCertainty: 'HYPOTHESIS',
      origin: 'MANUAL_ANALYSIS',
      hostId: 'demo-s6750',
      hostName: S6750,
      component: 'MAC',
      title: 'MAC da VSI exibido no Eth-Trunk6, que não carrega a VLAN 3066',
      explanation:
        'A tabela MAC da VSI lista um MAC dinâmico aprendido em Eth-Trunk6. O Eth-Trunk6 só permite a VLAN 1602 e não consta em display vlan 3066. Se for a interface de saída do túnel do PW, é o MAC remoto; se não for, há tráfego da VSI entrando por um trunk que não deveria carregá-la. A leitura não distingue os dois casos.',
      caveat: 'Hipótese mais consistente: MAC remoto do PW exibido com a interface física de saída do túnel. Não comprovado.',
      evidenceIds: ['e-mac3066', 'e-vlan3066', 'e-trunk6'],
      nextStepIds: ['s3066-lsp', 's3066-aging'],
    },
    {
      id: 'f3066-ac-obsolete',
      code: 'PERSISTED_AC_NOT_IN_LIVE_VSI',
      severity: 'INFO',
      certainty: 'CONFIRMED',
      impactCertainty: 'CONFIRMED',
      origin: 'MANUAL_ANALYSIS',
      hostId: 'demo-s6750',
      hostName: S6750,
      component: 'INVENTORY',
      title: 'Vlanif3064 consta no inventário como AC desta VSI, mas pertence a outra',
      explanation:
        'O equipamento lista só Vlanif3066 como AC. A configuração de Vlanif3064 faz l2 binding para a VSI 3064-PONTUALNET-IP-BHE-MQT. Não afeta o circuito; afeta quem consulta o inventário.',
      caveat: 'A coleta SNMP não remove ACs antigos.',
      evidenceIds: ['e-vif3064', 'e-vsi3066'],
      nextStepIds: [],
    },
  ],
  nextSteps: [
    {
      id: 's3066-recollect',
      hostId: 'demo-s6750',
      hostName: S6750,
      title: 'Fazer nova coleta antes de afirmar o estado atual',
      command: 'display vsi name 3066-BGP-FLASHTELECOM verbose',
      homologated: true,
      reason: 'A última leitura direta é de 09/11.',
      reasonFindingIds: [],
      evidenceIds: ['e-vsi3066'],
    },
    {
      id: 's3066-lsp',
      hostId: 'demo-s6750',
      hostName: S6750,
      title: 'Ler a interface de saída do LSP até o peer do PW',
      command: 'display mpls lsp include 10.100.101.6 32 verbose',
      homologated: false,
      reason: 'Se sair por Eth-Trunk6, o MAC indeterminado é o MAC remoto do PW.',
      reasonFindingIds: ['f3066-mac'],
      evidenceIds: ['e-mac3066'],
    },
    {
      id: 's3066-aging',
      hostId: 'demo-s6750',
      hostName: S6750,
      title: 'Ler o tempo de aging da tabela MAC',
      command: 'display mac-address aging-time',
      homologated: false,
      reason: 'Exclui ou confirma a hipótese de entrada residual.',
      reasonFindingIds: ['f3066-mac'],
      evidenceIds: ['e-mac3066'],
    },
    {
      id: 's3066-remote',
      hostId: 'demo-flor',
      hostName: FLOR,
      title: 'Ler a mesma VSI na ponta remota e comparar as duas pontas',
      command: null,
      homologated: null,
      reason: 'A ponta remota nunca foi lida ao vivo.',
      reasonFindingIds: ['agg-not-read-demo-flor'],
      evidenceIds: ['e-vsi3066'],
    },
  ],
};

/* ------------------------------------------------------------------ */
/* VSI 3072-QinQ-CDB-MANTIQUEIRA                                        */
/* ------------------------------------------------------------------ */

const LIKEE = 'BHE-LIKEE-6730-MPLS-01';
const VTA = 'BHE-VTA-6730-MPLS-01';
const MQT = 'BHE-MQT-6730-MPLS-01';
const DAY = '2026-11-16T00:00:00.000Z';
const INV_LIKEE = '2026-11-16T13:50:19.000Z';
const INV_VTA = '2026-11-16T13:51:10.000Z';
const INV_MQT = '2026-11-16T13:52:00.000Z';
const PW_OLD = '2026-10-27T01:24:40.000Z';
const manual = { precision: 'DAY' as const };

export const vsi3072Input: VsiServiceComposeInput = {
  engine: 'VSI_MCP',
  engineVersion: 'fixture',
  runId: 'fixture-vsi-3072',
  origin: 'FIXTURE',
  vsiName: '3072-QinQ-CDB-MANTIQUEIRA',
  operator: null,
  startedAt: ASSEMBLED_AT,
  completedAt: ASSEMBLED_AT,
  demonstration: {
    label: 'Fixture de desenvolvimento',
    provenance:
      'E-Trunk, LACP e configuração dos trunks: capturas manuais do operador em 16/11/2026 (horário não informado), fora do fluxo MCP. VSI, AC e PW: só inventário SNMP. A VSI 3072 ainda não foi lida por nenhum equipamento.',
  },
  readings: [
    { id: 'r3072-likee', kind: 'MANUAL_SSH_CAPTURE', hostId: 'demo-likee', hostName: LIKEE, startedAt: DAY, timePrecision: 'DAY', inThisRun: false, outcome: 'OK', scope: 'E-Trunk (resumo), Eth-Trunk17 e sua configuração' },
    { id: 'r3072-vta', kind: 'MANUAL_SSH_CAPTURE', hostId: 'demo-vta', hostName: VTA, startedAt: DAY, timePrecision: 'DAY', inThisRun: false, outcome: 'PARTIAL', scope: 'E-Trunk 4, Eth-Trunk26; configuração do Eth-Trunk26 veio truncada' },
    { id: 'r3072-inv-likee', kind: 'SNMP_CYCLE', hostId: 'demo-likee', hostName: LIKEE, startedAt: INV_LIKEE, inThisRun: false, outcome: 'OK', scope: 'inventário: VSI, AC, PW' },
    { id: 'r3072-inv-vta', kind: 'SNMP_CYCLE', hostId: 'demo-vta', hostName: VTA, startedAt: INV_VTA, inThisRun: false, outcome: 'OK', scope: 'inventário: VSI, AC, PW' },
    { id: 'r3072-inv-mqt', kind: 'SNMP_CYCLE', hostId: 'demo-mqt', hostName: MQT, startedAt: INV_MQT, inThisRun: false, outcome: 'OK', scope: 'inventário: VSI, AC, PW' },
  ],
  evidence: [
    ev('e-et4', 'r3072-vta', VTA, 'display e-trunk 4', DAY, C.et4, { ...manual, used: ['State : Backup', 'Eth-Trunk 26'], note: 'Contadores de pacotes omitidos; System-ID sanitizados.' }),
    ev('e-lag26', 'r3072-vta', VTA, 'display eth-trunk 26', DAY, C.lag26, { ...manual, used: ['Operate status', 'Unselect'] }),
    ev('e-brief-vta', 'r3072-vta', VTA, 'display e-trunk brief', DAY, C.briefVta, { ...manual, used: ['4             Backup'] }),
    ev('e-cfg26', 'r3072-vta', VTA, 'display current-configuration interface Eth-Trunk26', DAY, C.cfg26, {
      ...manual,
      complete: false,
      note: 'Captura incompleta: sem o fim do bloco e sem o prompt. Descartada pelo diagnóstico.',
    }),
    ev('e-lag17', 'r3072-likee', LIKEE, 'display eth-trunk 17', DAY, C.lag17, { ...manual, used: ['Operate status', 'Selected'] }),
    ev('e-brief-likee', 'r3072-likee', LIKEE, 'display e-trunk brief', DAY, C.briefLikee, { ...manual, used: ['4             Master'] }),
    ev('e-cfg17', 'r3072-likee', LIKEE, 'display current-configuration interface Eth-Trunk17', DAY, C.cfg17, { ...manual, used: ['e-trunk 4', 'mode lacp'] }),
    ev('e-snmp-likee', 'r3072-inv-likee', LIKEE, null, INV_LIKEE, C.snmpLikee, { used: ['operationalStatus'], note: 'Registro do banco do NetVision. Não é saída de equipamento.' }),
    ev('e-snmp-vta', 'r3072-inv-vta', VTA, null, INV_VTA, C.snmpVta, { used: ['operationalStatus', '2026-10-27', 'operStatus UP'], note: 'Registro do banco do NetVision. Não é saída de equipamento.' }),
  ],
  endpoints: [
    {
      hostId: 'demo-likee',
      hostName: LIKEE,
      platform: 'S6730',
      loopback: '10.100.101.3',
      discoveredBy: 'REQUESTED',
      collection: 'PARTIAL',
      accessRole: 'ACTIVE',
      vsi: notRead({ value: { state: 'UP', signaling: null, encapsulation: null, mtu: 2000, rd: '268568:53072' }, observedAt: INV_LIKEE, evidenceId: 'e-snmp-likee', readingId: 'r3072-inv-likee' }),
      acs: [{ interfaceName: 'Eth-Trunk17.3072', state: notRead({ value: 'UP', observedAt: INV_LIKEE, evidenceId: 'e-snmp-likee', readingId: 'r3072-inv-likee' }), blocked: null, role: null, carrier: 'Eth-Trunk17', vlan: null }],
      pws: [
        {
          peerAddress: '10.100.101.2',
          peerHostId: 'demo-mqt',
          state: notRead({ value: 'UP', observedAt: INV_LIKEE, evidenceId: 'e-snmp-likee', readingId: 'r3072-inv-likee' }),
          localLabel: 36706,
          remoteLabel: 35842,
          tunnel: null,
          stale: false,
        },
      ],
      ethTrunks: [
        {
          name: 'Eth-Trunk17',
          operStatus: live('UP', 'r3072-likee', 'e-lag17', DAY, 'DAY'),
          workingMode: 'LACP',
          selected: 1,
          members: [{ port: 'XGigabitEthernet0/0/3', status: 'SELECTED' }],
          eTrunkId: 4,
          remoteEthTrunkId: 26,
          role: 'ACTIVE',
          detail: 'mode lacp · e-trunk 4 remote-eth-trunk 26',
        },
      ],
      eTrunks: [
        {
          id: 4,
          state: live('MASTER', 'r3072-likee', 'e-brief-likee', DAY, 'DAY'),
          causation: null,
          priority: null,
          peerPriority: null,
          peerIp: '10.100.101.0',
          members: [],
          detail: 'lido pelo resumo (brief); a linha do membro Eth-Trunk17 não foi lida',
        },
      ],
      mac: notRead(),
      missingEvidence: ['display vsi da 3072', 'configuração de Eth-Trunk17.3072', 'display e-trunk 4 (linha do membro)', 'tabela MAC da VSI'],
    },
    {
      hostId: 'demo-vta',
      hostName: VTA,
      platform: 'S6730-H48X6C',
      loopback: '10.100.101.0',
      discoveredBy: 'INVENTORY_SAME_VSI',
      collection: 'PARTIAL',
      accessRole: 'STANDBY_EXPECTED',
      vsi: notRead({ value: { state: 'DOWN', signaling: null, encapsulation: null, mtu: 2000, rd: '268568:53072' }, observedAt: INV_VTA, evidenceId: 'e-snmp-vta', readingId: 'r3072-inv-vta' }),
      acs: [{ interfaceName: 'Eth-Trunk26.3072', state: notRead({ value: 'DOWN', observedAt: INV_VTA, evidenceId: 'e-snmp-vta', readingId: 'r3072-inv-vta' }), blocked: null, role: null, carrier: 'Eth-Trunk26', vlan: null }],
      pws: [
        {
          peerAddress: '10.100.101.2',
          peerHostId: 'demo-mqt',
          state: notRead({ value: 'UP', observedAt: PW_OLD, stale: true, evidenceId: 'e-snmp-vta', readingId: 'r3072-inv-vta' }),
          localLabel: 41335,
          remoteLabel: 35840,
          tunnel: null,
          stale: true,
          detail: 'registro 20 dias mais antigo que a leitura da própria VSI',
        },
      ],
      ethTrunks: [
        {
          name: 'Eth-Trunk26',
          operStatus: live('DOWN', 'r3072-vta', 'e-lag26', DAY, 'DAY'),
          workingMode: 'LACP',
          selected: 0,
          members: [{ port: 'XGigabitEthernet0/0/48', status: 'UNSELECTED' }],
          eTrunkId: 4,
          remoteEthTrunkId: 17,
          role: 'STANDBY_EXPECTED',
          memberCausation: 'PEER_MEMBER_UP',
          detail: 'o E-Trunk 4 tem outro membro, Eth-Trunk13 (remoto 21), de outro serviço',
        },
      ],
      eTrunks: [
        {
          id: 4,
          state: live('BACKUP', 'r3072-vta', 'e-et4', DAY, 'DAY'),
          causation: 'PRI',
          priority: 30,
          peerPriority: 20,
          peerIp: '10.100.101.3',
          members: [
            { interfaceName: 'Eth-Trunk13', state: 'Backup', causation: 'PEER_MEMBER_UP', remoteId: 21 },
            { interfaceName: 'Eth-Trunk26', state: 'Backup', causation: 'PEER_MEMBER_UP', remoteId: 17 },
          ],
          detail: 'BFD likee · revert-delay 120 s · brief e comando completo concordam',
        },
      ],
      mac: notRead(),
      missingEvidence: ['display vsi da 3072', 'configuração de Eth-Trunk26.3072', 'configuração completa do Eth-Trunk26'],
    },
    {
      hostId: 'demo-mqt',
      hostName: MQT,
      platform: null,
      loopback: '10.100.101.2',
      discoveredBy: 'PW_PEER',
      collection: 'NOT_READ',
      accessRole: null,
      vsi: notRead({ value: { state: 'UP', signaling: null, encapsulation: null, mtu: null, rd: null }, observedAt: INV_MQT, readingId: 'r3072-inv-mqt' }),
      acs: [{ interfaceName: 'XGigabitEthernet0/0/4.3072', state: notRead({ value: 'UP', observedAt: INV_MQT, readingId: 'r3072-inv-mqt' }), blocked: null, role: null, carrier: null, vlan: null }],
      pws: [
        {
          peerAddress: '10.100.101.3',
          peerHostId: 'demo-likee',
          state: notRead({ value: 'UP', observedAt: INV_MQT, readingId: 'r3072-inv-mqt' }),
          localLabel: 35842,
          remoteLabel: 36706,
          tunnel: null,
          stale: false,
          detail: 'labels do inventário conferem com o LIKEE',
        },
      ],
      ethTrunks: [],
      eTrunks: [],
      mac: notRead(),
      missingEvidence: ['toda a leitura ao vivo desta ponta'],
    },
  ],
  links: [
    { aHostId: 'demo-likee', bHostId: 'demo-mqt', bAddress: '10.100.101.2', state: 'NOT_CONFIRMED', labelsMatch: true, findingIds: [] },
    { aHostId: 'demo-vta', bHostId: 'demo-mqt', bAddress: '10.100.101.2', state: 'STALE', labelsMatch: null, findingIds: ['f3072-pw-stale'] },
  ],
  findings: [
    {
      id: 'f3072-cfg26',
      code: 'COLLECTION_OUTPUT_INCOMPLETE',
      severity: 'INFO',
      certainty: 'CONFIRMED',
      impactCertainty: 'CONFIRMED',
      origin: 'MANUAL_ANALYSIS',
      hostId: 'demo-vta',
      hostName: VTA,
      component: 'COLLECTION',
      title: 'A captura da configuração do Eth-Trunk26 veio incompleta',
      explanation:
        'A saída terminou sem o fim do bloco e sem o prompt e foi descartada em vez de usada pela metade. O vínculo do trunk com o E-Trunk 4 foi obtido por outra fonte, a tabela de membros.',
      caveat: 'Problema do procedimento de coleta. Não diz nada sobre o serviço.',
      evidenceIds: ['e-cfg26', 'e-et4'],
      nextStepIds: ['s3072-cfg26'],
    },
    {
      id: 'f3072-pw-stale',
      code: 'PERSISTED_PW_STALE',
      severity: 'INFO',
      certainty: 'CONFIRMED',
      impactCertainty: 'CONFIRMED',
      origin: 'MANUAL_ANALYSIS',
      hostId: 'demo-vta',
      hostName: VTA,
      component: 'INVENTORY',
      title: 'PW para 10.100.101.2 gravado como UP, visto pela última vez em 27/10',
      explanation:
        'O inventário mostra o PW up, mas a última leitura dele é 20 dias anterior à leitura da própria VSI. O registro não representa o estado atual.',
      caveat: 'A coleta SNMP não remove PWs que deixaram de existir. Não tratar este PW como up.',
      evidenceIds: ['e-snmp-vta'],
      nextStepIds: [],
    },
    {
      id: 'f3072-if-diverge',
      code: 'INVENTORY_STATE_DIVERGES_FROM_DEVICE',
      severity: 'INFO',
      certainty: 'CONFIRMED',
      impactCertainty: 'INCONCLUSIVE',
      origin: 'MANUAL_ANALYSIS',
      hostId: 'demo-vta',
      hostName: VTA,
      component: 'INVENTORY',
      title: 'O inventário mostra o Eth-Trunk26 UP/UP; o equipamento diz Operate status down',
      explanation:
        'O ifOperStatus do SNMP está UP enquanto display eth-trunk 26 mostra o trunk fora de operação, com 0 membros em uso. O estado da interface no inventário não serve para decidir se um caminho encaminha.',
      caveat: 'Causa da divergência não investigada.',
      evidenceIds: ['e-lag26', 'e-snmp-vta'],
      nextStepIds: [],
    },
    {
      id: 'f3072-standby',
      code: 'STANDBY_PATH_IDLE',
      severity: 'INFO',
      certainty: 'CONFIRMED',
      impactCertainty: 'CONFIRMED',
      origin: 'MANUAL_ANALYSIS',
      hostId: 'demo-vta',
      hostName: VTA,
      component: 'E_TRUNK',
      title: 'Eth-Trunk26 fora de operação por estar em Backup',
      explanation:
        'Membro do E-Trunk 4 em Backup com causa PEER_MEMBER_UP e LACP sem membro em uso (XGigabitEthernet0/0/48 Unselect). É o comportamento esperado do lado reserva: não se espera tráfego nem MAC por este caminho.',
      caveat: 'Refazer o diagnóstico após um failover.',
      evidenceIds: ['e-et4', 'e-lag26', 'e-brief-vta'],
      nextStepIds: [],
    },
  ],
  nextSteps: [
    {
      id: 's3072-vsi-likee',
      hostId: 'demo-likee',
      hostName: LIKEE,
      title: 'Ler a VSI 3072 no lado Master',
      command: 'display vsi name 3072-QinQ-CDB-MANTIQUEIRA verbose',
      homologated: true,
      reason: 'O estado da VSI, do AC e do PW vem só do inventário.',
      reasonFindingIds: ['agg-not-read-demo-likee'],
      evidenceIds: ['e-snmp-likee'],
    },
    {
      id: 's3072-vsi-vta',
      hostId: 'demo-vta',
      hostName: VTA,
      title: 'Ler a VSI 3072 no lado Backup',
      command: 'display vsi name 3072-QinQ-CDB-MANTIQUEIRA verbose',
      homologated: true,
      reason: 'Confirma se o AC down corresponde ao Backup do E-Trunk 4.',
      reasonFindingIds: ['agg-not-read-demo-vta'],
      evidenceIds: ['e-et4', 'e-snmp-vta'],
    },
    {
      id: 's3072-cfg26',
      hostId: 'demo-vta',
      hostName: VTA,
      title: 'Repetir a leitura da configuração do Eth-Trunk26',
      command: 'display current-configuration interface Eth-Trunk26',
      homologated: true,
      reason: 'A captura veio truncada.',
      reasonFindingIds: ['f3072-cfg26'],
      evidenceIds: ['e-cfg26'],
    },
    {
      id: 's3072-et4-likee',
      hostId: 'demo-likee',
      hostName: LIKEE,
      title: 'Ler a linha do membro no lado Master',
      command: 'display e-trunk 4',
      homologated: true,
      reason: 'No LIKEE só o resumo foi lido; falta o estado e a causa do membro Eth-Trunk17.',
      reasonFindingIds: [],
      evidenceIds: ['e-brief-likee'],
    },
  ],
};

export const vsi3066Fixture: VsiServiceDiagnosis = composeVsiServiceDiagnosis(vsi3066Input);
export const vsi3072Fixture: VsiServiceDiagnosis = composeVsiServiceDiagnosis(vsi3072Input);
