import type { ParsedInterfaceConfig } from './parsers';

/**
 * Redundancia de acesso (Eth-Trunk/LACP e E-Trunk) para o diagnostico VSI/VPLS.
 *
 * Contrato dos parsers: nunca lancam; saida paginada, de outro id ou em formato nao
 * reconhecido devolve `complete=false`. O papel de um caminho so e afirmado com a
 * evidencia do MECANISMO (E-Trunk lido) e do ESTADO (membro/LACP); contadores de
 * trafego e descricoes de interface nunca definem papel.
 */

const MORE = /----\s*More\s*----|--More--|\[y\/n\]|\(y\/n\)/i;
const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/\r/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

/** Campo `Chave : valor` em linhas com DUAS colunas (formato de `display e-trunk`). */
const pairField = (text: string, key: string): string | null => {
  const m = new RegExp('(?:^|\\s{2,}|^\\s*)' + key + '\\s*:\\s*(\\S+)', 'im').exec(text);
  const v = m?.[1]?.trim();
  return !v || v === '-' || v === '--' || v === '?' ? null : v;
};
const toInt = (v: string | null): number | null => (v !== null && /^\d+$/.test(v) ? Number(v) : null);

export type ETrunkState = 'MASTER' | 'BACKUP' | 'INITIALIZE' | null;
const eTrunkState = (v: string | null | undefined): ETrunkState => {
  const t = v?.toLowerCase();
  return t === 'master' ? 'MASTER' : t === 'backup' ? 'BACKUP' : t === 'initialize' || t === 'init' ? 'INITIALIZE' : null;
};

/* ------------------------------------------------------------------ */
/* display e-trunk <id>                                                */
/* ------------------------------------------------------------------ */

export interface ParsedETrunkMember {
  /** Sempre "Eth-Trunk<N>" quando o tipo do membro e Eth-Trunk. */
  interfaceName: string;
  trunkId: number;
  localPhyState: 'UP' | 'DOWN' | null;
  workMode: string | null;
  state: ETrunkState;
  /** Texto do equipamento (ex.: PEER_MEMBER_UP, PEER_MEMBER_DOWN, ETRUNK_MASTER, FORCE_BACKUP). */
  causation: string | null;
  remoteId: number | null;
}

export interface ParsedETrunk {
  complete: boolean;
  eTrunkId: number | null;
  state: ETrunkState;
  /** Causa do estado do E-Trunk (ex.: PRI, TIMEOUT, BFD_DOWN, PEER_TIMEOUT, INIT). */
  causation: string | null;
  priority: number | null;
  peerPriority: number | null;
  peerIp: string | null;
  sourceIp: string | null;
  revertDelaySeconds: number | null;
  bfdSession: string | null;
  members: ParsedETrunkMember[];
}

const emptyETrunk = (): ParsedETrunk => ({
  complete: false, eTrunkId: null, state: null, causation: null, priority: null, peerPriority: null,
  peerIp: null, sourceIp: null, revertDelaySeconds: null, bfdSession: null, members: [],
});

