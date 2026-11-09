import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DisplayRead } from '../infrastructure/bgp/mitigation/mitigation-physical-verification';

/**
 * TEST-ONLY: simulador dos `display` BGP de evidencia fisica.
 *
 * As saidas de base (peer verbose, received-routes e routing-table dos tres prefixos AGLINK) sao a
 * captura REAL e sanitizada do BHE-VTA-F1A-BGP-01 (`__fixtures__/real-aglink`); as configuracoes
 * BGP/route-policy/extcommunity-filter usadas na descoberta do peer de mitigacao tambem. Somente a
 * transformacao "mitigacao ativa" (RT 660 no lugar da 140, caminho do peer continua best/select com
 * LP 1100, anuncio ao peer de mitigacao) e SINTETICA - nao e evidencia fisica.
 */

const DIR = new URL('../infrastructure/bgp/mitigation/__fixtures__/real-aglink/', import.meta.url);
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, DIR)), 'utf-8');

export const REAL_ROUTE_POLICY_CONFIG = read('route-policy.cfg');
export const REAL_BGP_CONFIG = read('bgp-peers.cfg');
export const REAL_EXTCOMMUNITY_FILTER = read('extcommunity-filter.txt');
const DISPLAYS = JSON.parse(read('aglink-displays.json')) as Record<string, string>;

export const SIM_CUSTOMER_PEER = '10.200.201.2';
export const SIM_MITIGATION_PEER = '198.19.4.145';
export const SIM_ELIGIBLE = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];

export type PhysicalSimMode =
  | 'ok'
  | 'wrong-lp'
  | 'rt140'
  | 'not-best'
  | 'not-advertised'
  | 'peer-down'
  | 'count-changed'
  | 'garbled-routing'
  | 'unreadable'
  | 'ambiguous-peer'
  | 'no-mitigation-peer'
  | 'outside-changed'
  | 'outside-rt660'
  /** Peer cai e volta dentro da janela com as mesmas rotas (Peer Up count aumenta). */
  | 'flap'
  /** O prefixo ja era anunciado ao peer de mitigacao ANTES da escrita (sessao paralela). */
  | 'already-advertised';

export class PhysicalBgpSimulator {
  mode: PhysicalSimMode = 'ok';
  /** Prefixos recebidos que NAO casam com a lista do cliente (normalmente zero). */
  outside: string[] = [];
  /** Leituras de routing-table que ainda mostram o estado ANTERIOR apos a escrita. */
  propagationDelayAttempts = 0;
  /** Se `false`, o transporte nao implementa a leitura (INCONCLUSIVO). */
  readonly batches: string[][] = [];
  private attempts = 0;

  constructor(private readonly mitigated: () => boolean) {}

  private propagated(): boolean {
    return this.mitigated() && this.attempts > this.propagationDelayAttempts;
  }

  private verbose(): string {
    let text = DISPLAYS[`display bgp peer ${SIM_CUSTOMER_PEER} verbose`]!;
    const total = SIM_ELIGIBLE.length + this.outside.length;
    text = text.replace(/Received total routes: \d+/, `Received total routes: ${total}`);
    if (this.mode === 'peer-down' && this.mitigated()) {
      text = text.replace('BGP current state: Established', 'BGP current state: Active');
    }
    if (this.mode === 'flap' && this.mitigated()) {
      text = text.replace(
        /BGP Peer Up count:\s*(\d+)/,
        (_m, n: string) => `BGP Peer Up count: ${Number(n) + 1}`,
      );
    }
    if (this.mode === 'count-changed' && this.mitigated()) {
      text = text.replace(/Received total routes: \d+/, `Received total routes: ${total - 1}`);
    }
    return text;
  }

