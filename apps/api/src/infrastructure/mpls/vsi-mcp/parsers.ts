/**
 * Parsers puros de saidas VRP para o diagnostico VSI/MPLS.
 *
 * Contrato: nunca lancam. Saida truncada/paginada/inesperada resulta em
 * `complete=false` (e nunca em dados parciais apresentados como completos).
 */

const MORE = /----\s*More\s*----|--More--|\[y\/n\]|\(y\/n\)/i;
const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/\r/g, '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

const field = (block: string, key: string): string | null => {
  const m = new RegExp('^[ \\t*]*' + key + '[ \\t]*:[ \\t]*([^\\n]*?)[ \\t]*$', 'im').exec(block);
  const v = m?.[1]?.trim();
  return !v || v === '--' || v === '-' ? null : v;
};

const toInt = (v: string | null): number | null =>
  v !== null && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;

const upDown = (v: string | null): 'UP' | 'DOWN' | null => {
  const t = v?.toLowerCase();
  return t === 'up' ? 'UP' : t === 'down' ? 'DOWN' : null;
};

/* ------------------------------------------------------------------ */
/* display vsi name <v> verbose                                        */
/* ------------------------------------------------------------------ */

export interface ParsedVsiAc {
  interfaceName: string;
  state: 'UP' | 'DOWN' | null;
  acBlockState: string | null;
  accessPort: boolean | null;
}

export interface ParsedVsiPw {
  peerAddress: string;
  vcId: number | null;
  state: 'UP' | 'DOWN' | null;
  localLabel: number | null;
  remoteLabel: number | null;
  pwType: string | null;
  tunnelId: string | null;
  tunnelType: string | null;
  outInterface: string | null;
  /** Contador `Mac Flapping` informado pelo equipamento para este PW (null = campo ausente). */
  macFlapping?: number | null;
  /** `PW Total Up Time` em segundos (tempo desde o ultimo up, no relogio do equipamento; null = ausente). */
  totalUpSeconds?: number | null;
}

/**
 * "1 days, 8 hours, 47 minutes, 39 seconds" (VRP classico e YunShan) -> segundos.
 * null se o texto nao for composto apenas de unidades conhecidas.
 */
export function durationToSeconds(v: string | null): number | null {
  if (!v) return null;
  const units: Record<string, number> = {
    day: 86400, days: 86400, hour: 3600, hours: 3600, minute: 60, minutes: 60, second: 1, seconds: 1,
  };
  let total = 0;
  let any = false;
  for (const part of v.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)\s+([a-z]+)$/i.exec(part);
    const mult = m ? units[m[2]!.toLowerCase()] : undefined;
    if (!m || mult === undefined) return null;
    total += Number(m[1]) * mult;
    any = true;
  }
  return any && Number.isSafeInteger(total) ? total : null;
}

export interface ParsedVsiVerbose {
  complete: boolean;
  name: string | null;
  state: 'UP' | 'DOWN' | null;
  signaling: string | null;
  encapsulationType: string | null;
  mtu: number | null;
  vsiIndex: number | null;
  rd: string | null;
  acs: ParsedVsiAc[];
  pws: ParsedVsiPw[];
}