export function parseETrunk(raw: string, expectedId: number): ParsedETrunk {
  const text = clean(raw);
  if (MORE.test(text)) return emptyETrunk();
  const id = toInt(pairField(text, 'E-TRUNK-ID'));
  if (id === null || id !== expectedId) return emptyETrunk();
  const memberStart = text.search(/^[ \t]*The Member information/im);
  const head = memberStart >= 0 ? text.slice(0, memberStart) : text;
  const tail = memberStart >= 0 ? text.slice(memberStart) : '';
  // No cabecalho `Causation` aparece apos `State`; os membros tem a propria coluna.
  const state = eTrunkState(/(?:^|\s)State\s*:\s*(\S+)/im.exec(head)?.[1]);
  const members: ParsedETrunkMember[] = [];
  for (const line of tail.split('\n')) {
    // Type  ID  LocalPhyState  Work-Mode  State  Causation  Remote-ID (colunas lidas em relacao ao estado)
    const row = /^\s*Eth-Trunk\s+(\d+)\s+(.*)$/i.exec(line);
    if (!row) continue;
    const cols = row[2]!.trim().split(/\s+/);
    const at = cols.findIndex((c) => /^(Master|Backup|Initialize)$/i.test(c));
    if (at < 0) continue;
    const phy = cols.slice(0, at).find((c) => /^(Up|Down)$/i.test(c))?.toLowerCase();
    const causation = cols[at + 1];
    const remote = cols[at + 2];
    members.push({
      interfaceName: `Eth-Trunk${row[1]}`, trunkId: Number(row[1]),
      localPhyState: phy === 'up' ? 'UP' : phy === 'down' ? 'DOWN' : null,
      workMode: cols.slice(0, at).find((c) => /^(auto|force-master|force-backup)$/i.test(c)) ?? null,
      state: eTrunkState(cols[at]),
      causation: causation && /^[A-Z_]+$/i.test(causation) ? causation.toUpperCase() : null,
      remoteId: remote !== undefined && /^\d+$/.test(remote) ? Number(remote) : null,
    });
  }
  return {
    // Sem o estado do E-Trunk a saida nao serve para decidir papel.
    complete: state !== null,
    eTrunkId: id, state,
    causation: pairField(head, 'Causation')?.toUpperCase() ?? null,
    priority: toInt(/(?:^|\s)Priority\s*:\s*(\d+)/im.exec(head)?.[1] ?? null),
    peerPriority: toInt(pairField(head, 'Peer-Priority')),
    peerIp: pairField(head, 'Peer-IP'),
    sourceIp: pairField(head, 'Source-IP'),
    revertDelaySeconds: toInt(/Revert-Delay-Time\s*\(s\)\s*:\s*(\d+)/i.exec(head)?.[1] ?? null),
    bfdSession: pairField(head, 'BFD-Session'),
    members,
  };
}

/* ------------------------------------------------------------------ */
/* display e-trunk brief                                               */
/* ------------------------------------------------------------------ */

export interface ParsedETrunkBriefEntry {
  eTrunkId: number;
  state: ETrunkState;
  peerIp: string | null;
  sourceIp: string | null;
}
export interface ParsedETrunkBrief {
  complete: boolean;
  eTrunks: ParsedETrunkBriefEntry[];
  /** `Total:N` do rodape, quando presente. */
  declaredTotal: number | null;
}

/**
 * `display e-trunk brief`. Formato REAL (S6730 V200, BHE-VTA/BHE-LIKEE, 2026-11-16):
 *   E-TRUNK-ID    State        Peer-IP          Source-IP
 *   4             Backup       10.100.101.3     10.100.101.0
 *   Total:6       Master:4     Backup:2         Init:0
 * So e lida a saida do ULTIMO eco exato do comando (uma captura de sessao pode trazer tentativas
 * anteriores com erro). Total declarado diferente das linhas lidas = incompleto. Saida vazia aceita
 * pelo equipamento = nenhum E-Trunk.
 */
export function parseETrunkBrief(raw: string): ParsedETrunkBrief {
  const all = clean(raw);
  const bad: ParsedETrunkBrief = { complete: false, eTrunks: [], declaredTotal: null };
  const echoes = [...all.matchAll(/^.*display e-trunk brief[ \t]*$/gim)];
  const last = echoes[echoes.length - 1];
  const text = last ? all.slice(last.index! + last[0].length) : all;
  if (MORE.test(text) || /^\s*Error:/im.test(text)) return bad;
  const lines = text.split('\n');
  const headerIdx = lines.findIndex((l) => /E-TRUNK-ID/i.test(l) && /State/i.test(l));
  const eTrunks: ParsedETrunkBriefEntry[] = [];
  if (headerIdx < 0) {
    // Sem cabecalho: so e "vazio" se nao houver nenhuma linha de dados alem do prompt.
    const data = lines.filter((l) => l.trim() && !/^<.*>/.test(l.trim()));
    return { complete: data.length === 0, eTrunks, declaredTotal: null };
  }
  for (const line of lines.slice(headerIdx + 1)) {
    const m = /^\s*(\d+)\s+(Master|Backup|Initialize|Init)\b(.*)$/i.exec(line);
    if (!m) continue;
    const ips = m[3]!.match(/\b\d+\.\d+\.\d+\.\d+\b/g) ?? [];
    eTrunks.push({ eTrunkId: Number(m[1]), state: eTrunkState(m[2]), peerIp: ips[0] ?? null, sourceIp: ips[1] ?? null });
  }
  const total = /^\s*Total\s*:\s*(\d+)/im.exec(text)?.[1];
  const declaredTotal = total !== undefined ? Number(total) : null;
  if (declaredTotal !== null && declaredTotal !== eTrunks.length) return { complete: false, eTrunks: [], declaredTotal };
  return { complete: true, eTrunks, declaredTotal };
}

