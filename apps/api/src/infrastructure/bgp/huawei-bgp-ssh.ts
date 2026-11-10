import { AsyncLocalStorage } from 'node:async_hooks';
import type { BgpAddressFamily, BgpAdminAction, HostRecord } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import {
  parseHuaweiRoutePolicyNodes,
  parseHuaweiRoutePolicyNodesLenient,
} from './mitigation/huawei-bgp-policy-parser';
import type { HostRepository } from '../persistence/host-repository';
import { assertReadOnlyCommand } from '../../worker/mitigation/read-only-command-guard';
import { isMitigationEvidenceCommand } from './mitigation/mitigation-physical-verification';
import { SshClientImpl } from '../ssh/ssh-client-impl';
import type { BgpRouteCommandResult } from './bgp-interface-correlation';
import {
  isAdminIgnoredCliState,
  mergeHuaweiBgpPeerDetails,
  parseHuaweiBgpLocalAs,
  parseHuaweiBgpPeerSummary,
  parseHuaweiBgpPeerVerbose,
  parseHuaweiPeerAdminConfig,
  type ParsedHuaweiBgpPeer,
} from './huawei-bgp-ssh-parser';

interface BgpSshClientOptions {
  port: number;
  username: string;
  password: string;
  contextCommand?: string | null;
  exitMode?: 'quit' | 'return-quit';
  shellTimeoutMs?: number;
  abortOnInteractivePrompt?: boolean;
  abortOnCommandError?: boolean;
  requirePromptCompletion?: boolean;
}

export type BgpSshClientFactory = (options: BgpSshClientOptions) => SshClient;

export interface HuaweiBgpSshDiscovery {
  peers: ParsedHuaweiBgpPeer[];
  routeCommands: ReadonlyMap<string, BgpRouteCommandResult>;
  verboseUsed: boolean;
  /** Local ASN of the BGP process in the configured SSH context, when known. */
  localAs: bigint | null;
  /** True when the context exposes more than one BGP process. */
  localAsAmbiguous: boolean;
  /** False when `display bgp ipv6 peer` is unsupported on this device. */
  ipv6Supported: boolean;
  warnings: string[];
}

export interface BgpAdminStateReading {
  state: 'IGNORED' | 'ENABLED' | 'UNKNOWN';
  source: 'CONFIGURATION' | 'PEER_STATE' | null;
}

export interface BgpAdminApplyResult {
  success: boolean;
  errorSafe: string | null;
}

/**
 * Outcome of the on-demand advertised-routes read.
 *
 * `UNSUPPORTED` is deliberately separate from `COMMAND_FAILED`: a VRP
 * version/platform may not implement the requested variant (typically the
 * IPv6 one), and the operator deserves that distinction instead of a generic
 * SSH error — or, worse, an empty table that looks like "no routes".
 */
export type BgpAdvertisedRoutesReadResult =
  | { status: 'SUCCESS'; output: string }
  | { status: 'UNSUPPORTED' | 'COMMAND_FAILED'; errorSafe: string };

/** Read-only commands per address family (IPv4 and IPv6 output never mix). */
function peerSummaryCommand(addressFamily: BgpAddressFamily): string {
  return addressFamily === 'IPV6' ? 'display bgp ipv6 peer' : 'display bgp peer';
}

function peerVerboseCommand(addressFamily: BgpAddressFamily): string {
  return addressFamily === 'IPV6' ? 'display bgp ipv6 peer verbose' : 'display bgp peer verbose';
}

function routeLookupCommand(addressFamily: BgpAddressFamily, peerAddress: string): string {
  return addressFamily === 'IPV6'
    ? `display ipv6 routing-table ${peerAddress}`
    : `display ip routing-table ${peerAddress}`;
}

function adminConfigCommand(peerAddress: string): string {
  return `display current-configuration configuration bgp | include peer ${peerAddress}`;
}

/**
 * Read-only, peer-scoped advertised routes. The peer address always comes from
 * the persisted peer — never from a request body — and the command runs in the
 * device's user view, so no `system-view`/`bgp <asn>` is entered.
 */
function advertisedRoutesCommand(addressFamily: BgpAddressFamily, peerAddress: string): string {
  return addressFamily === 'IPV6'
    ? `display bgp ipv6 routing-table peer ${peerAddress} advertised-routes`
    : `display bgp routing-table peer ${peerAddress} advertised-routes`;
}