  private received(): string {
    let text = DISPLAYS[`display bgp routing-table peer ${SIM_CUSTOMER_PEER} received-routes`]!;
    const extra = this.outside
      .map(
        (prefix) =>
          ` *>     ${prefix.padEnd(18)} ${SIM_CUSTOMER_PEER}                   0          1100       0      273811i`,
      )
      .join('\r\n');
    if (this.outside.length > 0) {
      text = text.replace(
        /Total Number of Routes: \d+/,
        `Total Number of Routes: ${3 + this.outside.length}`,
      );
      text = text.replace(/(\r\n)$/, `\r\n${extra}\r\n`);
    }
    if (this.mode === 'outside-changed' && this.mitigated() && this.outside.length > 0) {
      const marker = this.outside[0]!;
      text = text
        .split('\r\n')
        .map((line) => (line.includes(marker) ? line.replace('1100', '100 ') : line))
        .join('\r\n');
    }
    return text;
  }

  private routing(prefix: string): string {
    const [network, length] = prefix.split('/');
    const key = `display bgp routing-table ${network} ${length}`;
    let text: string = DISPLAYS[key] ?? '';
    const isOutside = DISPLAYS[key] === undefined;
    if (isOutside) {
      text = [
        ' ',
        ' BGP local router ID : 45.163.144.1',
        ' Local AS number : 268568',
        ' Paths:   1 available, 1 best, 1 select, 0 best-external, 0 add-path',
        ` BGP routing table entry information of ${prefix}:`,
        ` From: ${SIM_CUSTOMER_PEER} (167.250.126.0)`,
        ' Route Duration: 1d22h01m38s',
        ` Original nexthop: ${SIM_CUSTOMER_PEER}`,
        ' Ext-Community: RT <268568 : 140>, RT <268568 : 330>',
        ' AS-path 273811, origin igp, MED 0, localpref 1100, pref-val 0, valid, external, best, select, pre 255',
        '',
      ].join('\r\n');
    }
    if (!this.propagated()) return text;
    if (isOutside) {
      return this.mode === 'outside-rt660'
        ? text.replace('RT <268568 : 140>, RT <268568 : 330>', 'RT <268568 : 660>')
        : text;
    }
    // Estado MITIGADO do caminho do peer do cliente (primeiro bloco, "From: <peer>").
    const blocks = text.split(/\r?\n(?= BGP routing table entry information of )/);
    const own = blocks.findIndex((block) => block.includes(`From: ${SIM_CUSTOMER_PEER}`));
    if (own < 0) return text;
    let block = blocks[own]!;
    if (this.mode === 'rt140') {
      block = block.replace(
        'RT <268568 : 140>, RT <268568 : 330>',
        'RT <268568 : 140>, RT <268568 : 660>',
      );
    } else {
      block = block.replace('RT <268568 : 140>, RT <268568 : 330>', 'RT <268568 : 660>');
    }
    if (this.mode === 'wrong-lp') block = block.replace('localpref 1100', 'localpref 100');
    if (this.mode === 'not-best') block = block.replace(', best, select', ', backup');
    blocks[own] = block;
    return blocks.join('\r\n');
  }

  private advertised(): string {
    const header = [
      ' ',
      ' BGP Local router ID is 45.163.144.1',
      ' Status codes: * - valid, > - best, d - damped, x - best external, a - add path,',
      '               h - history,  i - internal, s - suppressed, S - Stale',
      '               Origin : i - IGP, e - EGP, ? - incomplete',
      ' RPKI validation codes: V - valid, I - invalid, N - not-found',
      '',
      '',
    ];
    const base = ['45.163.144.0/22', '45.168.200.0/22'];
    const shown =
      this.mode === 'already-advertised' || (this.propagated() && this.mode !== 'not-advertised')
        ? [...base, ...SIM_ELIGIBLE]
        : base;
    return [
      ...header,
      ` Total Number of Routes: ${shown.length}`,
      '        Network            NextHop                       MED        LocPrf    PrefVal Path/Ogn',
      '',
      ...shown.map(
        (prefix) =>
          ` *>     ${prefix.padEnd(18)} 172.20.0.1                                           0      268568i`,
      ),
      '',
    ].join('\r\n');
  }