/**
 * Quando so o `brief` foi lido: o estado Master/Backup do E-Trunk esta comprovado, mas NAO a
 * tabela de membros nem a causa. O resultado nunca traz membros (nada e presumido).
 */
export function eTrunkFromBrief(brief: ParsedETrunkBrief, eTrunkId: number): ParsedETrunk | null {
  const entry = brief.complete ? brief.eTrunks.find((e) => e.eTrunkId === eTrunkId) : undefined;
  if (!entry || entry.state === null) return null;
  return { ...emptyETrunk(), complete: true, eTrunkId, state: entry.state, peerIp: entry.peerIp, sourceIp: entry.sourceIp };
}

/* ------------------------------------------------------------------ */
/* display eth-trunk <id>                                              */
/* ------------------------------------------------------------------ */

export interface ParsedEthTrunkMember {
  portName: string;
  /** LACP: SELECTED/UNSELECTED. Modo manual: UP/DOWN do membro. */
  status: 'SELECTED' | 'UNSELECTED' | 'UP' | 'DOWN' | null;
}

export interface ParsedEthTrunk {
  complete: boolean;
  trunkId: number | null;
  /** LACP (estatico/dinamico) ou NORMAL (manual). */
  workingMode: 'LACP' | 'NORMAL' | null;
  operStatus: 'UP' | 'DOWN' | null;
  /** `Number Of Up Port In Trunk`. */
  upPorts: number | null;
  leastActiveLinks: number | null;
  maxActiveLinks: number | null;
  members: ParsedEthTrunkMember[];
}

const emptyEthTrunk = (): ParsedEthTrunk => ({
  complete: false, trunkId: null, workingMode: null, operStatus: null, upPorts: null,
  leastActiveLinks: null, maxActiveLinks: null, members: [],
});

const PORT = /^(?:XGigabitEthernet|GigabitEthernet|10GE|25GE|40GE|100GE|XGE|GE|MultiGE|Ethernet)\d+(?:\/\d+)+$/i;

export function parseEthTrunk(raw: string, expectedId: number): ParsedEthTrunk {
  const text = clean(raw);
  if (MORE.test(text)) return emptyEthTrunk();
  const header = /^\s*Eth-Trunk(\d+)'s state information is:/im.exec(text);
  if (!header || Number(header[1]) !== expectedId) return emptyEthTrunk();
  const mode = /Working\s*Mode\s*:\s*(\S+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
  const workingMode = mode === null ? null : /^(LACP|STATIC|DYNAMIC)$/.test(mode) ? 'LACP' : /^(NORMAL|MANUAL)$/.test(mode) ? 'NORMAL' : null;
  const oper = /Operat(?:e|ing)\s+status\s*:\s*(up|down)/i.exec(text)?.[1]?.toLowerCase();
  // A secao "Partner:" repete nomes de porta: os membros locais terminam nela.
  const partner = text.search(/^\s*Partner\s*:/im);
  const local = partner >= 0 ? text.slice(0, partner) : text;
  const members: ParsedEthTrunkMember[] = [];
  for (const line of local.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2 || !PORT.test(cols[0]!)) continue;
    const s = cols[1]!.toLowerCase();
    const status = /^select(?:ed)?$/.test(s) ? 'SELECTED' : /^unselect(?:ed)?$/.test(s) ? 'UNSELECTED' : s === 'up' ? 'UP' : s === 'down' ? 'DOWN' : null;
    members.push({ portName: cols[0]!, status });
  }
  const operStatus = oper === 'up' ? 'UP' : oper === 'down' ? 'DOWN' : null;
  return {
    // Decidivel com o modo e (estado operacional OU tabela de membros com status reconhecido).
    complete: workingMode !== null && (operStatus !== null || (members.length > 0 && members.every((m) => m.status !== null))),
    trunkId: expectedId, workingMode, operStatus,
    upPorts: toInt(/Number Of Up Ports? In Trunk\s*:\s*(\d+)/i.exec(text)?.[1] ?? null),
    leastActiveLinks: toInt(/Least Active-linknumber\s*:\s*(\d+)/i.exec(text)?.[1] ?? null),
    maxActiveLinks: toInt(/Max Active-linknumber\s*:\s*(\d+)/i.exec(text)?.[1] ?? null),
    members,
  };
}

