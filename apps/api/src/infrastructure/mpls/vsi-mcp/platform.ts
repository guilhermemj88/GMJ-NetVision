import type { VsiMcpOperationKind } from './command-policy';

/**
 * Familias VRP reconhecidas a partir de `display version`.
 * NE8000 e NE40E NAO sao tratados como equivalentes entre si nem aos switches.
 */
export type HuaweiFamily =
  | 'NE8000_V800'
  | 'NE40E_V800'
  | 'S6730_V200'
  | 'S6750_YUNSHAN_V600'
  | 'UNKNOWN';

export interface HuaweiPlatform {
  family: HuaweiFamily;
  model: string | null;
  release: string | null;
  /** Texto da linha de versao usado na decisao (evidencia). */
  matchedLine: string | null;
}

export function classifyHuaweiVersion(output: string): HuaweiPlatform {
  const text = output.replace(/\r/g, '');
  // O VRP escreve "NetEngine 8000 F1A-8H20Q" / "NetEngine 40E-X8A"; documentos usam "NE8000"/"NE40E".
  const ne8000 = /\b(NE8000|NetEngine\s+8000)\b([^\n]*?)\b(V8\d\dR\d{3}C\d{2}(?:SPC\d+)?)/i.exec(text);
  if (ne8000) {
    // A linha "HUAWEI NetEngine 8000 F1A-8H20Q uptime is ..." traz o codigo completo do chassi.
    const full = /\bNetEngine\s+8000\s+([A-Z0-9][A-Z0-9-]{1,24})\s+uptime\b/i.exec(text)?.[1];
    return platform('NE8000_V800', full ? `NE8000 ${full}` : modelOf(ne8000[2]!, 'NE8000'), ne8000[3]!, ne8000[0]);
  }
  const ne40 = /\b(?:NE40E|NetEngine\s+40E)([\w-]*)\b([^\n]*?)\b(V8\d\dR\d{3}C\d{2}(?:SPC\d+)?)/i.exec(text);
  if (ne40) return platform('NE40E_V800', 'NE40E' + (ne40[1] ?? ''), ne40[3]!, ne40[0]);
  const s6730 = /\b(S6730[\w-]*)\s+(V200R\d{3}C\d{2}(?:SPC\d+)?)/i.exec(text);
  if (s6730) return platform('S6730_V200', s6730[1]!, s6730[2]!, s6730[0]);
  const s6750 = /\b(S6700)\s+(V600R\d{3}C\d{2}(?:SPC\d+)?)/i.exec(text);
  if (s6750) return platform('S6750_YUNSHAN_V600', s6750[1]!, s6750[2]!, s6750[0]);
  return { family: 'UNKNOWN', model: null, release: null, matchedLine: null };
}

function platform(
  family: HuaweiFamily,
  model: string,
  release: string,
  matchedLine: string,
): HuaweiPlatform {
  return { family, model: model.toUpperCase(), release: release.toUpperCase(), matchedLine: matchedLine.trim().slice(0, 200) };
}

export type CapabilityStatus =
  /** Comando exercitado e capturado em equipamento real desta familia/versao. */
  | 'HOMOLOGATED'
  /** Sintaxe plausivel, ainda SEM captura real: so roda em modo de homologacao. */
  | 'CANDIDATE'
  /** Comprovadamente inexistente/sem equivalente nesta familia. */
  | 'NOT_SUPPORTED';

export interface CapabilityEntry {
  status: CapabilityStatus;
  note: string;
}

/**
 * Matriz de capacidades. Atualizar uma celula para HOMOLOGATED exige captura
 * real versionada em __fixtures__ (ver docs/VSI_MCP_DIAGNOSTICS.md, secao
 * "Homologacao"). Nenhuma celula e promovida por analogia entre familias.
 */
export const VSI_CAPABILITY_MATRIX: Readonly<
  Record<HuaweiFamily, Readonly<Record<VsiMcpOperationKind, CapabilityEntry>>>
