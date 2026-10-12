import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  MitigationPolicyReconciler,
  PolicyReconcileStaleError,
  normalizeReadBackForToken,
} from './mitigation-policy-reconciler';

// HOTFIX DO previewId VOLATIL (sessao SSH x configuracao real).
//
// O read-back REAL do VRP traz um envelope de sessao volatil:
//   Info: The max number of VTY users is 21, ... online is 1 ...
//         The current login time is <timestamp>
//   ...
//   Info: The max number of VTY users is 21, and ... on line is 0.
// O login time muda a cada sessao SSH: sem normalizacao, o token mudava a cada
// leitura (APPLY sempre 409). Aqui provamos que:
//  - envelope de sessao (banners/login, CRLF) NAO muda o token;
//  - QUALQUER alteracao real da configuracao muda o token (nunca NORMAL falso);
//  - leitura inconclusiva/erro de CLI bloqueia o APPLY com zero escrita local.

const DEVICE_A = 'host-f1a';
const POLICY = 'PL-FLASH-TELECOM_IPv4-IN';
const RT = '268568:660';
const NOW = new Date('2026-10-12T20:30:00.000Z');

function device(): HostRecord {
  return {
    id: DEVICE_A,
    hostname: DEVICE_A,
    displayName: DEVICE_A,
    name: DEVICE_A,
    sshEnabled: true,
    ssh: { host: '10.0.0.1', port: 22, username: 'netvision' },
  } as unknown as HostRecord;
}

interface EnvelopeOptions {
  loginTime?: string;
  vtyOnline?: number;
  vtyTail?: number;
  eol?: '\n' | '\r\n';
  /** Linhas da policy (substitui o bloco padrao quando presente). */
  policyLines?: string[];
  /** Linha extra desconhecida injetada na configuracao. */
  unknownLine?: string;
  /** Leitura truncada: so o cabecalho da policy, sem nodes. */
  truncated?: boolean;
}

/** Read-back FIEL ao equipamento real (fixture sanitizada do FAST IPv4). */
function readBack(options: EnvelopeOptions = {}): string {
  const loginTime = options.loginTime ?? '17:27:32';
  const vtyOnline = options.vtyOnline ?? 1;
  const vtyTail = options.vtyTail ?? 0;
  const eol = options.eol ?? '\n';
  const defaultPolicy = [
    `Route-policy: ${POLICY}`,
    '  permit : 10 (matched counts: 1)',
    '    Match clauses: ',
    '      if-match ip-prefix PREFIX-FLASHTELECOM-IPV4',
    '    Apply clauses: ',
    '      apply local-preference 3000',
    '      apply extcommunity rt 268568:140',
    '  deny : 999 (matched counts: 0)',
  ];
  const policy = options.truncated
    ? [`Route-policy: ${POLICY}`]
    : (options.policyLines ?? defaultPolicy);
  const withUnknown = options.unknownLine
    ? [...policy, options.unknownLine]
    : policy;
  return [
    '',
    `Info: The max number of VTY users is 21, the number of current VTY users online is ${vtyOnline}, and total number of terminal users online is ${vtyOnline}.`,
    `      The current login time is 2026-10-12 ${loginTime}-03:00.`,
    `<BHE-VTA-F1A-BGP-01>screen-length 0 temporary`,
    'Info: The configuration takes effect on the current user terminal interface only.',
    '<BHE-VTA-F1A-BGP-01>',
    `<BHE-VTA-F1A-BGP-01>display route-policy ${POLICY}`,
    ...withUnknown,
    '<BHE-VTA-F1A-BGP-01>',
    '<BHE-VTA-F1A-BGP-01>quit',
    `Info: The max number of VTY users is 21, and the number of current VTY users on line is ${vtyTail}.`,
  ].join(eol);
}

const MITIGATION_PAIR_LINES = [
  `Route-policy: ${POLICY}`,
  '  permit : 10 (matched counts: 1)',
  '    Match clauses: ',
  '      if-match ip-prefix PREFIX-FLASHTELECOM-IPV4',
  '  deny : 1 (matched counts: 0)',
  '    Match clauses: ',
  '      if-match ip-prefix BOGONS',
  '  permit : 2 (matched counts: 0)',
  '    Match clauses: ',
  '      if-match ip-prefix PREFIX8to24',
  '    Apply clauses: ',
  `      apply extcommunity rt ${RT} additive`,
  '  deny : 999 (matched counts: 0)',
];