/**
 * Read-only, peer-scoped RECEIVED routes: what the customer announces to us.
 * Same constraints as the advertised read — the address comes from the persisted
 * peer and the command runs in user view.
 */
function receivedRoutesCommand(addressFamily: BgpAddressFamily, peerAddress: string): string {
  return addressFamily === 'IPV6'
    ? `display bgp ipv6 routing-table peer ${peerAddress} received`
    : `display bgp routing-table peer ${peerAddress} received`;
}

function safeSshError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('interactive_prompt')) return 'SSH interactive prompt blocked';
  if (message.includes('prompt_not_confirmed')) return 'SSH prompt not confirmed';
  if (message.includes('command_rejected')) return 'SSH command rejected by device';
  if (message.includes('auth')) return 'SSH authentication failed';
  if (message.includes('timeout')) return 'SSH connection timeout';
  if (message.includes('unreachable') || message.includes('refused')) {
    return 'SSH host is unreachable';
  }
  return 'SSH command failed';
}

/**
 * O `SshClientImpl` real roda os comandos num shell interativo e devolve UM unico
 * `CommandResult` com o stdout da sessao inteira (nao um por comando). Separa a saida de
 * cada comando pelo eco `<PROMPT>comando`, na ordem enviada; cada trecho vai do eco
 * (inclusive) ate a proxima linha que comeca com o mesmo prompt (exclusive).
 *
 * O prompt e aprendido do eco do PRIMEIRO comando (o `screen-length` da sessao). Prompt nao
 * reconhecido, eco ausente ou fora de ordem => TODOS `null` (inconclusivo): nunca atribui a
 * um comando a saida de outro. Formato confirmado no BHE-VTA-F1A-BGP-01 (VRP) em 10/11/2026.
 */
export function splitHuaweiSessionOutput(
  stdout: string,
  commands: readonly string[],
): Array<string | null> {
  const none = commands.map(() => null);
  if (commands.length === 0) return [];
  const promptPattern = /^<[A-Za-z0-9_.:-]{1,120}>/;
  const lines = stdout.replace(/\r/g, '').split('\n');
  const first = commands[0]!;
  const promptLine = lines.find((line) => {
    const text = line.trimEnd();
    return promptPattern.test(text) && text.endsWith(`>${first}`);
  });
  if (!promptLine) return none;
  const prompt = promptPattern.exec(promptLine)![0];
  const echoes: number[] = [];
  let from = 0;
  for (const command of commands) {
    let found = -1;
    for (let index = from; index < lines.length; index += 1) {
      if (lines[index]!.trimEnd() === `${prompt}${command}`) {
        found = index;
        break;
      }
    }
    if (found < 0) return none;
    echoes.push(found);
    from = found + 1;
  }
  return echoes.map((start) => {
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (lines[index]!.startsWith(prompt)) {
        end = index;
        break;
      }
    }
    return lines.slice(start, end).join('\n');
  });
}

function commandOutputError(output: string): boolean {
  return /(?:unrecognized\s+command|wrong\s+parameter|incomplete\s+command|error\s*:)/i.test(
    output,
  );
}

/** True when the device rejected the command itself (not a transient failure). */
function unsupportedCommandOutput(output: string): boolean {
  return /(?:unrecognized\s+command|wrong\s+parameter|incomplete\s+command|too\s+many\s+parameters)/i.test(
    output,
  );
}

function needsVerbose(peers: ParsedHuaweiBgpPeer[]): boolean {
  return peers.some(
    (peer) =>
      peer.remoteAs === null ||
      peer.state === null ||
      (peer.state === 'ESTABLISHED' && peer.sessionUptimeSeconds === null),
  );
}

// Leitura agregada (read-only) da configuracao necessaria ao discovery de mitigacao:
// o processo BGP e as definicoes de route-policy do device. `null` significa "nao foi
// possivel ler" - nunca "vazio".
export interface HuaweiBgpConfigReading {
  bgpConfiguration: string | null;
  routePolicyConfiguration: string | null;
  warnings: string[];
}

/**
 * One READ-ONLY snapshot of equipment state (four concurrent short sessions), taken once per AUTO activation attempt.
 * Every field is the output of the SAME display command the individual reads issue.
 */