export function parseVsiVerbose(raw: string, expectedName: string): ParsedVsiVerbose {
  const text = clean(raw);
  const empty: ParsedVsiVerbose = {
    complete: false, name: null, state: null, signaling: null, encapsulationType: null,
    mtu: null, vsiIndex: null, rd: null, acs: [], pws: [],
  };
  if (MORE.test(text)) return empty;
  const names = [...text.matchAll(/^[ \t*]*VSI Name[ \t]*:[ \t]*(\S+)[ \t]*$/gim)].map((m) => m[1]);
  if (names.length !== 1 || names[0] !== expectedName) return empty;

  const pwStart = text.search(/^[ \t]*\*{0,2}PW Information/im);
  const head = pwStart >= 0 ? text.slice(0, pwStart) : text;
  const tail = pwStart >= 0 ? text.slice(pwStart) : '';

  // Blocos de AC: cada `Interface Name :` abre um bloco ate o proximo.
  const acs: ParsedVsiAc[] = [];
  const acRe = /^[ \t]*Interface Name[ \t]*:[ \t]*(\S+)[ \t]*$/gim;
  const acMatches = [...head.matchAll(acRe)];
  acMatches.forEach((m, i) => {
    const end = acMatches[i + 1]?.index ?? head.length;
    const block = head.slice(m.index!, end);
    const access = field(block, 'Access Port')?.toLowerCase();
    acs.push({
      interfaceName: m[1]!,
      state: upDown(field(block, '(?:AC )?State')),
      acBlockState: field(block, 'Ac Block State'),
      accessPort: access === 'true' ? true : access === 'false' ? false : null,
    });
  });
  const globals = acMatches.length ? head.slice(0, acMatches[0]!.index) : head;

  const pws: ParsedVsiPw[] = [];
  const pwRe = /^[ \t]*\*?Peer Ip Address[ \t]*:[ \t]*(\d+\.\d+\.\d+\.\d+)[ \t]*$/gim;
  const pwMatches = [...tail.matchAll(pwRe)];
  pwMatches.forEach((m, i) => {
    const end = pwMatches[i + 1]?.index ?? tail.length;
    const block = tail.slice(m.index!, end);
    const label = (v: string | null): number | null => {
      const n = toInt(v);
      return n !== null && n <= 1048575 ? n : null;
    };
    pws.push({
      peerAddress: m[1]!,
      vcId: toInt(field(block, '(?:Peer Vc Id|VC ID|PW ID)')),
      state: upDown(field(block, 'PW State')),
      localLabel: label(field(block, '(?:Local VC Label|Local Label|In Label)')),
      remoteLabel: label(field(block, '(?:Remote VC Label|Remote Label|Out Label)')),
      pwType: field(block, 'PW Type'),
      tunnelId: field(block, 'Tunnel ID'),
      tunnelType: field(block, 'Tnl Type'),
      outInterface: field(block, 'OutInterface'),
      macFlapping: toInt(field(block, 'Mac Flapping')),
      totalUpSeconds: durationToSeconds(field(block, 'PW Total Up Time')),
    });
  });

  return {
    complete: true,
    name: names[0]!,
    state: upDown(field(globals, 'VSI State')),
    signaling: field(globals, 'PW Signaling'),
    encapsulationType: field(globals, 'Encapsulation Type')?.toLowerCase() ?? null,
    mtu: toInt(field(globals, 'MTU')),
    vsiIndex: toInt(field(globals, 'VSI Index')),
    rd: field(globals, 'BGP RD'),
    acs,
    pws,
  };
}

/* ------------------------------------------------------------------ */
/* display mac-address vsi <v>                                         */
/* ------------------------------------------------------------------ */

export type MacTypeClass = 'DYNAMIC' | 'STATIC' | 'BLACKHOLE' | 'OTHER';

export interface ParsedMacEntry {
  mac: string;
  learnedFrom: string;
  /**
   * Natureza da origem do aprendizado segundo o PROPRIO campo Learned-From:
   * AC = nome de interface; PW = endereco de peer/PW. Nao afirma "local" ou "remoto" do ponto de
   * vista do cliente: so o que o equipamento mostrou.
   */
  side: 'AC' | 'PW' | 'UNKNOWN';
  type: string;
  typeClass?: MacTypeClass;
  /** Idade em segundos, quando a coluna Age existe e e numerica. */
  ageSeconds?: number | null;
  /** Segmento VSI da coluna VLAN/VSI/BD (null = '-' ou formato desconhecido). */
  vsiColumn?: string | null;
  /** Marcador `*` (backup) ou `#` (interface logica) que precede o MAC. */
  flag?: '*' | '#' | null;
}

export interface ParsedMacTable {
  complete: boolean;
  entries: ParsedMacEntry[];
  /** Total declarado pelo equipamento, se houver. */
  declaredTotal: number | null;
  /** Linhas cuja coluna VSI nomeia OUTRA VSI: a consulta vazou do escopo pedido. */
  outOfScope?: number;
  /** Por que a tabela nao e completa (para distinguir truncamento de formato desconhecido). */
  incompleteReason?: 'PAGED' | 'TOTAL_MISMATCH' | 'OUT_OF_SCOPE' | 'NO_TOTAL_OR_ROWS' | null;
}

