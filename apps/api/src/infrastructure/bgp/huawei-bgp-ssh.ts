import type { BgpAddressFamily, BgpAdminAction, HostRecord } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';
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

function safeSshError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('auth')) return 'SSH authentication failed';
  if (message.includes('timeout')) return 'SSH connection timeout';
  if (message.includes('unreachable') || message.includes('refused')) {
    return 'SSH host is unreachable';
  }
  return 'SSH command failed';
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

export class HuaweiBgpSshService {
  constructor(
    private readonly repository: HostRepository,
    private readonly clientFactory: BgpSshClientFactory = (options) => new SshClientImpl(options),
  ) {}

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

  private async createClient(device: HostRecord): Promise<SshClient> {
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
    });
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