/* ------------------------------------------------------------------ */
/* RD                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Forma canonica do RD para comparacao: ASN de 4 bytes em asdot ("4.6424:3016",
 * "4.6424 : 3016") vira asplain ("268568:3016"). RD tipo IP ("10.0.0.1:5") e
 * preservado. null quando o texto nao e um RD reconhecivel (nunca adivinhar).
 */
export function normalizeRd(rd: string | null | undefined): string | null {
  if (!rd) return null;
  const m = /^\s*([0-9.]+)\s*:\s*(\d+)\s*$/.exec(rd);
  if (!m) return null;
  const admin = m[1]!;
  const assigned = String(Number(m[2]));
  if (/^\d+$/.test(admin)) return `${Number(admin)}:${assigned}`;
  const dot = /^(\d+)\.(\d+)$/.exec(admin);
  if (dot) {
    const hi = Number(dot[1]);
    const lo = Number(dot[2]);
    if (hi > 65535 || lo > 65535) return null;
    return `${hi * 65536 + lo}:${assigned}`;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(admin) && admin.split('.').every((o) => Number(o) <= 255)) return `${admin}:${assigned}`;
  return null;
}

/* ------------------------------------------------------------------ */
/* PWs persistidos obsoletos                                           */
/* ------------------------------------------------------------------ */

export interface PersistedPwRef {
  peerAddress: string;
  state: string;
  lastSeenAt: string;
}

/** Tolerancia entre a leitura da VSI e a do PW no MESMO ciclo de coleta SNMP. */
export const PERSISTED_PW_STALE_MS = 15 * 60_000;

/**
 * A coleta SNMP so faz upsert: um PW que deixou de existir fica gravado com o ultimo
 * estado (tipicamente UP). A VSI e regravada a cada ciclo; um PW cuja ultima leitura e
 * mais antiga que a da propria VSI nao foi visto no ciclo atual e NAO representa o
 * estado presente.
 */
export function isPersistedPwStale(pwLastSeenAt: string, vsiLastSeenAt: string, toleranceMs = PERSISTED_PW_STALE_MS): boolean {
  const pw = Date.parse(pwLastSeenAt);
  const vsi = Date.parse(vsiLastSeenAt);
  if (!Number.isFinite(pw) || !Number.isFinite(vsi)) return false;
  return vsi - pw > toleranceMs;
}

/* ------------------------------------------------------------------ */
/* Papel operacional                                                   */
/* ------------------------------------------------------------------ */

export type PathRole = 'ACTIVE' | 'STANDBY_EXPECTED' | 'DOWN_UNEXPECTED' | 'ROLE_UNKNOWN';

export interface RedundancyFacts {
  /** `display eth-trunk <N>` por nome de interface ("Eth-Trunk26"). */
  ethTrunks: Record<string, ParsedEthTrunk>;
  /** `display e-trunk <N>` por id. */
  eTrunks: Record<number, ParsedETrunk>;
  evidenceIds?: { ethTrunks?: Record<string, string>; eTrunks?: Record<number, string> };
}