const macTypeClass = (t: string): MacTypeClass =>
  /^dynamic$/.test(t) ? 'DYNAMIC' : /^static$/.test(t) ? 'STATIC' : /black-?hole/.test(t) ? 'BLACKHOLE' : 'OTHER';

export function parseMacTable(raw: string, expectedVsi?: string): ParsedMacTable {
  const text = clean(raw);
  if (MORE.test(text))
    return { complete: false, entries: [], declaredTotal: null, outOfScope: 0, incompleteReason: 'PAGED' };
  const entries: ParsedMacEntry[] = [];
  const row =
    /^[ \t]*([*#])?[ \t]*([0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4})[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)(?:[ \t]+([^\n]*))?$/gim;
  let outOfScope = 0;
  for (const m of text.matchAll(row)) {
    const learnedFrom = m[4]!;
    const segments = m[3]!.split('/');
    const vsiSeg = segments.length === 3 && segments[1] !== '-' ? segments[1]! : null;
    if (expectedVsi && vsiSeg !== null && vsiSeg !== expectedVsi) outOfScope++;
    const type = m[5]!.toLowerCase();
    const age = /^\d+$/.test((m[6] ?? '').trim().split(/\s+/)[0] ?? '') ? Number((m[6] ?? '').trim().split(/\s+/)[0]) : null;
    entries.push({
      mac: m[2]!.toLowerCase(),
      learnedFrom,
      side: /^\d+\.\d+\.\d+\.\d+/.test(learnedFrom) || /^pw/i.test(learnedFrom)
        ? 'PW'
        : /^[A-Za-z][A-Za-z0-9-]*\d/.test(learnedFrom)
          ? 'AC'
          : 'UNKNOWN',
      type,
      typeClass: macTypeClass(type),
      ageSeconds: age !== null && Number.isSafeInteger(age) ? age : null,
      vsiColumn: vsiSeg,
      flag: (m[1] as '*' | '#' | undefined) ?? null,
    });
  }
  // VRP V800: "Total items displayed = N"; YunShan V600: "Total items: N".
  const total = /Total items(?: displayed)?\s*[=:]\s*(\d+)/i.exec(text)?.[1];
  const declaredTotal = total === undefined ? null : Number(total);
  let incompleteReason: ParsedMacTable['incompleteReason'] = null;
  if (declaredTotal !== null && declaredTotal !== entries.length) incompleteReason = 'TOTAL_MISMATCH';
  else if (declaredTotal === null && !(entries.length > 0 || /no mac|0 mac|not found/i.test(text) || /Total/i.test(text)))
    incompleteReason = 'NO_TOTAL_OR_ROWS';
  // Consulta que devolveu linhas de OUTRA VSI nao e confiavel como "tabela desta VSI".
  if (outOfScope > 0) incompleteReason = 'OUT_OF_SCOPE';
  return { complete: incompleteReason === null, entries, declaredTotal, outOfScope, incompleteReason };
}

/* ------------------------------------------------------------------ */
/* display current-configuration interface <if>                        */
/* ------------------------------------------------------------------ */

export type EncapDirective =
  | { kind: 'DOT1Q_TERMINATION'; vid: string; raw: string }
  | { kind: 'QINQ_TERMINATION'; peVid: string; ceVid: string; raw: string }
  | { kind: 'UNTAG'; raw: string }
  | { kind: 'QINQ_STACKING'; vlan: string; stackVlan: string; raw: string }
  | { kind: 'VLAN_MAPPING'; vlan: string; mapVlan: string; raw: string }
  | { kind: 'REWRITE'; action: string; raw: string }
  | { kind: 'VLAN_TYPE'; vlan: string; raw: string }
  | { kind: 'TRUNK_ALLOW'; vlans: string; raw: string };

export interface ParsedInterfaceConfig {
  complete: boolean;
  interfaceName: string | null;
  /** Nome da VSI se houver `l2 binding vsi <nome>` NESTA interface. */
  l2BindingVsi: string | null;
  mode: 'L2_PORT' | 'L3' | 'UNKNOWN';
  shutdown: boolean;
  mtu: number | null;
  directives: EncapDirective[];
  parentInterface: string | null;
  /** Interface de camada 2 de porta/trunk: como a porta trata VLANs (null = nao e porta L2 ou nao informado). */
  portVlan?: PortVlanConfig | null;
  /** `e-trunk <id> [remote-eth-trunk <n>]` no Eth-Trunk: associacao a um E-Trunk (campo ausente = sem a diretiva). */
  eTrunkId?: number;
  remoteEthTrunkId?: number;
  /** `mode lacp-static|lacp-dynamic|lacp` no Eth-Trunk (campo ausente = sem a diretiva). */
  lacpMode?: 'STATIC' | 'DYNAMIC';
}

export interface PortVlanConfig {
  linkType: 'ACCESS' | 'TRUNK' | 'HYBRID' | null;
  /** Texto de `port trunk allow-pass vlan ...` (pode haver varias linhas). */
  trunkAllow: string[];
  hybridTagged: string[];
  hybridUntagged: string[];
  pvid: number | null;
  defaultVlan: number | null;
}

/**
 * Avalia se uma lista de VLANs da VRP ("10 20 to 30", "all") contem `vlan`.
 * null = lista nao interpretavel (nunca assumir que contem).
 */
export function vlanListIncludes(specs: readonly string[], vlan: number): boolean | null {
  let known = false;
  for (const spec of specs) {
    const tokens = spec.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t === 'all') return true;
      if (!/^\d+$/.test(t)) return null;
      known = true;
      if (tokens[i + 1] === 'to' && /^\d+$/.test(tokens[i + 2] ?? '')) {
        if (vlan >= Number(t) && vlan <= Number(tokens[i + 2])) return true;
        i += 2;
      } else if (Number(t) === vlan) return true;
    }
  }
  return known ? false : null;
}

