import { parseHuaweiAdvertisedRoutes } from '../huawei-bgp-advertised-routes-parser';
import {
  ipPrefixListPermits,
  ipv4ToInt,
  MITIGATION_RT,
  parseIpPrefixEntries,
  PERMANENT_CLIENT_RT,
  type IpPrefixEntry,
  type MitigationNode2Contract,
} from './mitigation-node2-contract';
import { policyNodes } from './mitigation-policy-clauses';

/**
 * VERIFICACAO FISICA POS-ESCRITA (somente leitura, fail-closed).
 *
 * O read-back de `display route-policy` so prova o TEXTO da policy. Esta camada
 * prova o EFEITO no BGP, apenas com `display`:
 *
 *  - cada prefixo elegivel recebido do peer do cliente continua best/select pelo
 *    proprio peer, com a LP do contrato, com RT 660 e SEM a RT 140;
 *  - os prefixos chegam ao peer de mitigacao (descoberto pela configuracao, nunca
 *    fixo no codigo): `display bgp routing-table peer <P> advertised-routes`;
 *  - o peer do cliente segue Established e com o mesmo numero de rotas recebidas;
 *  - prefixos fora da lista nao mudam.
 *
 * Resultado: PASS (unico que permite `MITIGATION_VERIFIED`), FAIL (evidencia
 * contraria) ou INCONCLUSIVE (timeout, parsing ambiguo, descoberta ambigua,
 * propagacao nao observada). FAIL e INCONCLUSIVE viram
 * `MITIGATION_UNVERIFIED_PHYSICAL`: nunca sucesso e SEM rollback automatico.
 */

export const PHYSICAL_UNVERIFIED_STATUS = 'ACTIVATED_UNVERIFIED_PHYSICAL';
export const PHYSICAL_UNVERIFIED_EVENT = 'MITIGATION_UNVERIFIED_PHYSICAL';

export type PhysicalOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface DisplayRead {
  command: string;
  output: string | null;
}

/** Leitura READ-ONLY de varios `display` numa unica sessao (ja validados pelo transporte). */
export type DisplayReader = (commands: string[]) => Promise<DisplayRead[]>;

export interface PhysicalBeforeEvidence {
  capturedAt: string;
  peers: Array<{ peer: string; verbose: string | null; received: string | null }>;
}

export interface PhysicalCheck {
  id: string;
  outcome: PhysicalOutcome;
  detail: string;
}

export interface MitigationPhysicalVerification {
  outcome: PhysicalOutcome;
  summary: string;
  checks: PhysicalCheck[];
  attempts: number;
  elapsedMs: number;
  mitigationPeer: string | null;
  eligiblePrefixes: string[];
  customerPeers: string[];
}

export interface PhysicalVerificationTiming {
  /** Tentativas maximas de observar a propagacao. */
  maxAttempts: number;
  /** Intervalo curto entre tentativas. */
  intervalMs: number;
  /** Limite TOTAL (todas as tentativas). */
  budgetMs: number;
}

export const DEFAULT_PHYSICAL_TIMING: PhysicalVerificationTiming = Object.freeze({
  maxAttempts: 6,
  intervalMs: 4_000,
  budgetMs: 28_000,
});

/** Teto de prefixos consultados individualmente (acima disto a prova e inconclusiva). */
const MAX_ELIGIBLE_PREFIXES = 16;
const OUTSIDE_SAMPLE = 3;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export function isIpv4Literal(value: string): boolean {
  return IPV4.test(value);
}

// ---------------------------------------------------------------------------
// Comandos (os unicos de leitura desta camada; o transporte valida o mesmo conjunto)
// ---------------------------------------------------------------------------

export function peerVerboseCommand(peer: string): string {
  return `display bgp peer ${peer} verbose`;
}
export function receivedRoutesCommand(peer: string): string {
  return `display bgp routing-table peer ${peer} received-routes`;
}
export function advertisedRoutesCommand(peer: string): string {
  return `display bgp routing-table peer ${peer} advertised-routes`;
}
export function routingTableCommand(prefix: string): string {
  const [network, length] = prefix.split('/');
  return `display bgp routing-table ${network} ${length}`;
}
export const EXTCOMMUNITY_FILTER_COMMAND = 'display ip extcommunity-filter';
export const BGP_CONFIGURATION_COMMAND = 'display current-configuration configuration bgp';
export const ROUTE_POLICY_CONFIGURATION_COMMAND =
  'display current-configuration configuration route-policy';