export interface ActivationReadSnapshot {
  routePolicyConfiguration: string | null;
  prefixListConfiguration: string | null;
  bgpConfiguration: string | null;
  routePolicyDisplay: string | null;
}
/** A snapshot is only valid inside the current attempt and never longer than this. */
const ACTIVATION_SNAPSHOT_MAX_AGE_MS = 15_000;

interface ActivationReadScope {
  deviceId: string;
  policyName: string;
  snapshot: Promise<ActivationReadSnapshot> | null;
  /** Monotonic time (ms) when the snapshot completed; a snapshot older than the limit is never served. */
  takenAt: number | null;
  /** Closed at the first write: every later read hits the equipment again (read-back). */
  closed: boolean;
}

export class HuaweiBgpSshService {
  constructor(
    private readonly repository: HostRepository,
    private readonly clientFactory: BgpSshClientFactory = (options) => new SshClientImpl(options),
  ) {}

  private readonly activationScope = new AsyncLocalStorage<ActivationReadScope>();

  /**
   * Runs one AUTO activation attempt with ONE shared read-only SSH snapshot. Inside the scope the
   * pre-write reads (route-policy display, mitigation configuration, BGP configuration) are served
   * from one concurrent snapshot instead of a sequence of sessions (the same reads repeated). The scope closes at the first write, so
   * the read-back after the write always reads the equipment. Freshness and gates are unchanged:
   * the data is the output of the same commands, taken seconds before the checks that use it.
   */
  withActivationReadScope<T>(
    scope: { deviceId: string; policyName: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.activationScope.run({ ...scope, snapshot: null, takenAt: null, closed: false }, fn);
  }

  private scopedSnapshot(
    device: HostRecord,
    policyName?: string,
  ): Promise<ActivationReadSnapshot> | null {
    const scope = this.activationScope.getStore();
    if (!scope || scope.closed || scope.deviceId !== device.id) return null;
    if (policyName !== undefined && policyName !== scope.policyName) return null;
    if (
      scope.takenAt !== null &&
      performance.now() - scope.takenAt > ACTIVATION_SNAPSHOT_MAX_AGE_MS
    )
      return Promise.reject(new Error('ACTIVATION_SNAPSHOT_EXPIRED'));
    scope.snapshot ??= this.readActivationSnapshot(device, scope.policyName).then((snapshot) => {
      scope.takenAt = performance.now();
      return snapshot;
    });
    return scope.snapshot;
  }

  /**
   * Closes the activation read scope of the current attempt: every later read hits the equipment.
   * Called by the lifecycle authorization (immediately before the write path) and by any write.
   */
  closeActivationReadScope(): void {
    const scope = this.activationScope.getStore();
    if (scope) scope.closed = true;
  }

  /**
   * READ-ONLY: the four pre-write reads of an activation, issued CONCURRENTLY (one short session
   * each, exactly the commands and the strict per-command checks of the individual reads), so the
   * wall time is the slowest single read instead of the sum of all of them.
   */
  async readActivationSnapshot(
    device: HostRecord,
    policyName: string,
  ): Promise<ActivationReadSnapshot> {
    const client = await this.createClient(device);
    const host = device.ssh!.host;
    const screenLength = assertReadOnlyCommand('screen-length 0 temporary');
    const read = (command: string) =>
      this.executeStrict(client, host, [screenLength, assertReadOnlyCommand(command)]);
    const [
      routePolicyConfiguration,
      prefixListConfiguration,
      bgpConfiguration,
      routePolicyDisplay,
    ] = await Promise.all([
      read('display current-configuration configuration route-policy'),
      read('display current-configuration | include ip-prefix'),
      read('display current-configuration configuration bgp'),
      read(`display route-policy ${policyName}`),
    ]);
    // Fail-closed: a snapshot is all-or-nothing. A single failed read, or two reads of the same
    // policy that disagree, invalidates the whole attempt (never a partial or contradictory view).
    if (
      routePolicyConfiguration === null ||
      prefixListConfiguration === null ||
      bgpConfiguration === null ||
      routePolicyDisplay === null
    )
      throw new Error('ACTIVATION_SNAPSHOT_INCOMPLETE');
    const signature = (nodes: Array<{ node: number; action: string }> | undefined) =>
      (nodes ?? [])
        .map((n) => `${n.node}:${n.action}`)
        .sort()
        .join(',');
    const fromConfiguration = signature(
      parseHuaweiRoutePolicyNodes(routePolicyConfiguration).get(policyName),
    );
    const fromDisplay = signature(
      parseHuaweiRoutePolicyNodesLenient(routePolicyDisplay).get(policyName),
    );
    if (fromConfiguration !== fromDisplay) throw new Error('ACTIVATION_SNAPSHOT_CONTRADICTORY');
    return {
      routePolicyConfiguration,
      prefixListConfiguration,
      bgpConfiguration,
      routePolicyDisplay,
    };
  }

  async discover(device: HostRecord): Promise<HuaweiBgpSshDiscovery> {
    const client = await this.createClient(device);
    const host = device.ssh!.host;
    const warnings: string[] = [];

    // The local ASN is learned inside the configured SSH context (virtual
    // system), because one physical device can host several BGP processes.
    const localAsReading = await this.learnLocalAs(client, host);

    const summaryOutput = await this.executeRequired(client, host, peerSummaryCommand('IPV4'));
    let peers = parseHuaweiBgpPeerSummary(summaryOutput, 'IPV4');
    let verboseUsed = false;
    if (peers.length && needsVerbose(peers)) {
      try {
        const verboseOutput = await this.executeRequired(client, host, peerVerboseCommand('IPV4'));
        peers = mergeHuaweiBgpPeerDetails(peers, parseHuaweiBgpPeerVerbose(verboseOutput, 'IPV4'));
        verboseUsed = true;
      } catch {
        // Verbose is optional enrichment. Valid summary peers remain discoverable.
      }
    }

    // IPv6 degrades in isolation: an unsupported command must never break the
    // IPv4 discovery of the same device.
    let ipv6Supported = true;
    try {
      const ipv6Summary = await this.executeRequired(client, host, peerSummaryCommand('IPV6'));
      let ipv6Peers = parseHuaweiBgpPeerSummary(ipv6Summary, 'IPV6');
      if (ipv6Peers.length && needsVerbose(ipv6Peers)) {
        try {
          const ipv6Verbose = await this.executeRequired(client, host, peerVerboseCommand('IPV6'));
          ipv6Peers = mergeHuaweiBgpPeerDetails(
            ipv6Peers,
            parseHuaweiBgpPeerVerbose(ipv6Verbose, 'IPV6'),
          );
          verboseUsed = true;
        } catch {
          // Optional IPv6 enrichment.
        }
      }
      peers = [...peers, ...ipv6Peers];
    } catch (error) {
      ipv6Supported = false;
      warnings.push(
        `IPv6: ${safeSshError(error)}. Sessões IPv6 não foram atualizadas neste discovery.`,
      );
    }

    const routeCommands = new Map<string, BgpRouteCommandResult>();
    for (const peer of peers) {
      try {
        const output = await this.executeRequired(
          client,
          host,
          routeLookupCommand(peer.addressFamily, peer.peerAddress),
        );
        routeCommands.set(peer.peerAddress, { status: 'SUCCESS', output });
      } catch (error) {
        routeCommands.set(peer.peerAddress, {
          status: 'COMMAND_FAILED',
          error: safeSshError(error),
        });
      }
    }

    return {
      peers,
      routeCommands,
      verboseUsed,
      localAs: localAsReading.localAs,
      localAsAmbiguous: localAsReading.ambiguous,
      ipv6Supported,
      warnings,
    };
  }

  /**
   * Applies `peer <addr> ignore` / `undo peer <addr> ignore` inside the BGP
   * process of the device context. The caller owns the human confirmation and
   * the mandatory read-back.
   *
   * `system-view` is included because every VRP command that changes the BGP
   * process is a system-view command: the SSH session starts in user view and
   * re-entering system view is harmless when the account already starts there.
   * The optional SSH context command is injected by the transport right after
   * `screen-length 0 temporary`, i.e. still in user view, before `system-view`.
   */
  async applyAdminState(
    device: HostRecord,
    input: { peerAddress: string; localAs: bigint; action: BgpAdminAction },
  ): Promise<BgpAdminApplyResult> {
    const client = await this.createClient(device);
    const peerCommand = `${
      input.action === 'DISABLE' ? '' : 'undo '
    }peer ${input.peerAddress} ignore`;
    const output = await this.executeStrict(client, device.ssh!.host, [
      'screen-length 0 temporary',
      'system-view',
      `bgp ${input.localAs.toString()}`,
      peerCommand,
      'commit',
    ]);
    return output === null
      ? { success: false, errorSafe: 'SSH command failed' }
      : { success: true, errorSafe: null };
  }

  /**
   * On-demand read of the routes announced to one peer. Read-only: no
   * configuration is changed and nothing is persisted by this layer.
   *
   * The optional `sshContextCommand` of the device is applied by the SSH
   * transport exactly like every other read, so a virtual-system context keeps
   * working without this method knowing about it.
   */
  async readAdvertisedRoutes(
    device: HostRecord,
    input: { peerAddress: string; addressFamily: BgpAddressFamily },
  ): Promise<BgpAdvertisedRoutesReadResult> {
    let client: SshClient;
    try {
      client = await this.createClient(device);
    } catch (error) {
      return { status: 'COMMAND_FAILED', errorSafe: safeSshError(error) };
    }

    const host = device.ssh!.host;
    const command = advertisedRoutesCommand(input.addressFamily, input.peerAddress);
    try {
      const results = await client.execute(host, ['screen-length 0 temporary', command]);
      const result = results.at(-1);
      if (!result || result.exitCode !== 0) {
        return { status: 'COMMAND_FAILED', errorSafe: 'SSH command failed' };
      }
      if (unsupportedCommandOutput(result.stdout)) {
        return {
          status: 'UNSUPPORTED',
          errorSafe: 'O equipamento não reconheceu o comando de anúncios nesta família.',
        };
      }
      if (commandOutputError(result.stdout)) {
        return { status: 'COMMAND_FAILED', errorSafe: 'SSH command failed' };
      }
      return { status: 'SUCCESS', output: result.stdout };
    } catch (error) {
      return { status: 'COMMAND_FAILED', errorSafe: safeSshError(error) };
    }
  }

  /**
   * Read-only, peer-scoped RECEIVED routes (`display bgp routing-table peer
   * <peer> received`). Mirrors `readAdvertisedRoutes`: no configuration, nothing
   * persisted, command validated by the READ-ONLY allowlist before the session.
   */
  async readReceivedRoutes(
    device: HostRecord,
    input: { peerAddress: string; addressFamily: BgpAddressFamily },
  ): Promise<BgpAdvertisedRoutesReadResult> {
    let client: SshClient;
    try {
      client = await this.createClient(device);
    } catch (error) {
      return { status: 'COMMAND_FAILED', errorSafe: safeSshError(error) };
    }

    const host = device.ssh!.host;
    let command: string;
    try {
      command = assertReadOnlyCommand(
        receivedRoutesCommand(input.addressFamily, input.peerAddress),
      );
    } catch {
      return {
        status: 'COMMAND_FAILED',
        errorSafe: 'Comando de rotas recebidas rejeitado pela allowlist READ-ONLY',
      };
    }
    try {
      const results = await client.execute(host, ['screen-length 0 temporary', command]);
      const result = results.at(-1);
      if (!result || result.exitCode !== 0) {
        return { status: 'COMMAND_FAILED', errorSafe: 'SSH command failed' };
      }
      if (unsupportedCommandOutput(result.stdout)) {
        return {
          status: 'UNSUPPORTED',
          errorSafe: 'O equipamento não reconheceu o comando de rotas recebidas nesta família.',
        };
      }
      if (commandOutputError(result.stdout)) {
        return { status: 'COMMAND_FAILED', errorSafe: 'SSH command failed' };
      }
      return { status: 'SUCCESS', output: result.stdout };
    } catch (error) {
      return { status: 'COMMAND_FAILED', errorSafe: safeSshError(error) };
    }
  }

  /**
   * Deterministic read-back of the administrative state. The peer-filtered
   * configuration is the primary source; when the device does not support the
   * filter, the peer state column (`Idle(Admin)`) is used as a secondary,
   * still read-only, confirmation.
   */
  async readAdminState(
    device: HostRecord,
    input: { peerAddress: string; addressFamily: BgpAddressFamily },
  ): Promise<BgpAdminStateReading> {
    const client = await this.createClient(device);
    const configOutput = await this.executeStrict(client, device.ssh!.host, [
      'screen-length 0 temporary',
      adminConfigCommand(input.peerAddress),
    ]);
    if (configOutput !== null) {
      const state = parseHuaweiPeerAdminConfig(configOutput, input.peerAddress);
      if (state) return { state, source: 'CONFIGURATION' };
    }

    const stateOutput = await this.executeStrict(client, device.ssh!.host, [
      'screen-length 0 temporary',
      peerSummaryCommand(input.addressFamily),
    ]);
    if (stateOutput === null) return { state: 'UNKNOWN', source: null };
    const peer = parseHuaweiBgpPeerSummary(stateOutput, input.addressFamily).find(
      (candidate) => candidate.peerAddress === input.peerAddress,
    );
    if (!peer) return { state: 'UNKNOWN', source: null };
    return {
      state: isAdminIgnoredCliState(peer.cliStateToken) ? 'IGNORED' : 'ENABLED',
      source: 'PEER_STATE',
    };
  }

  // READ-ONLY: dump agregado da configuracao BGP + route-policy do device.
  //
  // Uma leitura por device (nunca por peer) para o discovery de mitigacao montar
  // o mapa peer -> policy IN e policy -> nodes localmente, sem carga extra no NE.
  // Todo comando passa pelo read-only guard antes de chegar ao SSH.
  async readBgpConfiguration(device: HostRecord): Promise<HuaweiBgpConfigReading> {
    const warnings: string[] = [];
    const scoped = this.scopedSnapshot(device);
    if (scoped) {
      try {
        const snapshot = await scoped;
        if (snapshot.bgpConfiguration === null) warnings.push('BGP: SSH command failed');
        if (snapshot.routePolicyConfiguration === null)
          warnings.push('route-policy: SSH command failed');
        return {
          bgpConfiguration: snapshot.bgpConfiguration,
          routePolicyConfiguration: snapshot.routePolicyConfiguration,
          warnings,
        };
      } catch (error) {
        return {
          bgpConfiguration: null,
          routePolicyConfiguration: null,
          warnings: [safeSshError(error)],
        };
      }
    }

    let client: SshClient;
    try {
      client = await this.createClient(device);
    } catch (error) {
      return {
        bgpConfiguration: null,
        routePolicyConfiguration: null,
        warnings: [safeSshError(error)],
      };
    }

    const host = device.ssh!.host;
    const screenLength = assertReadOnlyCommand('screen-length 0 temporary');
    const bgpCommand = assertReadOnlyCommand('display current-configuration configuration bgp');
    const routePolicyCommand = assertReadOnlyCommand(
      'display current-configuration configuration route-policy',
    );

    const bgpConfiguration = await this.executeStrict(client, host, [screenLength, bgpCommand]);
    if (bgpConfiguration === null) warnings.push('BGP: SSH command failed');

    const routePolicyConfiguration = await this.executeStrict(client, host, [
      screenLength,
      routePolicyCommand,
    ]);
    if (routePolicyConfiguration === null) warnings.push('route-policy: SSH command failed');

    return { bgpConfiguration, routePolicyConfiguration, warnings };
  }

  /** READ-ONLY: route-policy + ip-prefix do device, base do preflight de escrita. */
  async readMitigationConfiguration(device: HostRecord): Promise<{
    routePolicyConfiguration: string | null;
    prefixListConfiguration: string | null;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const scoped = this.scopedSnapshot(device);
    if (scoped) {
      try {
        const snapshot = await scoped;
        if (snapshot.routePolicyConfiguration === null)
          warnings.push('route-policy: SSH command failed');
        if (snapshot.prefixListConfiguration === null)
          warnings.push('ip-prefix: SSH command failed');
        return {
          routePolicyConfiguration: snapshot.routePolicyConfiguration,
          prefixListConfiguration: snapshot.prefixListConfiguration,
          warnings,
        };
      } catch (error) {
        return {
          routePolicyConfiguration: null,
          prefixListConfiguration: null,
          warnings: [safeSshError(error)],
        };
      }
    }

    let client: SshClient;
    try {
      client = await this.createClient(device);
    } catch (error) {
      return {
        routePolicyConfiguration: null,
        prefixListConfiguration: null,
        warnings: [safeSshError(error)],
      };
    }

    const host = device.ssh!.host;
    const screenLength = assertReadOnlyCommand('screen-length 0 temporary');
    const routePolicyCommand = assertReadOnlyCommand(
      'display current-configuration configuration route-policy',
    );
    const prefixListCommand = assertReadOnlyCommand(
      'display current-configuration | include ip-prefix',
    );

    const routePolicyConfiguration = await this.executeStrict(client, host, [
      screenLength,
      routePolicyCommand,
    ]);
    if (routePolicyConfiguration === null) warnings.push('route-policy: SSH command failed');

    const prefixListConfiguration = await this.executeStrict(client, host, [
      screenLength,
      prefixListCommand,
    ]);
    if (prefixListConfiguration === null) warnings.push('ip-prefix: SSH command failed');

    return { routePolicyConfiguration, prefixListConfiguration, warnings };
  }

  /** READ-ONLY: dump textual da route-policy para o read-back obrigatorio. */
  async readMitigationRoutePolicy(device: HostRecord, policyName: string): Promise<string> {
    // O nome ja foi validado pela guarda de escrita antes de chegar aqui.
    const scoped = this.scopedSnapshot(device, policyName);
    if (scoped) {
      const output = (await scoped).routePolicyDisplay;
      if (output === null) throw new Error('SSH command failed');
      return output;
    }
    const command = assertReadOnlyCommand(`display route-policy ${policyName}`);
    const client = await this.createClient(device);
    const output = await this.executeStrict(client, device.ssh!.host, [
      'screen-length 0 temporary',
      command,
    ]);
    if (output === null) throw new Error('SSH command failed');
    return output;
  }

  /**
   * READ-ONLY: varios `display` de EVIDENCIA FISICA da mitigacao numa unica
   * sessao curta (peer verbose, received/advertised-routes, routing-table de um
   * prefixo, extcommunity-filter e as configuracoes BGP/route-policy). Cada
   * comando passa pelo guard read-only E pelo conjunto estrito desta verificacao
   * (somente esses `display`) antes de tocar o SSH.
   */
  async readMitigationDisplays(
    device: HostRecord,
    commands: readonly string[],
  ): Promise<Array<{ command: string; output: string | null }>> {
    const validated = commands.map((command) => {
      const normalized = assertReadOnlyCommand(command);
      if (!isMitigationEvidenceCommand(normalized)) {
        throw new Error('READ_ONLY_VIOLATION: comando fora do conjunto de evidencia fisica');
      }
      return normalized;
    });
    if (validated.length === 0) return [];
    const client = await this.createClient(device);
    const host = device.ssh!.host;
    const screenLength = assertReadOnlyCommand('screen-length 0 temporary');
    // UMA sessao (limite de VTYs do equipamento): os comandos rodam em sequencia e uma
    // falha isolada vira `output: null` (inconclusivo), nunca uma lista parcial.
    try {
      const sent = [screenLength, ...validated];
      const results = await client.execute(host, sent);
      let own: Array<{ stdout: string | null; exitCode: number }>;
      if (results.length === sent.length) {
        // Transporte com um resultado por comando.
        own = results
          .slice(1)
          .map((result) => ({ stdout: result.stdout, exitCode: result.exitCode }));
      } else if (results.length === 1) {
        // SshClientImpl real: UM resultado com o stdout da sessao inteira (shell interativo).
        const session = results[0]!;
        own = splitHuaweiSessionOutput(session.stdout, sent)
          .slice(1)
          .map((stdout) => ({ stdout, exitCode: session.exitCode }));
      } else {
        return validated.map((command) => ({ command, output: null }));
      }
      return validated.map((command, index) => {
        const result = own[index]!;
        const failed =
          result.stdout === null || result.exitCode !== 0 || commandOutputError(result.stdout);
        return { command, output: failed ? null : result.stdout };
      });
    } catch {
      return validated.map((command) => ({ command, output: null }));
    }
  }

  /**
   * ESCRITA da mitigacao manual. A lista chega JA canonica e validada pela guarda
   * de escrita; este metodo apenas a transporta e faz o commit.
   */
  async applyMitigationCommands(
    device: HostRecord,
    commands: readonly string[],
  ): Promise<{ ok: boolean; output: string | null }> {
    // Any write closes the activation read scope: the read-back must hit the equipment.
    this.closeActivationReadScope();
    // Sessao de ESCRITA: termina em system-view (apos o commit), entao precisa
    // de DOIS `quit` (volta para user view e encerra) e de um timeout maior.
    // `abortOnInteractivePrompt`: se o VRP abrir qualquer confirmacao/paginacao
    // no meio da escrita, a sessao e abandonada sem responder — nunca `Y`.
    const client = await this.createClient(device, {
      exitMode: 'return-quit',
      shellTimeoutMs: 30_000,
      abortOnInteractivePrompt: true,
      abortOnCommandError: true,
      requirePromptCompletion: true,
    });
    const raw = await this.executeRaw(client, device.ssh!.host, [
      'screen-length 0 temporary',
      ...commands,
    ]);
    return { ok: !raw.failed, output: raw.output };
  }

  private async learnLocalAs(
    client: SshClient,
    host: string,
  ): Promise<{ localAs: bigint | null; ambiguous: boolean }> {
    const output = await this.executeStrict(client, host, [
      'screen-length 0 temporary',
      'display current-configuration configuration bgp',
    ]);
    if (output === null) return { localAs: null, ambiguous: false };
    return parseHuaweiBgpLocalAs(output);
  }

  private async createClient(
    device: HostRecord,
    options: {
      exitMode?: 'quit' | 'return-quit';
      shellTimeoutMs?: number;
      abortOnInteractivePrompt?: boolean;
      abortOnCommandError?: boolean;
      requirePromptCompletion?: boolean;
    } = {},
  ): Promise<SshClient> {
    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) {
      throw new Error('SSH não está habilitado para este host');
    }
    const credentials = await this.repository.getDecryptedSshCredentials(device.id);
    if (!credentials?.password) throw new Error('SSH credential not configured');
    return this.clientFactory({
      port: device.ssh.port,
      username: device.ssh.username,
      password: credentials.password,
      contextCommand: device.ssh.contextCommand ?? null,
      ...(options.exitMode === undefined ? {} : { exitMode: options.exitMode }),
      ...(options.shellTimeoutMs === undefined ? {} : { shellTimeoutMs: options.shellTimeoutMs }),
      ...(options.abortOnInteractivePrompt === undefined
        ? {}
        : { abortOnInteractivePrompt: options.abortOnInteractivePrompt }),
      ...(options.abortOnCommandError === undefined
        ? {}
        : { abortOnCommandError: options.abortOnCommandError }),
      ...(options.requirePromptCompletion === undefined
        ? {}
        : { requirePromptCompletion: options.requirePromptCompletion }),
    });
  }