> = {
  S6730_V200: {
    VERSION: { status: 'HOMOLOGATED', note: 'captura real BHE-VTA 2026-10-22' },
    VSI_LIST: { status: 'CANDIDATE', note: 'sem captura real de `display vsi` completo' },
    VSI_VERBOSE: { status: 'HOMOLOGATED', note: 'display vsi name <v> verbose (fixture bhe-vta)' },
    VSI_MAC: { status: 'CANDIDATE', note: 'sintaxe de MAC por VSI nao capturada nesta familia' },
    INTERFACE_CONFIG: { status: 'CANDIDATE', note: 'display current-configuration interface <if>' },
    INTERFACE_STATE: { status: 'HOMOLOGATED', note: 'display interface <if> (fixture bhe-vta)' },
    VLAN_INFO: { status: 'CANDIDATE', note: 'display vlan <id>: sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETRUNK_BRIEF: { status: 'HOMOLOGATED', note: 'S6730 V200 (BHE-VTA-6730-MPLS-01 e BHE-LIKEE-6730-MPLS-01, 2026-11-16): display e-trunk brief; colunas E-TRUNK-ID/State/Peer-IP/Source-IP + rodape Total/Master/Backup/Init. Captura real coletada manualmente pelo operador (fluxo MCP->API->SSH ainda nao exercitado para este comando)' },
    ETRUNK_INFO: { status: 'HOMOLOGATED', note: 'S6730 V200 (BHE-VTA-6730-MPLS-01, 2026-11-16): display e-trunk <1-16>; cabecalho em duas colunas (State/Causation/Priority/Peer-IP/BFD-Session/Revert-Delay-Time) + tabela de membros Type/ID/LocalPhyState/Work-Mode/State/Causation/Remote-ID. Captura real manual do operador; so o estado Backup foi observado no comando completo' },
    ETH_TRUNK_INFO: { status: 'HOMOLOGATED', note: 'S6730 V200 (BHE-VTA-6730-MPLS-01 e BHE-LIKEE-6730-MPLS-01, 2026-11-16): display eth-trunk <id> em modo LACP; Operate status, Number Of Up Port In Trunk, membros Selected/Unselect e secao Partner. Captura real manual do operador; modo manual (NORMAL) nunca observado' },
  },
  S6750_YUNSHAN_V600: {
    VERSION: { status: 'HOMOLOGATED', note: 'captura real r2-version' },
    VSI_LIST: { status: 'CANDIDATE', note: 'sem captura real' },
    VSI_VERBOSE: { status: 'HOMOLOGATED', note: 'fixture r4-retest-vsi' },
    VSI_MAC: { status: 'HOMOLOGATED', note: 'S6750-H36C 1.24.0.1 V600R024C00SPC500 (2026-11-09): display mac-address vsi <vsi>; colunas MAC/VLAN-VSI-BD/Learned-From/Type/Age; "Total items: N"' },
    INTERFACE_CONFIG: { status: 'HOMOLOGATED', note: 'S6750-H36C V600R024C00SPC500 (2026-11-09): Vlanif com "l2 binding vsi"; Vlanif (l2 binding vsi) e Eth-Trunk em modo trunk (port link-type trunk, port trunk allow-pass vlan, multiplas linhas); dot1q/qinq/vlan-mapping/stacking NUNCA observados' },
    INTERFACE_STATE: { status: 'HOMOLOGATED', note: 'fixture r4-retest-interface' },
    VLAN_INFO: { status: 'HOMOLOGATED', note: 'S6750-H36C V600R024C00SPC500 (2026-11-09): display vlan <id>; tabelas "VID Ports" (TG:/UT:/ST:/MP: + (U|D)) e "VID Type Status Property MAC-LRN STAT BC MC UC Description"' },
    ETRUNK_BRIEF: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETRUNK_INFO: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETH_TRUNK_INFO: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
  },
  NE8000_V800: {
    VERSION: { status: 'HOMOLOGATED', note: 'captura real MCP->API->SSH em F1A-8H20Q V800R022C00SPC600 (2026-11-09)' },
    VSI_LIST: { status: 'HOMOLOGATED', note: 'F1A-8H20Q V800R022C00SPC600 (2026-11-09): comando aceito; SOMENTE o caso vazio foi observado; formato com VSIs nao observado (parser devolve INCONCLUSIVE)' },
    VSI_VERBOSE: { status: 'CANDIDATE', note: 'campos AC/PW do NE8000 diferem; sem captura' },
    VSI_MAC: { status: 'CANDIDATE', note: 'sintaxe NE8000 a confirmar (display mac-address vsi?)' },
    INTERFACE_CONFIG: { status: 'CANDIDATE', note: 'sem captura real NE8000' },
    INTERFACE_STATE: { status: 'CANDIDATE', note: 'sem captura real NE8000' },
    VLAN_INFO: { status: 'CANDIDATE', note: 'display vlan <id>: sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETRUNK_BRIEF: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETRUNK_INFO: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETH_TRUNK_INFO: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
  },
  NE40E_V800: {
    VERSION: { status: 'HOMOLOGATED', note: 'comando universal VRP, ja usado em producao; necessario para identificar a plataforma' },
    VSI_LIST: { status: 'CANDIDATE', note: 'sem captura real NE40E' },
    VSI_VERBOSE: { status: 'CANDIDATE', note: 'sem captura real NE40E' },
    VSI_MAC: { status: 'CANDIDATE', note: 'sintaxe NE40E a confirmar' },
    INTERFACE_CONFIG: { status: 'CANDIDATE', note: 'sem captura real NE40E' },
    INTERFACE_STATE: { status: 'CANDIDATE', note: 'sem captura real NE40E' },
    VLAN_INFO: { status: 'CANDIDATE', note: 'display vlan <id>: sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETRUNK_BRIEF: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETRUNK_INFO: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
    ETH_TRUNK_INFO: { status: 'CANDIDATE', note: 'sintaxe VRP padrao, sem captura real nesta familia/versao' },
  },
  UNKNOWN: {
    VERSION: { status: 'HOMOLOGATED', note: 'comando universal VRP, ja usado em producao; necessario para identificar a plataforma' },
    VSI_LIST: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
    VSI_VERBOSE: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
    VSI_MAC: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
    INTERFACE_CONFIG: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
    INTERFACE_STATE: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
    VLAN_INFO: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
    ETRUNK_BRIEF: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
    ETRUNK_INFO: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
    ETH_TRUNK_INFO: { status: 'NOT_SUPPORTED', note: 'plataforma nao identificada' },
  },
};

export interface CapabilityDecision {
  allowed: boolean;
  status: CapabilityStatus;
  reason: 'HOMOLOGATED' | 'HOMOLOGATION_MODE' | 'CANDIDATE_NOT_HOMOLOGATED' | 'NOT_SUPPORTED';
  note: string;
}

/**
 * `homologation=true` e uma execucao explicita (ADMIN + aprovacao one-shot) cujo
 * unico objetivo e capturar a saida real para virar fixture; o resultado nunca
 * produz veredito de diagnostico.
 */
export function resolveCapability(
  family: HuaweiFamily,
  operation: VsiMcpOperationKind,
  homologation = false,
): CapabilityDecision {
  const entry = VSI_CAPABILITY_MATRIX[family][operation];
  if (entry.status === 'HOMOLOGATED')
    return { allowed: true, status: entry.status, reason: 'HOMOLOGATED', note: entry.note };
  if (entry.status === 'CANDIDATE')
    return homologation
      ? { allowed: true, status: entry.status, reason: 'HOMOLOGATION_MODE', note: entry.note }
      : { allowed: false, status: entry.status, reason: 'CANDIDATE_NOT_HOMOLOGATED', note: entry.note };
  return { allowed: false, status: entry.status, reason: 'NOT_SUPPORTED', note: entry.note };
}

/** Codigo de modelo logo apos o nome ("NetEngine 8000 F1A V800R..." -> "NE8000 F1A"), se existir. */
function modelOf(tail: string, short: string): string {
  const code = /^\s+([A-Z][A-Z0-9-]{1,20})\b/.exec(tail)?.[1];
  return code && !/^V8\d\d/i.test(code) ? `${short} ${code}` : short;
}