async function harness() {
  const repository = new InMemoryMitigationRepository();
  const profileIds: string[] = [];
  const states: Array<{ state: string; pair: { bogonNode: number; mitigationNode: number } }> = [
    { state: 'MITIGATED', pair: { bogonNode: 1, mitigationNode: 2 } },
    { state: 'NORMAL', pair: { bogonNode: 1, mitigationNode: 2 } },
  ];
  for (let index = 0; index < 2; index += 1) {
    const profile = await repository.upsertProfile({
      deviceId: DEVICE_A,
      policyName: POLICY,
      interfaceId: `if-${index + 1}`,
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(profile.id, [
      { peerId: `peer-${index}`, peerAddress: `10.200.201.${20 + index}`, primary: true },
    ]);
    await repository.upsertRuntime(profile.id, {
      state: states[index]!.state as 'NORMAL',
      plannedBogonNode: states[index]!.pair.bogonNode,
      plannedMitigationNode: states[index]!.pair.mitigationNode,
      plannedNode: states[index]!.pair.mitigationNode,
    });
    profileIds.push(profile.id);
  }
  const source = { read: readBack(), error: null as Error | null, reads: 0 };
  let creates = 0;
  const originalCreateEvent = repository.createEvent.bind(repository);
  repository.createEvent = async (input) => {
    creates += 1;
    return originalCreateEvent(input);
  };
  const reconciler = new MitigationPolicyReconciler({
    repository,
    hosts: { getHost: async () => device() },
    readPolicy: async () => {
      source.reads += 1;
      if (source.error) throw source.error;
      return source.read;
    },
    now: () => NOW,
  });
  return {
    repository,
    reconciler,
    scope: { deviceId: DEVICE_A, policyName: POLICY },
    profileIds,
    source,
    eventCreates: () => creates,
  };
}

const stateOf = async (h: Awaited<ReturnType<typeof harness>>, profileId: string) =>
  (await h.repository.getRuntime(profileId))?.state ?? null;

describe('hotfix do previewId volatil', () => {
  it('1) mesmo conteudo fisico com horarios de login diferentes => MESMO previewId', async () => {
    const h = await harness();
    h.source.read = readBack({ loginTime: '17:27:32' });
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({ loginTime: '18:59:01' });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).toBe(first.previewId);
  });

  it('2) sessoes SSH diferentes (VTY online/tail variando) => MESMO previewId', async () => {
    const h = await harness();
    h.source.read = readBack({ vtyOnline: 1, vtyTail: 0 });
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({ vtyOnline: 3, vtyTail: 2 });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).toBe(first.previewId);
  });

  it('3) CRLF x LF => MESMO previewId (normalizacao de transporte explicita)', async () => {
    const h = await harness();
    h.source.read = readBack({ eol: '\n' });
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({ eol: '\r\n' });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).toBe(first.previewId);
  });

  it('16) PREVIEW com login A -> APPLY com login B (mesma policy) => APPLY LOCAL efetivo', async () => {
    const h = await harness();
    h.source.read = readBack({ loginTime: '17:27:32' });
    const preview = await h.reconciler.preview(h.scope);
    expect(preview.state).toBe('NORMAL');

    h.source.read = readBack({ loginTime: '18:00:00' });
    const applied = await h.reconciler.applyLocal(h.scope, preview.previewId);

    expect(applied.state).toBe('NORMAL');
    expect(applied.applied).toBe(2);
    expect(applied.failed).toBe(0);
    expect(await stateOf(h, h.profileIds[0]!)).toBe('NORMAL');
    expect(await stateOf(h, h.profileIds[1]!)).toBe('NORMAL');
  });

  it('complementar) PREVIEW login A -> mudanca FISICA real -> APPLY login B => 409 e zero escrita', async () => {
    const h = await harness();
    h.source.read = readBack({ loginTime: '17:27:32' });
    const preview = await h.reconciler.preview(h.scope);

    // Alteracao REAL: novo par de mitigacao na policy.
    h.source.read = readBack({ loginTime: '18:00:00', policyLines: MITIGATION_PAIR_LINES });

    await expect(h.reconciler.applyLocal(h.scope, preview.previewId)).rejects.toBeInstanceOf(
      PolicyReconcileStaleError,
    );
    expect(await stateOf(h, h.profileIds[0]!)).toBe('MITIGATED');
    expect(await stateOf(h, h.profileIds[1]!)).toBe('NORMAL');
  });

  it('4) mudanca de numero de node => previewId diferente', async () => {
    const h = await harness();
    h.source.read = readBack();
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({
      policyLines: [
        `Route-policy: ${POLICY}`,
        '  permit : 11 (matched counts: 1)',
        '    Match clauses: ',
        '      if-match ip-prefix PREFIX-FLASHTELECOM-IPV4',
        '  deny : 999 (matched counts: 0)',
      ],
    });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).not.toBe(first.previewId);
  });

  it('5) deny -> permit => previewId diferente', async () => {
    const h = await harness();
    h.source.read = readBack();
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({
      policyLines: [
        `Route-policy: ${POLICY}`,
        '  permit : 10 (matched counts: 1)',
        '    Match clauses: ',
        '      if-match ip-prefix PREFIX-FLASHTELECOM-IPV4',
        '  permit : 999 (matched counts: 0)',
      ],
    });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).not.toBe(first.previewId);
  });

  it('6) mudanca de prefix-list => previewId diferente', async () => {
    const h = await harness();
    h.source.read = readBack();
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({
      policyLines: [
        `Route-policy: ${POLICY}`,
        '  permit : 10 (matched counts: 1)',
        '    Match clauses: ',
        '      if-match ip-prefix OUTRA-PREFIX-LIST',
        '  deny : 999 (matched counts: 0)',
      ],
    });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).not.toBe(first.previewId);
  });

  it('7) mudanca de RT => previewId diferente', async () => {
    const h = await harness();
    h.source.read = readBack();
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({
      policyLines: [
        `Route-policy: ${POLICY}`,
        '  permit : 10 (matched counts: 1)',
        '    Apply clauses: ',
        '      apply extcommunity rt 268568:141',
        '  deny : 999 (matched counts: 0)',
      ],
    });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).not.toBe(first.previewId);
  });

  it('8) inclusao de um par de mitigacao => previewId diferente (e classificacao MITIGATED)', async () => {
    const h = await harness();
    h.source.read = readBack();
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({ policyLines: MITIGATION_PAIR_LINES });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).not.toBe(first.previewId);
    expect(second.state).toBe('MITIGATED');
    expect(second.physical.pair).toEqual({ bogonNode: 1, mitigationNode: 2 });
  });

  it('9) remocao de um par existente => previewId diferente', async () => {
    const h = await harness();
    h.source.read = readBack({ policyLines: MITIGATION_PAIR_LINES });
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack();
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).not.toBe(first.previewId);
    expect(second.state).toBe('NORMAL');
  });

  it('10) linha DESCONHECIDA na configuracao => previewId diferente (nao e ignorada)', async () => {
    const h = await harness();
    h.source.read = readBack();
    const first = await h.reconciler.preview(h.scope);
    h.source.read = readBack({ unknownLine: '      apply community 64500:99 additive' });
    const second = await h.reconciler.preview(h.scope);

    expect(second.previewId).not.toBe(first.previewId);
  });

  it('11) runtime alterado entre PREVIEW e APPLY => 409 e zero escrita', async () => {
    const h = await harness();
    h.source.read = readBack();
    const preview = await h.reconciler.preview(h.scope);

    await h.repository.upsertRuntime(h.profileIds[1]!, { state: 'RECONCILIATION_REQUIRED' });

    await expect(h.reconciler.applyLocal(h.scope, preview.previewId)).rejects.toBeInstanceOf(
      PolicyReconcileStaleError,
    );
    expect(await stateOf(h, h.profileIds[0]!)).toBe('MITIGATED');
    expect(await stateOf(h, h.profileIds[1]!)).toBe('RECONCILIATION_REQUIRED');
  });

  it('12) target ADICIONAL no escopo => 409', async () => {
    const h = await harness();
    h.source.read = readBack();
    const preview = await h.reconciler.preview(h.scope);

    const extra = await h.repository.upsertProfile({
      deviceId: DEVICE_A,
      policyName: POLICY,
      interfaceId: 'if-3',
      addressFamily: 'IPV6',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    await h.repository.upsertRuntime(extra.id, { state: 'NORMAL' });

    await expect(h.reconciler.applyLocal(h.scope, preview.previewId)).rejects.toBeInstanceOf(
      PolicyReconcileStaleError,
    );
    expect(await stateOf(h, extra.id)).toBe('NORMAL');
  });

  it('13) read-back TRUNCADO (leitura inconclusiva) => APPLY bloqueado', async () => {
    const h = await harness();
    h.source.read = readBack({ truncated: true });
    const preview = await h.reconciler.preview(h.scope);
    expect(preview.state).toBe('RECONCILIATION_REQUIRED');

    await expect(h.reconciler.applyLocal(h.scope, preview.previewId)).rejects.toBeInstanceOf(
      PolicyReconcileStaleError,
    );
    expect(await stateOf(h, h.profileIds[0]!)).toBe('MITIGATED');
    expect(await stateOf(h, h.profileIds[1]!)).toBe('NORMAL');
  });

  it('14) erro de CLI (SSH) => APPLY bloqueado, zero escrita', async () => {
    const h = await harness();
    h.source.read = readBack();
    const preview = await h.reconciler.preview(h.scope);

    h.source.error = new Error('SSH command failed');
    await expect(h.reconciler.applyLocal(h.scope, preview.previewId)).rejects.toThrow(
      'SSH command failed',
    );
    expect(await stateOf(h, h.profileIds[0]!)).toBe('MITIGATED');
    expect(await stateOf(h, h.profileIds[1]!)).toBe('NORMAL');
  });

  it('15) par fisico diferente do PLANO => classificacao correta (MITIGATED com o par fisico)', async () => {
    const h = await harness();
    h.source.read = readBack({ policyLines: MITIGATION_PAIR_LINES });
    const preview = await h.reconciler.preview(h.scope);

    expect(preview.state).toBe('MITIGATED');
    expect(preview.physical.pair).toEqual({ bogonNode: 1, mitigationNode: 2 });
    expect(preview.targets[0]?.proposedPair).toEqual({ bogonNode: 1, mitigationNode: 2 });
    expect(preview.targets[1]?.proposedPair).toEqual({ bogonNode: 1, mitigationNode: 2 });
  });

  it('17) APPLY repetido: novo preview apos reconciliar e idempotente; previewId antigo vira 409', async () => {
    const h = await harness();
    h.source.read = readBack({ loginTime: '10:00:00' });
    const preview = await h.reconciler.preview(h.scope);
    const applied = await h.reconciler.applyLocal(h.scope, preview.previewId);
    expect(applied.applied).toBe(2);

    // Novo preview: nada a mudar; apply de novo e idempotente.
    h.source.read = readBack({ loginTime: '10:05:00' });
    const again = await h.reconciler.preview(h.scope);
    expect(again.targets.every((target) => target.change === false)).toBe(true);
    const secondApply = await h.reconciler.applyLocal(h.scope, again.previewId);
    expect(secondApply.applied).toBe(2);
    expect(await stateOf(h, h.profileIds[0]!)).toBe('NORMAL');

    // O previewId ANTIGO (pre-reconciliacao) nao vale mais.
    await expect(h.reconciler.applyLocal(h.scope, preview.previewId)).rejects.toBeInstanceOf(
      PolicyReconcileStaleError,
    );
  });

  it('18) nenhuma escrita Huawei/evento: so upsert de runtime do escopo', async () => {
    const h = await harness();
    h.source.read = readBack({ loginTime: '09:00:00' });
    const preview = await h.reconciler.preview(h.scope);
    h.source.read = readBack({ loginTime: '09:00:01' });
    await h.reconciler.applyLocal(h.scope, preview.previewId);

    // O reconciler nao tem caminho de escrita Huawei (auditado no codigo);
    // no fluxo inteiro nenhum evento de mitigacao e criado.
    expect(h.eventCreates()).toBe(0);
    expect(await stateOf(h, h.profileIds[0]!)).toBe('NORMAL');
    expect(await stateOf(h, h.profileIds[1]!)).toBe('NORMAL');
  });

  it('unidade) normalizeReadBackForToken remove SO o envelope de sessao', () => {
    const raw = readBack({ loginTime: '12:00:00' });
    const normalized = normalizeReadBackForToken(raw);

    expect(normalized).not.toContain('The current login time is');
    expect(normalized).not.toContain('The max number of VTY users is');
    // Configuracao permanece INTEGRAL (inclusive linha desconhecida).
    const withUnknown = readBack({ unknownLine: '      apply community 64500:99 additive' });
    const normalizedUnknown = normalizeReadBackForToken(withUnknown);
    expect(normalizedUnknown).toContain('apply community 64500:99 additive');
    expect(normalizedUnknown).toContain('if-match ip-prefix PREFIX-FLASHTELECOM-IPV4');
    expect(normalizedUnknown).toContain('apply extcommunity rt 268568:140');
    // Sem CR/LF residuais.
    expect(normalizeReadBackForToken('a\r\nb')).toBe('a\nb');
  });
});