  async read(commands: string[]): Promise<DisplayRead[]> {
    this.batches.push([...commands]);
    if (commands.some((command) => /^display bgp routing-table \d/.test(command))) {
      this.attempts += 1;
    }
    return commands.map((command) => ({ command, output: this.output(command) }));
  }

  private output(command: string): string | null {
    if (command === 'display current-configuration configuration bgp') {
      // Descoberta ambigua/ausente so APOS a escrita (antes dela o export e provado no preflight).
      if (this.mode === 'ambiguous-peer' && this.mitigated()) {
        return REAL_BGP_CONFIG.replace(
          /(\s+peer 198\.19\.4\.145 route-policy PL-COMPUTIZE-IPv4-OUT export)/,
          '$1\n  peer 198.19.4.146 route-policy PL-COMPUTIZE-IPv4-OUT export',
        );
      }
      if (this.mode === 'no-mitigation-peer' && this.mitigated()) {
        return REAL_BGP_CONFIG.replace(
          /\s+peer 198\.19\.4\.145 route-policy PL-COMPUTIZE-IPv4-OUT export/,
          '',
        );
      }
      return REAL_BGP_CONFIG;
    }
    if (command === 'display current-configuration configuration route-policy') {
      return REAL_ROUTE_POLICY_CONFIG;
    }
    if (command === 'display ip extcommunity-filter') return REAL_EXTCOMMUNITY_FILTER;
    if (command === `display bgp peer ${SIM_CUSTOMER_PEER} verbose`) return this.verbose();
    if (command === `display bgp routing-table peer ${SIM_CUSTOMER_PEER} received-routes`) {
      return this.received();
    }
    if (command === `display bgp routing-table peer ${SIM_MITIGATION_PEER} advertised-routes`) {
      return this.advertised();
    }
    const routing = /^display bgp routing-table (\S+) (\d+)$/.exec(command);
    if (routing) {
      if (this.mode === 'unreadable') return null;
      if (this.mode === 'garbled-routing') return 'Error: wrong parameter found at ^ position.';
      return this.routing(`${routing[1]}/${routing[2]}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simulador GENERICO (qualquer policy/peer/lista): saidas montadas por modelo, sem fixture real.
// Usado pelos testes que ja tinham um SSH falso proprio e so precisam de evidencia fisica coerente.
// ---------------------------------------------------------------------------

import {
  deriveMitigationNode2Contract,
  parseIpPrefixEntries,
} from '../infrastructure/bgp/mitigation/mitigation-node2-contract';

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

export interface GenericPhysicalOptions {
  policyName: string;
  customerPeers: string[];
  /** Configuracao atual da policy (config ou display) e das ip-prefix. */
  routePolicy: () => string;
  prefixLists: () => string;
  /** A mitigacao esta aplicada no equipamento (node 2 presente)? */
  mitigated: () => boolean;
  mitigationPeer?: string;
}

export class GenericPhysicalDisplays {
  mode: 'ok' | 'wrong-lp' | 'unreadable' = 'ok';
  readonly batches: string[][] = [];

  constructor(private readonly options: GenericPhysicalOptions) {}

  private model() {
    const derived = deriveMitigationNode2Contract(
      this.options.routePolicy(),
      this.options.policyName,
      {
        prefixListConfiguration: this.options.prefixLists(),
      },
    );
    if (!derived.eligible) return null;
    const entries =
      parseIpPrefixEntries(this.options.prefixLists(), derived.contract.prefixList) ?? [];
    const prefixes = entries.map((entry) => `${intToIpv4(entry.network)}/${entry.length}`);
    return { contract: derived.contract, prefixes };
  }

  async read(commands: string[]): Promise<DisplayRead[]> {
    this.batches.push([...commands]);
    const model = this.model();
    const mitigated = this.options.mitigated();
    const mitigationPeer = this.options.mitigationPeer ?? SIM_MITIGATION_PEER;
    return commands.map((command) => {
      const clean = cleanExportDisplay(command);
      if (clean !== undefined) return { command, output: clean };
      if (!model || this.mode === 'unreadable') return { command, output: null };
      const verbose = /^display bgp peer (\S+) verbose$/.exec(command);
      if (verbose) {
        return {
          command,
          output: DISPLAYS[`display bgp peer ${SIM_CUSTOMER_PEER} verbose`]!.replace(
            /Received total routes: \d+/,
            `Received total routes: ${model.prefixes.length}`,
          ),
        };
      }
      const received = /^display bgp routing-table peer (\S+) received-routes$/.exec(command);
      if (received) {
        const rows = model.prefixes.map(
          (prefix) =>
            ` *>     ${prefix.padEnd(18)} ${received[1]}                   0          ${model.contract.localPreference}       0      64500i`,
        );
        return {
          command,
          output: [
            ' ',
            ' BGP Local router ID is 45.163.144.1',
            '',
            `${' Total Number of Routes: '}${rows.length}`,
            '        Network            NextHop                       MED        LocPrf    PrefVal Path/Ogn',
            '',
            ...rows,
            '',
          ].join('\r\n'),
        };
      }
      const advertised = /^display bgp routing-table peer (\S+) advertised-routes$/.exec(command);
      if (advertised) {
        const shown = mitigated ? model.prefixes : ['45.163.144.0/22'];
        const rows = shown.map(
          (prefix) =>
            ` *>     ${prefix.padEnd(18)} 172.20.0.1                                           0      268568i`,
        );
        return {
          command,
          output: [
            ' ',
            ` Total Number of Routes: ${rows.length}`,
            '        Network            NextHop                       MED        LocPrf    PrefVal Path/Ogn',
            '',
            ...rows,
            '',
          ].join('\r\n'),
        };
      }
      const routing = /^display bgp routing-table (\S+) (\d+)$/.exec(command);
      if (routing) {
        const prefix = `${routing[1]}/${routing[2]}`;
        const peer = this.options.customerPeers[0]!;
        const lp = this.mode === 'wrong-lp' && mitigated ? 100 : model.contract.localPreference;
        const rt = mitigated ? 'RT <268568 : 660>' : 'RT <268568 : 140>, RT <268568 : 330>';
        return {
          command,
          output: [
            ' ',
            ' BGP local router ID : 45.163.144.1',
            ' Local AS number : 268568',
            ' Paths:   1 available, 1 best, 1 select, 0 best-external, 0 add-path',
            ` BGP routing table entry information of ${prefix}:`,
            ` From: ${peer} (167.250.126.0)`,
            ` Ext-Community: ${rt}`,
            ` AS-path 64500, origin igp, MED 0, localpref ${lp}, pref-val 0, valid, external, best, select, pre 255`,
            '',
          ].join('\r\n'),
        };
      }
      void mitigationPeer;
      return { command, output: null };
    });
  }
}

// ---------------------------------------------------------------------------
// Export "limpo" minimo (testes com SSH falso proprio) e listas sinteticas do export real
// ---------------------------------------------------------------------------

export const CLEAN_EXPORT_BGP_CONFIG = [
  'bgp 268568',
  ' ipv4-family unicast',
  `  peer ${SIM_MITIGATION_PEER} route-policy PL-MIT-OUT export`,
  '#',
].join('\n');
export const CLEAN_EXPORT_ROUTE_POLICY = [
  'route-policy PL-MIT-OUT permit node 300',
  ' if-match extcommunity-filter MITIGACAO',
  '#',
].join('\n');
export const CLEAN_EXPORT_EXTCOMMUNITY_FILTER = [
  'Named Extended Community basic filter: MITIGACAO',
  '    index: 10            permit     rt : 268568:660',
].join('\n');

/** Saida dos 3 `display` de configuracao para um export sem nenhum deny anterior. */
export function cleanExportDisplay(command: string): string | undefined {
  if (command === 'display current-configuration configuration bgp') return CLEAN_EXPORT_BGP_CONFIG;
  if (command === 'display current-configuration configuration route-policy') {
    return CLEAN_EXPORT_ROUTE_POLICY;
  }
  if (command === 'display ip extcommunity-filter') return CLEAN_EXPORT_EXTCOMMUNITY_FILTER;
  return undefined;
}

/** Leitor de displays para SSH falsos que so precisam do export limpo (preflight). */
export async function cleanExportDisplayRead(
  _device: unknown,
  commands: readonly string[],
): Promise<Array<{ command: string; output: string | null }>> {
  return commands.map((command) => ({ command, output: cleanExportDisplay(command) ?? null }));
}

/**
 * ip-prefix SINTETICO para as listas citadas pelo export REAL (PL-COMPUTIZE-IPv4-OUT): a
 * captura real nao traz as definicoes. Nomes `PREFIX-A.B.C-L` viram A.B.C.0/L; os demais
 * recebem um /24 distinto em 100.64.0.0/10. NAO e evidencia fisica.
 */
export function syntheticExportPrefixLists(): string {
  const names = new Set<string>();
  let inExport = false;
  for (const line of REAL_ROUTE_POLICY_CONFIG.split(/\r?\n/)) {
    const header = /^route-policy (\S+) /.exec(line);
    if (header) inExport = header[1] === 'PL-COMPUTIZE-IPv4-OUT';
    const match = inExport ? /if-match ip-prefix (\S+)/.exec(line) : null;
    if (match) names.add(match[1]!);
  }
  let index = 0;
  const lines: string[] = [];
  for (const name of [...names].sort()) {
    if (['BOGONS', 'PREFIX8to24', 'default-route'].includes(name)) continue;
    const m = /^PREFIX-(\d+\.\d+\.\d+)-(\d+)$/.exec(name);
    lines.push(
      m
        ? `ip ip-prefix ${name} index 10 permit ${m[1]}.0 ${m[2]}`
        : `ip ip-prefix ${name} index 10 permit 100.64.${(index += 1)}.0 24`,
    );
  }
  return lines.join('\n');
}

/**
 * ip-prefix SINTETICO para TODAS as listas citadas pela config real (cada uma ganha um /24
 * distinto em 100.64.0.0/10, exceto `PREFIX-A.B.C-L` que vira A.B.C.0/L). Serve a matriz de
 * elegibilidade: nao ha sobreposicao acidental entre listas de nomes diferentes. NAO e
 * evidencia fisica (a captura real nao traz as definicoes).
 */
export function syntheticAllPrefixLists(): string {
  const names = new Set<string>();
  for (const match of REAL_ROUTE_POLICY_CONFIG.matchAll(/if-match ip-prefix (\S+)/g)) {
    names.add(match[1]!);
  }
  let index = 0;
  const lines: string[] = [];
  for (const name of [...names].sort()) {
    if (['BOGONS', 'PREFIX8to24', 'default-route'].includes(name)) continue;
    const m = /^PREFIX-(\d+\.\d+\.\d+)-(\d+)$/.exec(name);
    index += 1;
    lines.push(
      m
        ? `ip ip-prefix ${name} index 10 permit ${m[1]}.0 ${m[2]}`
        : `ip ip-prefix ${name} index 10 permit 100.${64 + Math.floor(index / 250)}.${index % 250}.0 24`,
    );
  }
  return lines.join('\n');
}

/** Leitor de displays que serve a config REAL (export da COMPUTIZE etc.) ao preflight. */
export async function realConfigDisplayRead(
  _device: unknown,
  commands: readonly string[],
): Promise<Array<{ command: string; output: string | null }>> {
  return commands.map((command) => ({
    command,
    output:
      command === 'display current-configuration configuration bgp'
        ? REAL_BGP_CONFIG
        : command === 'display current-configuration configuration route-policy'
          ? REAL_ROUTE_POLICY_CONFIG
          : command === 'display ip extcommunity-filter'
            ? REAL_EXTCOMMUNITY_FILTER
            : null,
  }));
}