/**
 * Allowlist ESTRITA dos `display` desta verificacao. Qualquer outro comando e
 * rejeitado antes de tocar o SSH.
 */
export function isMitigationEvidenceCommand(command: string): boolean {
  if (typeof command !== 'string' || /[\r\n;&|`$<>]/.test(command)) return false;
  const ip = '(?:\\d{1,3}\\.){3}\\d{1,3}';
  const patterns = [
    new RegExp(`^display bgp peer ${ip} verbose$`),
    new RegExp(`^display bgp routing-table peer ${ip} received-routes$`),
    new RegExp(`^display bgp routing-table peer ${ip} advertised-routes$`),
    new RegExp(`^display bgp routing-table ${ip} (?:[0-9]|[12][0-9]|3[0-2])$`),
    /^display ip extcommunity-filter$/,
    /^display current-configuration configuration bgp$/,
    /^display current-configuration configuration route-policy$/,
  ];
  if (!patterns.some((pattern) => pattern.test(command))) return false;
  return command
    .split(' ')
    .filter((token) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(token))
    .every((token) => IPV4.test(token));
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parsePeerVerbose(output: string | null): {
  state: string | null;
  receivedTotal: number | null;
} {
  if (!output) return { state: null, receivedTotal: null };
  const state = /BGP current state:\s*([A-Za-z]+)/i.exec(output)?.[1] ?? null;
  const total = /Received total routes:\s*(\d+)/i.exec(output)?.[1];
  return { state, receivedTotal: total === undefined ? null : Number(total) };
}

export interface RoutingTablePath {
  prefix: string;
  from: string | null;
  localPreference: number | null;
  extCommunities: string[];
  best: boolean;
  select: boolean;
}

/** `display bgp routing-table <net> <len>`: um bloco por caminho. */
export function parseRoutingTableEntry(output: string | null): RoutingTablePath[] | null {
  if (!output) return null;
  const paths: RoutingTablePath[] = [];
  let current: RoutingTablePath | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const header =
      /BGP routing table entry information of (\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})/i.exec(line);
    if (header) {
      current = {
        prefix: header[1]!,
        from: null,
        localPreference: null,
        extCommunities: [],
        best: false,
        select: false,
      };
      paths.push(current);
      continue;
    }
    if (!current) continue;
    const from = /^From:\s*(\d{1,3}(?:\.\d{1,3}){3})\b/i.exec(line);
    if (from) {
      current.from = from[1]!;
      continue;
    }
    const ext = /^Ext-Community:\s*(.*)$/i.exec(line);
    if (ext) {
      for (const match of ext[1]!.matchAll(/RT\s*<\s*(\d+)\s*:\s*(\d+)\s*>/gi)) {
        current.extCommunities.push(`${match[1]}:${match[2]}`);
      }
      continue;
    }
    if (/^AS-path\b/i.test(line)) {
      const tokens = line.split(',').map((token) => token.trim().toLowerCase());
      const lp = /\blocalpref\s+(\d+)/i.exec(line);
      current.localPreference = lp ? Number(lp[1]) : null;
      current.best = tokens.includes('best');
      current.select = tokens.includes('select');
    }
  }
  return paths.length > 0 ? paths : null;
}

export interface ExtcommunityFilterEntry {
  action: 'permit' | 'deny';
  rt: string | null;
}

/** `display ip extcommunity-filter`: nome ou numero -> entradas. */
export function parseExtcommunityFilters(
  output: string | null,
): Map<string, ExtcommunityFilterEntry[]> {
  const filters = new Map<string, ExtcommunityFilterEntry[]>();
  if (!output) return filters;
  let current: ExtcommunityFilterEntry[] | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const numbered = /^Extended Community filter Number\s+(\d+)\s*$/i.exec(line);
    const named = /^Named Extended Community (?:basic|advanced) filter:\s*(\S+)\s*$/i.exec(line);
    if (numbered || named) {
      current = [];
      filters.set((numbered?.[1] ?? named?.[1])!, current);
      continue;
    }
    if (!current) continue;
    const entry = /^index:\s*\d+\s+(permit|deny)\s+(.*)$/i.exec(line);
    if (!entry) continue;
    const rt = /\brt\s*:\s*(\d+:\d+)/i.exec(entry[2]!);
    current.push({ action: entry[1]!.toLowerCase() as 'permit' | 'deny', rt: rt?.[1] ?? null });
  }
  return filters;
}

export interface MitigationPeerDiscovery {
  /** Peer unico de mitigacao; `null` = ausente ou ambiguo (resultado inconclusivo). */
  peer: string | null;
  candidates: string[];
  detail: string;
}

/**
 * Descobre, pela CONFIGURACAO, o peer ao qual a RT de mitigacao e anunciada:
 *  1. filtros de extcommunity com `permit rt 268568:660`;
 *  2. policies cujo PRIMEIRO node generico (somente esse filtro) e `permit`
 *     (um `deny` primeiro, como nos exports SEABORN/SEMPRE, exclui a policy);
 *  3. peers IPv4 unicast com `route-policy <policy> export`.
 * Zero ou mais de um peer => ambiguo.
 */
export function discoverMitigationPeer(input: {
  bgpConfiguration: string | null;
  routePolicyConfiguration: string | null;
  extcommunityFilterOutput: string | null;
  rt?: string;
}): MitigationPeerDiscovery {
  const rt = input.rt ?? MITIGATION_RT;
  if (
    !input.bgpConfiguration ||
    !input.routePolicyConfiguration ||
    !input.extcommunityFilterOutput
  ) {
    return { peer: null, candidates: [], detail: 'leitura de configuracao incompleta' };
  }
  const filters = parseExtcommunityFilters(input.extcommunityFilterOutput);
  const mitigationFilters = new Set(
    [...filters.entries()]
      .filter(([, entries]) =>
        entries.some((entry) => entry.action === 'permit' && entry.rt === rt),
      )
      .map(([name]) => name),
  );
  if (mitigationFilters.size === 0) {
    return { peer: null, candidates: [], detail: `nenhum extcommunity-filter permite a RT ${rt}` };
  }
  const policyNames = new Set<string>();
  for (const line of input.routePolicyConfiguration.split(/\r?\n/)) {
    const match = /^route-policy (\S+) (?:permit|deny) node \d+\s*$/i.exec(line.trim());
    if (match) policyNames.add(match[1]!);
  }
  const exporting = new Set<string>();
  for (const policy of policyNames) {
    const nodes = policyNodes(input.routePolicyConfiguration, policy).sort(
      (a, b) => a.node - b.node,
    );
    for (const node of nodes) {
      const conditions = node.clauses.filter((clause) => /^if-match\b/i.test(clause));
      const filterClause =
        conditions.length === 1
          ? /^if-match extcommunity-filter (\S+)$/i.exec(conditions[0]!)
          : null;
      if (!filterClause || !mitigationFilters.has(filterClause[1]!)) continue;
      if (node.action === 'permit') exporting.add(policy);
      break;
    }
  }
  const peers = new Set<string>();
  const ambiguous: string[] = [];
  let family: string | null = null;
  for (const raw of input.bgpConfiguration.split(/\r?\n/)) {
    const header = /^\s*(ipv4|ipv6)-family\s+(\S+)/i.exec(raw);
    if (header) {
      family = `${header[1]!.toLowerCase()}-${header[2]!.toLowerCase()}`;
      continue;
    }
    if (raw.trim().length > 0 && !/^\s/.test(raw)) {
      family = null;
      continue;
    }
    const exportLine = /^\s*peer\s+(\S+)\s+route-policy\s+(\S+)\s+export\s*$/i.exec(raw);
    if (!exportLine || family !== 'ipv4-unicast' || !exporting.has(exportLine[2]!)) continue;
    if (isIpv4Literal(exportLine[1]!)) peers.add(exportLine[1]!);
    else ambiguous.push(exportLine[1]!);
  }
  const candidates = [...peers].sort();
  if (ambiguous.length > 0) {
    return {
      peer: null,
      candidates,
      detail: `export de mitigacao em peer-group/endereco nao IPv4 [${ambiguous.join(', ')}]: descoberta ambigua`,
    };
  }
  if (candidates.length !== 1) {
    return {
      peer: null,
      candidates,
      detail:
        candidates.length === 0
          ? `nenhum peer IPv4 exporta por policy que permite a RT ${rt}`
          : `descoberta ambigua: ${candidates.length} peers [${candidates.join(', ')}]`,
    };
  }
  return {
    peer: candidates[0]!,
    candidates,
    detail: `peer de mitigacao ${candidates[0]} (export por filtro ${[...mitigationFilters].join(', ')})`,
  };
}

// ---------------------------------------------------------------------------
// Captura PRE e verificacao POS
// ---------------------------------------------------------------------------

export function beforeEvidenceCommands(peers: readonly string[]): string[] {
  return peers.flatMap((peer) => [peerVerboseCommand(peer), receivedRoutesCommand(peer)]);
}

export async function captureBeforeEvidence(
  read: DisplayReader,
  peers: readonly string[],
  now: () => Date = () => new Date(),
): Promise<PhysicalBeforeEvidence> {
  const reads = await read(beforeEvidenceCommands(peers));
  const byCommand = new Map(reads.map((entry) => [entry.command, entry.output]));
  return {
    capturedAt: now().toISOString(),
    peers: peers.map((peer) => ({
      peer,
      verbose: byCommand.get(peerVerboseCommand(peer)) ?? null,
      received: byCommand.get(receivedRoutesCommand(peer)) ?? null,
    })),
  };
}

function parseReceived(output: string | null): {
  prefixes: Map<string, number | null>;
  reportedTotal: number | null;
} | null {
  if (!output) return null;
  const parsed = parseHuaweiAdvertisedRoutes(output, { localAs: null, addressFamily: 'IPV4' });
  const total = /Total Number of Routes:\s*(\d+)/i.exec(output)?.[1];
  const reportedTotal = total === undefined ? parsed.reportedTotal : Number(total);
  // Linhas nao interpretadas => leitura ambigua (nunca "sem rotas").
  if (reportedTotal !== null && parsed.routes.length !== reportedTotal) return null;
  if (reportedTotal === null && parsed.routes.length === 0) return null;
  return {
    prefixes: new Map(parsed.routes.map((route) => [route.prefix, route.localPreference])),
    reportedTotal,
  };
}

function splitPrefix(prefix: string): { network: number; length: number } | null {
  const [address, length] = prefix.split('/');
  const network = ipv4ToInt(address ?? '');
  const len = Number(length);
  if (network === null || !Number.isInteger(len) || len < 0 || len > 32) return null;
  return { network, length: len };
}

export interface VerifyPhysicalInput {
  read: DisplayReader;
  contract: MitigationNode2Contract;
  customerPeers: readonly string[];
  before: PhysicalBeforeEvidence | null;
  timing?: PhysicalVerificationTiming;
  sleep?: (ms: number) => Promise<void>;
  /** Relogio monotonico (ms). */
  clock?: () => number;
}

function aggregate(checks: readonly PhysicalCheck[]): PhysicalOutcome {
  if (checks.some((check) => check.outcome === 'FAIL')) return 'FAIL';
  if (checks.some((check) => check.outcome === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'PASS';
}

export async function verifyMitigationPhysical(
  input: VerifyPhysicalInput,
): Promise<MitigationPhysicalVerification> {
  const timing = input.timing ?? DEFAULT_PHYSICAL_TIMING;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const clock = input.clock ?? (() => performance.now());
  const started = clock();
  const customerPeers = [...input.customerPeers];
  const base = {
    mitigationPeer: null as string | null,
    eligiblePrefixes: [] as string[],
    customerPeers,
  };
  const finish = (
    outcome: PhysicalOutcome,
    checks: PhysicalCheck[],
    attempts: number,
    extra: Partial<typeof base> = {},
  ): MitigationPhysicalVerification => ({
    outcome,
    checks,
    attempts,
    elapsedMs: Math.max(0, Math.round(clock() - started)),
    ...base,
    ...extra,
    summary:
      outcome === 'PASS'
        ? `verificacao fisica PASS (${checks.length} checks, ${attempts} tentativa(s))`
        : `verificacao fisica ${outcome}: ${checks
            .filter((check) => check.outcome !== 'PASS')
            .map((check) => `${check.id}: ${check.detail}`)
            .join('; ')}`,
  });
  const inconclusive = (id: string, detail: string) =>
    finish('INCONCLUSIVE', [{ id, outcome: 'INCONCLUSIVE', detail }], 0);

  if (customerPeers.length === 0)
    return inconclusive('customer_peer', 'perfil sem peer do cliente');
  if (customerPeers.some((peer) => !isIpv4Literal(peer))) {
    return inconclusive(
      'customer_peer',
      'peer do cliente nao IPv4: verificacao fisica nao suportada',
    );
  }
  if (!input.before || input.before.peers.length !== customerPeers.length) {
    return inconclusive(
      'before_evidence',
      'evidencia PRE-escrita (peer/rotas recebidas) indisponivel',
    );
  }
  const entries: IpPrefixEntry[] | null = parseIpPrefixEntries(
    input.contract.prefixListEntries.join('\n'),
    input.contract.prefixList,
  );
  if (!entries || entries.length === 0) {
    return inconclusive('prefix_list', 'entradas da prefix-list do contrato indisponiveis');
  }

  // PRE: prefixos recebidos por peer, elegiveis x fora da lista.
  const beforeByPeer = new Map<
    string,
    { total: number | null; prefixes: Map<string, number | null>; reportedTotal: number | null }
  >();
  for (const item of input.before.peers) {
    const received = parseReceived(item.received);
    if (!received) {
      return inconclusive(
        `before_received:${item.peer}`,
        'rotas recebidas PRE-escrita ilegiveis/incompletas',
      );
    }
    const verbose = parsePeerVerbose(item.verbose);
    if (verbose.state !== 'Established') {
      return inconclusive(
        `before_peer:${item.peer}`,
        `peer ${item.peer} nao estava Established antes da escrita (${verbose.state ?? 'estado desconhecido'})`,
      );
    }
    beforeByPeer.set(item.peer, {
      total: verbose.receivedTotal,
      prefixes: received.prefixes,
      reportedTotal: received.reportedTotal,
    });
  }
  const eligible: Array<{ peer: string; prefix: string }> = [];
  const outside: Array<{ peer: string; prefix: string }> = [];
  for (const [peer, data] of beforeByPeer) {
    for (const prefix of data.prefixes.keys()) {
      const split = splitPrefix(prefix);
      if (split && ipPrefixListPermits(entries, split)) eligible.push({ peer, prefix });
      else outside.push({ peer, prefix });
    }
  }
  const eligiblePrefixes = eligible.map((item) => item.prefix);
  if (eligible.length === 0) {
    return finish(
      'INCONCLUSIVE',
      [
        {
          id: 'eligible_prefixes',
          outcome: 'INCONCLUSIVE',
          detail: `nenhum prefixo recebido do peer casa com ${input.contract.prefixList}: efeito nao comprovavel`,
        },
      ],
      0,
    );
  }
  if (eligible.length > MAX_ELIGIBLE_PREFIXES) {
    return finish(
      'INCONCLUSIVE',
      [
        {
          id: 'eligible_prefixes',
          outcome: 'INCONCLUSIVE',
          detail: `${eligible.length} prefixos elegiveis excedem o limite de ${MAX_ELIGIBLE_PREFIXES} consultas`,
        },
      ],
      0,
      { eligiblePrefixes },
    );
  }

  // Descoberta do peer de mitigacao (leituras frescas, uma vez).
  const discoveryReads = await input
    .read([
      BGP_CONFIGURATION_COMMAND,
      ROUTE_POLICY_CONFIGURATION_COMMAND,
      EXTCOMMUNITY_FILTER_COMMAND,
    ])
    .catch(() => [] as DisplayRead[]);
  const discovered = new Map(discoveryReads.map((entry) => [entry.command, entry.output]));
  const discovery = discoverMitigationPeer({
    bgpConfiguration: discovered.get(BGP_CONFIGURATION_COMMAND) ?? null,
    routePolicyConfiguration: discovered.get(ROUTE_POLICY_CONFIGURATION_COMMAND) ?? null,
    extcommunityFilterOutput: discovered.get(EXTCOMMUNITY_FILTER_COMMAND) ?? null,
  });
  const mitigationPeer = discovery.peer;

  const outsideSample = outside.slice(0, OUTSIDE_SAMPLE);
  const commands = [
    ...customerPeers.flatMap((peer) => [peerVerboseCommand(peer), receivedRoutesCommand(peer)]),
    ...eligible.map((item) => routingTableCommand(item.prefix)),
    ...outsideSample.map((item) => routingTableCommand(item.prefix)),
    ...(mitigationPeer ? [advertisedRoutesCommand(mitigationPeer)] : []),
  ];
  const uniqueCommands = [...new Set(commands)];

  let attempts = 0;
  let checks: PhysicalCheck[] = [];
  for (;;) {
    attempts += 1;
    let reads: DisplayRead[] = [];
    try {
      reads = await input.read(uniqueCommands);
    } catch {
      reads = [];
    }
    const outputs = new Map(reads.map((entry) => [entry.command, entry.output]));
    checks = evaluate({
      contract: input.contract,
      customerPeers,
      beforeByPeer,
      eligible,
      outsideSample,
      outsideAll: outside,
      mitigationPeer,
      discoveryDetail: discovery.detail,
      outputs,
    });
    if (aggregate(checks) === 'PASS') break;
    const elapsed = clock() - started;
    if (attempts >= timing.maxAttempts || elapsed + timing.intervalMs > timing.budgetMs) break;
    await sleep(timing.intervalMs);
  }
  return finish(aggregate(checks), checks, attempts, { mitigationPeer, eligiblePrefixes });
}

function evaluate(ctx: {
  contract: MitigationNode2Contract;
  customerPeers: readonly string[];
  beforeByPeer: Map<
    string,
    { total: number | null; prefixes: Map<string, number | null>; reportedTotal: number | null }
  >;
  eligible: Array<{ peer: string; prefix: string }>;
  outsideSample: Array<{ peer: string; prefix: string }>;
  outsideAll: Array<{ peer: string; prefix: string }>;
  mitigationPeer: string | null;
  discoveryDetail: string;
  outputs: Map<string, string | null>;
}): PhysicalCheck[] {
  const checks: PhysicalCheck[] = [];
  const unreadable = (command: string) =>
    ctx.outputs.get(command) === undefined || ctx.outputs.get(command) === null;

  for (const peer of ctx.customerPeers) {
    const before = ctx.beforeByPeer.get(peer)!;
    const verboseCmd = peerVerboseCommand(peer);
    if (unreadable(verboseCmd)) {
      checks.push({
        id: `peer:${peer}`,
        outcome: 'INCONCLUSIVE',
        detail: 'leitura do peer indisponivel',
      });
    } else {
      const verbose = parsePeerVerbose(ctx.outputs.get(verboseCmd)!);
      if (verbose.state === null) {
        checks.push({
          id: `peer:${peer}`,
          outcome: 'INCONCLUSIVE',
          detail: 'estado do peer ilegivel',
        });
      } else if (verbose.state !== 'Established') {
        checks.push({
          id: `peer:${peer}`,
          outcome: 'FAIL',
          detail: `peer ${peer} deixou de estar Established (${verbose.state})`,
        });
      } else if (verbose.receivedTotal === null || before.total === null) {
        checks.push({
          id: `peer:${peer}`,
          outcome: 'INCONCLUSIVE',
          detail: 'total de rotas recebidas ilegivel',
        });
      } else if (verbose.receivedTotal !== before.total) {
        checks.push({
          id: `peer:${peer}`,
          outcome: 'FAIL',
          detail: `rotas recebidas de ${peer}: ${before.total} antes x ${verbose.receivedTotal} depois`,
        });
      } else {
        checks.push({
          id: `peer:${peer}`,
          outcome: 'PASS',
          detail: `Established, ${verbose.receivedTotal} rotas recebidas (igual ao pre)`,
        });
      }
    }
    const receivedCmd = receivedRoutesCommand(peer);
    const after = parseReceived(ctx.outputs.get(receivedCmd) ?? null);
    if (!after) {
      checks.push({
        id: `outside:${peer}`,
        outcome: 'INCONCLUSIVE',
        detail: 'rotas recebidas POS-escrita ilegiveis/incompletas',
      });
    } else {
      const changed = ctx.outsideAll
        .filter((item) => item.peer === peer)
        .filter(
          (item) =>
            !after.prefixes.has(item.prefix) ||
            after.prefixes.get(item.prefix) !== before.prefixes.get(item.prefix),
        );
      checks.push(
        changed.length === 0
          ? { id: `outside:${peer}`, outcome: 'PASS', detail: 'prefixos fora da lista inalterados' }
          : {
              id: `outside:${peer}`,
              outcome: 'FAIL',
              detail: `prefixos fora da lista alterados: ${changed.map((item) => item.prefix).join(', ')}`,
            },
      );
    }
  }

  for (const item of ctx.outsideSample) {
    const command = routingTableCommand(item.prefix);
    const paths = parseRoutingTableEntry(ctx.outputs.get(command) ?? null);
    if (!paths) {
      checks.push({
        id: `outside_route:${item.prefix}`,
        outcome: 'INCONCLUSIVE',
        detail: 'rota ilegivel',
      });
      continue;
    }
    const mine = paths.filter((path) => path.from === item.peer);
    if (mine.some((path) => path.extCommunities.includes(MITIGATION_RT))) {
      checks.push({
        id: `outside_route:${item.prefix}`,
        outcome: 'FAIL',
        detail: `prefixo fora da lista recebeu a RT ${MITIGATION_RT}`,
      });
    } else {
      checks.push({
        id: `outside_route:${item.prefix}`,
        outcome: 'PASS',
        detail: 'sem RT de mitigacao',
      });
    }
  }

  const advertisedCmd = ctx.mitigationPeer ? advertisedRoutesCommand(ctx.mitigationPeer) : null;
  for (const item of ctx.eligible) {
    const id = `route:${item.prefix}`;
    const paths = parseRoutingTableEntry(ctx.outputs.get(routingTableCommand(item.prefix)) ?? null);
    if (!paths) {
      checks.push({
        id,
        outcome: 'INCONCLUSIVE',
        detail: 'saida de routing-table ausente/ilegivel',
      });
      continue;
    }
    const own = paths.find((path) => path.from === item.peer && path.prefix === item.prefix);
    if (!own) {
      checks.push({
        id,
        outcome: 'FAIL',
        detail: `nenhum caminho do peer ${item.peer} para ${item.prefix}`,
      });
      continue;
    }
    const problems: string[] = [];
    if (!own.best || !own.select) problems.push('caminho do peer nao e best/select');
    if (own.localPreference !== ctx.contract.localPreference) {
      problems.push(
        `localpref ${own.localPreference ?? '?'} (esperado ${ctx.contract.localPreference})`,
      );
    }
    if (!own.extCommunities.includes(MITIGATION_RT)) problems.push(`sem RT ${MITIGATION_RT}`);
    if (own.extCommunities.includes(PERMANENT_CLIENT_RT))
      problems.push(`RT ${PERMANENT_CLIENT_RT} ainda presente`);
    checks.push(
      problems.length === 0
        ? {
            id,
            outcome: 'PASS',
            detail: `best/select, localpref ${own.localPreference}, RT ${MITIGATION_RT}`,
          }
        : { id, outcome: 'FAIL', detail: problems.join(', ') },
    );
  }

  if (!ctx.mitigationPeer || advertisedCmd === null) {
    checks.push({ id: 'advertised', outcome: 'INCONCLUSIVE', detail: ctx.discoveryDetail });
  } else if (unreadable(advertisedCmd)) {
    checks.push({
      id: 'advertised',
      outcome: 'INCONCLUSIVE',
      detail: 'advertised-routes indisponivel',
    });
  } else {
    const parsed = parseHuaweiAdvertisedRoutes(ctx.outputs.get(advertisedCmd)!, {
      localAs: null,
      addressFamily: 'IPV4',
    });
    const advertised = new Set(parsed.routes.map((route) => route.prefix));
    if (parsed.routes.length === 0 && parsed.reportedTotal !== 0) {
      checks.push({
        id: 'advertised',
        outcome: 'INCONCLUSIVE',
        detail: 'advertised-routes ilegivel',
      });
    } else {
      const missing = ctx.eligible
        .map((item) => item.prefix)
        .filter((prefix) => !advertised.has(prefix));
      checks.push(
        missing.length === 0
          ? {
              id: 'advertised',
              outcome: 'PASS',
              detail: `${ctx.eligible.length} prefixo(s) anunciado(s) ao peer ${ctx.mitigationPeer}`,
            }
          : {
              id: 'advertised',
              outcome: 'FAIL',
              detail: `nao anunciados a ${ctx.mitigationPeer}: ${missing.join(', ')}`,
            },
      );
    }
  }
  return checks;
}