export interface TrunkRole {
  interfaceName: string;
  role: PathRole;
  /** Mecanismo de redundancia COMPROVADO para este trunk. */
  mechanism: 'E_TRUNK' | 'LACP' | 'NONE' | 'UNKNOWN';
  eTrunkId: number | null;
  /** Fatos lidos do equipamento que sustentam o papel. */
  reasons: string[];
  /** Evidencia que falta para sair de ROLE_UNKNOWN. */
  missingEvidence: string[];
  /** Estado do E-Trunk que indica perda de redundancia ou risco, mesmo com o caminho ativo. */
  alerts: Array<'PEER_MEMBER_DOWN' | 'ETRUNK_PEER_UNREACHABLE' | 'FORCED_STATE' | 'MEMBER_NOT_SELECTED'>;
  selectedMembers: number | null;
  totalMembers: number | null;
}

/** Causas do E-Trunk que significam "nao ha comunicacao valida com o par". */
const PEER_UNREACHABLE = /^(TIMEOUT|PEER_TIMEOUT|BFD_DOWN|INIT)$/;

/**
 * Papel de um Eth-Trunk a partir da config (associacao `e-trunk N`), de `display e-trunk N`
 * e de `display eth-trunk N`. Regras:
 *  - STANDBY_EXPECTED so com membro E-Trunk em Backup E causa PEER_MEMBER_UP (o proprio
 *    protocolo informa que o membro do par esta ativo) E LACP sem contradicao;
 *  - ACTIVE exige trunk operacional com membro selecionado (e membro E-Trunk Master, se houver);
 *  - trunk fora de operacao sem mecanismo de protecao comprovado e DOWN_UNEXPECTED;
 *  - qualquer lacuna ou contradicao e ROLE_UNKNOWN com a evidencia que falta.
 */