  /**
   * Como `executeStrict`, mas DEVOLVE o texto do equipamento tambem quando ele
   * reporta erro — necessario para diagnosticar escrita (nunca mascarar).
   */
  private async executeRaw(
    client: SshClient,
    host: string,
    commands: string[],
  ): Promise<{ output: string; failed: boolean }> {
    try {
      const results = await client.execute(host, commands);
      const result = results.at(-1);
      if (!result || result.exitCode !== 0) {
        return { output: result?.stdout ?? '', failed: true };
      }
      return { output: result.stdout, failed: commandOutputError(result.stdout) };
    } catch (error) {
      return { output: safeSshError(error), failed: true };
    }
  }

  /** Returns the raw output, or null when the command reported an error. */
  private async executeStrict(
    client: SshClient,
    host: string,
    commands: string[],
  ): Promise<string | null> {
    try {
      const results = await client.execute(host, commands);
      const result = results.at(-1);
      if (!result || result.exitCode !== 0 || commandOutputError(result.stdout)) return null;
      return result.stdout;
    } catch {
      return null;
    }
  }

  private async executeRequired(client: SshClient, host: string, command: string): Promise<string> {
    try {
      const results = await client.execute(host, ['screen-length 0 temporary', command]);
      const result = results.at(-1);
      if (!result || result.exitCode !== 0 || commandOutputError(result.stdout)) {
        throw new Error('SSH command failed');
      }
      return result.stdout;
    } catch (error) {
      throw new Error(safeSshError(error));
    }
  }
}