export function parseInterfaceConfig(raw: string, expectedInterface: string): ParsedInterfaceConfig {
  const text = clean(raw);
  const empty: ParsedInterfaceConfig = {
    complete: false, interfaceName: null, l2BindingVsi: null, mode: 'UNKNOWN',
    shutdown: false, mtu: null, directives: [], parentInterface: null, portVlan: null,
  };
  if (MORE.test(text)) return empty;
  const header = new RegExp(
    '^interface\\s+(' + escapeRegExp(expectedInterface) + ')(?:[ \\t]+([^\\n]*?))?[ \\t]*$',
    'im',
  ).exec(text);
  if (!header) return empty;
  const headerTail = header[2] ?? '';
  const start = header.index + header[0].length;
  const rest = text.slice(start);
  const endMatch = /^#\s*$/m.exec(rest);
  const body = endMatch ? rest.slice(0, endMatch.index) : rest;
  // Bloco sem o `#` final e sem `return`/prompt nao e considerado completo.
  const complete = endMatch !== null;

  const directives: EncapDirective[] = [];
  let l2BindingVsi: string | null = null;
  let shutdown = false;
  let mtu: number | null = null;
  let eTrunkId: number | undefined;
  let remoteEthTrunkId: number | undefined;
  let lacpMode: 'STATIC' | 'DYNAMIC' | undefined;
  const portVlan: PortVlanConfig = { linkType: null, trunkAllow: [], hybridTagged: [], hybridUntagged: [], pvid: null, defaultVlan: null };
  let mode: ParsedInterfaceConfig['mode'] = /\bmode l2\b/i.test(headerTail) ? 'L2_PORT' : 'UNKNOWN';

  for (const lineRaw of body.split('\n')) {
    const line = lineRaw.trim().replace(/\s+/g, ' ');
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^l2 binding vsi (\S+)/.exec(line))) l2BindingVsi = m[1]!;
    else if (line === 'shutdown') shutdown = true;
    else if ((m = /^mtu (\d+)$/.exec(line))) mtu = Number(m[1]);
    else if ((m = /^e-trunk (\d+)(?: remote-eth-trunk (\d+))?$/.exec(line))) {
      eTrunkId = Number(m[1]);
      if (m[2] !== undefined) remoteEthTrunkId = Number(m[2]);
    } else if ((m = /^mode (lacp-static|lacp-dynamic|lacp)$/.exec(line))) lacpMode = m[1] === 'lacp-dynamic' ? 'DYNAMIC' : 'STATIC';
    else if ((m = /^port link-type (access|trunk|hybrid)$/.exec(line))) {
      mode = 'L2_PORT';
      portVlan.linkType = m[1]!.toUpperCase() as 'ACCESS' | 'TRUNK' | 'HYBRID';
    } else if ((m = /^port hybrid tagged vlan (.+)$/.exec(line))) portVlan.hybridTagged.push(m[1]!);
    else if ((m = /^port hybrid untagged vlan (.+)$/.exec(line))) portVlan.hybridUntagged.push(m[1]!);
    else if ((m = /^port (?:trunk|hybrid) pvid vlan (\d+)$/.exec(line))) portVlan.pvid = Number(m[1]);
    else if ((m = /^port default vlan (\d+)$/.exec(line))) portVlan.defaultVlan = Number(m[1]);
    else if (/^portswitch$/.test(line)) mode = 'L2_PORT';
    else if (/^undo portswitch$/.test(line) || /^ip address /.test(line)) mode = 'L3';
    else if (
      (m = /^(?:dot1q termination vid|encapsulation dot1q-termination vid|encapsulation dot1q vid)\s+(\S+)/.exec(line))
    )
      directives.push({ kind: 'DOT1Q_TERMINATION', vid: m[1]!, raw: line });
    else if (
      (m = /^(?:qinq termination (?:pe-vid|pe) (\S+) (?:ce-vid|ce) (\S+(?: to \S+)?)|encapsulation qinq vid (\S+) ce-vid (\S+(?: to \S+)?))/.exec(line))
    )
      directives.push({ kind: 'QINQ_TERMINATION', peVid: (m[1] ?? m[3])!, ceVid: (m[2] ?? m[4])!, raw: line });
    else if (/^encapsulation untag/.test(line)) directives.push({ kind: 'UNTAG', raw: line });
    else if ((m = /^(?:port )?(?:qinq|vlan)-stacking vlan (\S+) stack-vlan (\S+)/.exec(line)) ||
             (m = /^qinq stacking vlan (\S+) stack-vlan (\S+)/.exec(line)))
      directives.push({ kind: 'QINQ_STACKING', vlan: m[1]!, stackVlan: m[2]!, raw: line });
    // Subinterface de stacking (serie S): `qinq stacking vid <ce> [to <ce-fim>] pe-vid <pe>`.
    // Quadros com a tag <ce> (ou a faixa) recebem a tag externa <pe>. Pode haver varias linhas por subinterface.
    else if ((m = /^qinq stacking vid (\d+)(?: to (\d+))? pe-vid (\d+)$/.exec(line)))
      directives.push({ kind: 'QINQ_STACKING', vlan: m[2] !== undefined ? `${m[1]} to ${m[2]}` : m[1]!, stackVlan: m[3]!, raw: line });
    else if ((m = /^(?:port )?vlan-mapping vlan (\S+) map-vlan (\S+)/.exec(line)))
      directives.push({ kind: 'VLAN_MAPPING', vlan: m[1]!, mapVlan: m[2]!, raw: line });
    else if ((m = /^rewrite (.+)$/.exec(line))) directives.push({ kind: 'REWRITE', action: m[1]!, raw: line });
    else if ((m = /^vlan-type dot1q (\S+)/.exec(line)))
      directives.push({ kind: 'VLAN_TYPE', vlan: m[1]!, raw: line });
    else if ((m = /^port trunk allow-pass vlan (.+)$/.exec(line))) {
      directives.push({ kind: 'TRUNK_ALLOW', vlans: m[1]!, raw: line });
      portVlan.trunkAllow.push(m[1]!);
    }
  }

  const dot = expectedInterface.lastIndexOf('.');
  return {
    complete,
    interfaceName: expectedInterface,
    l2BindingVsi,
    mode,
    shutdown,
    mtu,
    directives,
    parentInterface: dot > 0 ? expectedInterface.slice(0, dot) : null,
    portVlan: portVlan.linkType !== null || portVlan.trunkAllow.length || portVlan.hybridTagged.length ||
      portVlan.hybridUntagged.length || portVlan.pvid !== null || portVlan.defaultVlan !== null ? portVlan : null,
    ...(eTrunkId !== undefined ? { eTrunkId } : {}),
    ...(remoteEthTrunkId !== undefined ? { remoteEthTrunkId } : {}),
    ...(lacpMode !== undefined ? { lacpMode } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* display vsi  (lista)                                                */
/* ------------------------------------------------------------------ */

export interface ParsedVsiListEntry {
  name: string;
  state: 'UP' | 'DOWN' | null;
}

export interface ParsedVsiList {
  complete: boolean;
  vsis: ParsedVsiListEntry[];
}

/**
 * Homologado em NE8000 F1A-8H20Q (VRP 8.220 V800R022C00SPC600) APENAS para o caso vazio:
 * comando aceito, eco + prompt e nenhum outro conteudo => lista completa e vazia.
 * O formato COM VSIs ainda nao foi observado em hardware: qualquer corpo nao vazio
 * devolve `complete=false` (INCONCLUSIVE) em vez de adivinhar colunas.
 */
export function parseVsiList(raw: string): ParsedVsiList {
  const text = clean(raw);
  if (MORE.test(text)) return { complete: false, vsis: [] };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Descarta o eco do comando e o prompt final; exige o prompt como ultima linha.
  const prompt = lines.at(-1);
  if (!prompt || !/^<[A-Za-z0-9_.:-]{1,120}>$/.test(prompt)) return { complete: false, vsis: [] };
  const body = lines.slice(0, -1).filter((l) => !/^(?:<[^>]+>)?display vsi$/i.test(l));
  if (body.length === 0) return { complete: true, vsis: [] };
  return { complete: false, vsis: [] };
}

/* ------------------------------------------------------------------ */
/* display vlan <id>                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedVlanPort {
  name: string;
  /** TG = tagged, UT = untagged, ST = vlan-stacking, MP = vlan-mapping (marcador da VRP que precede a porta). */
  tagging: 'TAGGED' | 'UNTAGGED' | 'STACKING' | 'MAPPING' | null;
  state: 'UP' | 'DOWN' | null;
}

export interface ParsedVlanInfo {
  complete: boolean;
  vlanId: number;
  /** false = o equipamento disse explicitamente que a VLAN nao existe. */
  exists: boolean | null;
  vlanType: string | null;
  status: 'ENABLE' | 'DISABLE' | null;
  description: string | null;
  ports: ParsedVlanPort[];
  /** MAC-LRN (aprendizado de MAC na VLAN), quando a tabela de propriedades o informa. */
  macLearning?: 'ENABLE' | 'DISABLE' | null;
  /** Encaminhamento de BC / MC / UC (FWD ou DSD = discard), quando informado. */
  forwarding?: { broadcast: 'FWD' | 'DSD'; multicast: 'FWD' | 'DSD'; unknownUnicast: 'FWD' | 'DSD' } | null;
}

const TAGGING: Record<string, ParsedVlanPort['tagging']> = { TG: 'TAGGED', UT: 'UNTAGGED', ST: 'STACKING', MP: 'MAPPING' };

/**
 * `display vlan <id>` (VRP S-series).
 *
 * Formato REAL observado no S6750-H36C YunShan V600R024C00SPC500 (2026-11-09):
 *   tabela 1 `VID  Ports`                       -> `3066  TG:Eth-Trunk1(U)`
 *   tabela 2 `VID Type Status Property MAC-LRN STAT BC MC UC Description`
 * Tambem aceita o formato VRP classico (`VID Type Ports` + `VID Status Property ...`).
 * Sem a linha da VLAN pedida na tabela de portas (ou a negacao explicita de existencia) a saida e
 * `complete=false`; nada e adivinhado.
 */
export function parseVlanInfo(raw: string, vlanId: number): ParsedVlanInfo {
  const text = clean(raw);
  const empty: ParsedVlanInfo = { complete: false, vlanId, exists: null, vlanType: null, status: null, description: null, ports: [] };
  if (MORE.test(text)) return empty;
  if (/does not exist|not exist|nonexistent/i.test(text)) return { ...empty, complete: true, exists: false };

  const lines = text.split('\n');
  const rowStart = new RegExp('^[ \\t]*' + vlanId + '[ \\t]+(\\S+)[ \\t]*(.*)$');
  const headerIdx = lines.findIndex((l) => /^\s*VID\s+(?:Type\s+)?Ports/i.test(l));
  if (headerIdx < 0) return empty;
  const hasTypeColumn = /^\s*VID\s+Type\s+Ports/i.test(lines[headerIdx]!);
  let i = lines.findIndex((l, k) => k > headerIdx && rowStart.test(l));
  if (i < 0) return empty;
  const first = rowStart.exec(lines[i]!)!;
  const portText: string[] = [hasTypeColumn ? (first[2] ?? '') : `${first[1] ?? ''} ${first[2] ?? ''}`];
  for (i = i + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*$/.test(l) || /^-{5,}/.test(l) || /^\s*VID\b/.test(l) || /^\s*\d+\s+\S+/.test(l)) break;
    portText.push(l);
  }
  const ports: ParsedVlanPort[] = [];
  let tagging: ParsedVlanPort['tagging'] = null;
  for (const token of portText.join(' ').split(/\s+/).filter(Boolean)) {
    let t = token;
    const marker = /^(TG|UT|ST|MP):(.*)$/.exec(t);
    if (marker) {
      tagging = TAGGING[marker[1]!] ?? null;
      t = marker[2]!;
      if (!t) continue;
    }
    const port = /^([A-Za-z][A-Za-z0-9-]*\d(?:[\d/]*\d)?(?:\.\d+)?)\((U|D)\)$/.exec(t);
    if (port) ports.push({ name: port[1]!, tagging, state: port[2] === 'U' ? 'UP' : 'DOWN' });
  }

  let vlanType = hasTypeColumn ? first[1]!.toLowerCase() : null;
  let status: ParsedVlanInfo['status'] = null;
  let description: string | null = null;
  let macLearning: ParsedVlanInfo['macLearning'] = null;
  let forwarding: ParsedVlanInfo['forwarding'] = null;

  // Tabela de propriedades (formato YunShan): VID Type Status Property MAC-LRN STAT BC MC UC Description
  const propIdx = lines.findIndex((l) => /^\s*VID\s+Type\s+Status/i.test(l));
  if (propIdx >= 0) {
    const row = new RegExp(
      '^[ \\t]*' + vlanId + '[ \\t]+(\\S+)[ \\t]+(enable|disable)[ \\t]+(\\S+)[ \\t]+(enable|disable)[ \\t]+(enable|disable)[ \\t]+(FWD|DSD)[ \\t]+(FWD|DSD)[ \\t]+(FWD|DSD)[ \\t]*(.*)$',
      'i',
    );
    for (const l of lines.slice(propIdx + 1)) {
      const m = row.exec(l);
      if (!m) continue;
      vlanType = m[1]!.toLowerCase();
      status = m[2]!.toUpperCase() as 'ENABLE' | 'DISABLE';
      macLearning = m[4]!.toUpperCase() as 'ENABLE' | 'DISABLE';
      forwarding = { broadcast: m[6]!.toUpperCase() as 'FWD' | 'DSD', multicast: m[7]!.toUpperCase() as 'FWD' | 'DSD', unknownUnicast: m[8]!.toUpperCase() as 'FWD' | 'DSD' };
      description = m[9]!.trim() || null;
      break;
    }
  } else {
    // Formato VRP classico: VID Status Property MAC-LRN Statistics Description
    const statusIdx = lines.findIndex((l) => /^\s*VID\s+Status/i.test(l));
    if (statusIdx >= 0) {
      const sRow = lines
        .slice(statusIdx + 1)
        .map((l) => new RegExp('^[ \\t]*' + vlanId + '[ \\t]+(enable|disable)\\b[ \\t]*(.*)$', 'i').exec(l))
        .find(Boolean);
      if (sRow) {
        status = sRow[1]!.toUpperCase() as 'ENABLE' | 'DISABLE';
        description = sRow[2]!.trim().split(/\s{2,}|\s+/).at(-1) ?? null;
      }
    }
  }
  return { complete: true, vlanId, exists: true, vlanType, status, description, ports, macLearning, forwarding };
}