export function classifyTrunkRole(
  interfaceName: string,
  cfg: Pick<ParsedInterfaceConfig, 'complete' | 'eTrunkId'> | null | undefined,
  facts: RedundancyFacts | null | undefined,
): TrunkRole {
  const trunkNumber = /^Eth-Trunk(\d+)$/i.exec(interfaceName)?.[1] ?? null;
  const lag = facts?.ethTrunks[interfaceName]?.complete ? facts.ethTrunks[interfaceName]! : null;
  const reasons: string[] = [];
  const missing: string[] = [];
  const alerts: TrunkRole['alerts'] = [];

  // Associacao: pela config do trunk; na falta dela, pelo E-Trunk lido que lista o trunk como membro.
  let eTrunkId: number | null = cfg?.complete ? (cfg.eTrunkId ?? null) : null;
  let et: ParsedETrunk | null = eTrunkId !== null && facts?.eTrunks[eTrunkId]?.complete ? facts.eTrunks[eTrunkId]! : null;
  if (eTrunkId === null && facts)
    for (const candidate of Object.values(facts.eTrunks))
      if (candidate.complete && candidate.members.some((m) => m.interfaceName.toLowerCase() === interfaceName.toLowerCase())) {
        et = candidate;
        eTrunkId = candidate.eTrunkId;
      }
  const member = et?.members.find((m) => m.interfaceName.toLowerCase() === interfaceName.toLowerCase()) ?? null;

  const selected = lag ? lag.members.filter((m) => m.status === 'SELECTED' || m.status === 'UP').length : null;
  const total = lag ? lag.members.length : null;
  if (lag) reasons.push(`${interfaceName}: ${lag.workingMode}${lag.operStatus ? `, operacional ${lag.operStatus}` : ''}, ${selected}/${total} membro(s) ${lag.workingMode === 'LACP' ? 'Selected' : 'up'}`);
  // Sem membro em uso o trunk nao encaminha; "encaminha" so se afirma com o estado operacional lido.
  const lagForwarding = !lag ? null
    : lag.members.length > 0 && selected === 0 ? false
    : lag.operStatus === 'DOWN' || lag.upPorts === 0 ? false
    : lag.operStatus === 'UP' && (selected ?? 0) > 0 ? true
    : null;
  const base = { interfaceName, eTrunkId, selectedMembers: selected, totalMembers: total };
  const out = (role: PathRole, mechanism: TrunkRole['mechanism']): TrunkRole => ({ ...base, role, mechanism, reasons, missingEvidence: missing, alerts });

  if (eTrunkId !== null && !et) {
    reasons.push(`${interfaceName} esta associado ao E-Trunk ${eTrunkId} pela configuracao`);
    missing.push(`display e-trunk ${eTrunkId} (estado Master/Backup e causa)`);
    return out('ROLE_UNKNOWN', 'E_TRUNK');
  }

  if (et) {
    reasons.push(`E-Trunk ${et.eTrunkId}: ${et.state}${et.causation ? ` (causa ${et.causation})` : ''}${et.peerIp ? `, peer ${et.peerIp}` : ''}`);
    if (!member) {
      missing.push(`linha de ${interfaceName} na tabela de membros de display e-trunk ${et.eTrunkId} (estado e causa do membro)`);
      // E-Trunk Master com o trunk operacional e membro selecionado: o encaminhamento esta comprovado pelo LACP.
      if (et.state === 'MASTER' && lagForwarding === true) return out('ACTIVE', 'E_TRUNK');
      return out('ROLE_UNKNOWN', 'E_TRUNK');
    }
    reasons.push(`membro ${interfaceName}: ${member.state}${member.causation ? ` (causa ${member.causation})` : ''}${member.localPhyState ? `, fisico local ${member.localPhyState}` : ''}`);
    if (et.state === 'MASTER' && et.causation && PEER_UNREACHABLE.test(et.causation)) alerts.push('ETRUNK_PEER_UNREACHABLE');
    if (member.causation && /^FORCE_/.test(member.causation)) alerts.push('FORCED_STATE');

    if (member.state === 'BACKUP') {
      if (lagForwarding === true) {
        missing.push(`contradicao: membro E-Trunk em Backup mas ${interfaceName} operacional com membro selecionado`);
        return out('ROLE_UNKNOWN', 'E_TRUNK');
      }
      if (member.causation === 'PEER_MEMBER_UP') return out('STANDBY_EXPECTED', 'E_TRUNK');
      missing.push(`estado ativo do par: a causa do membro e ${member.causation ?? 'desconhecida'}, nao PEER_MEMBER_UP; ler display e-trunk no par`);
      return out('ROLE_UNKNOWN', 'E_TRUNK');
    }
    if (member.state === 'MASTER') {
      if (member.causation === 'PEER_MEMBER_DOWN') alerts.push('PEER_MEMBER_DOWN');
      if (lagForwarding === true) {
        if (lag && selected !== null && total !== null && selected < total) alerts.push('MEMBER_NOT_SELECTED');
        return out('ACTIVE', 'E_TRUNK');
      }
      if (lagForwarding === false) return out('DOWN_UNEXPECTED', 'E_TRUNK');
      if (member.localPhyState === 'DOWN') return out('DOWN_UNEXPECTED', 'E_TRUNK');
      missing.push(`display eth-trunk ${trunkNumber ?? '<N>'} (estado operacional e membros Selected)`);
      return out('ROLE_UNKNOWN', 'E_TRUNK');
    }
    missing.push(`membro E-Trunk em estado ${member.state ?? 'nao reconhecido'}`);
    return out('ROLE_UNKNOWN', 'E_TRUNK');
  }

  // Sem E-Trunk conhecido.
  if (!cfg?.complete) {
    missing.push(`display current-configuration interface ${interfaceName} (existe associacao e-trunk?)`);
    if (lagForwarding === true) return out('ACTIVE', 'UNKNOWN');
    return out('ROLE_UNKNOWN', 'UNKNOWN');
  }
  if (!lag) {
    missing.push(`display eth-trunk ${trunkNumber ?? '<N>'} (estado operacional e membros)`);
    return out('ROLE_UNKNOWN', 'UNKNOWN');
  }
  reasons.push(`${interfaceName} sem associacao e-trunk na configuracao`);
  const mechanism = lag.workingMode === 'LACP' ? 'LACP' : 'NONE';
  if (lagForwarding) {
    if (selected !== null && total !== null && selected < total) alerts.push('MEMBER_NOT_SELECTED');
    return out('ACTIVE', mechanism);
  }
  return out('DOWN_UNEXPECTED', mechanism);
}
