import type { HostRecord } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';
import { SshClientImpl } from '../ssh/ssh-client-impl';
import type { BgpRouteCommandResult } from './bgp-interface-correlation';
import {
  mergeHuaweiBgpPeerDetails,
  parseHuaweiBgpPeerSummary,
  parseHuaweiBgpPeerVerbose,
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
    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) {
      throw new Error('SSH não está habilitado para este host');
    }
    const credentials = await this.repository.getDecryptedSshCredentials(device.id);
    if (!credentials?.password) throw new Error('SSH credential not configured');
    const client = this.clientFactory({
      port: device.ssh.port,
      username: device.ssh.username,
      password: credentials.password,
      contextCommand: device.ssh.contextCommand ?? null,
    });

    const summaryOutput = await this.executeRequired(client, device.ssh.host, 'display bgp peer');
    let peers = parseHuaweiBgpPeerSummary(summaryOutput);
    let verboseUsed = false;
    if (peers.length && needsVerbose(peers)) {
      try {
        const verboseOutput = await this.executeRequired(
          client,
          device.ssh.host,
          'display bgp peer verbose',
        );
        peers = mergeHuaweiBgpPeerDetails(peers, parseHuaweiBgpPeerVerbose(verboseOutput));
        verboseUsed = true;
      } catch {
        // Verbose is optional enrichment. Valid summary peers remain discoverable.
      }
    }

    const routeCommands = new Map<string, BgpRouteCommandResult>();
    for (const peer of peers) {
      try {
        const output = await this.executeRequired(
          client,
          device.ssh.host,
          `display ip routing-table ${peer.peerAddress}`,
        );
        routeCommands.set(peer.peerAddress, { status: 'SUCCESS', output });
      } catch (error) {
        routeCommands.set(peer.peerAddress, {
          status: 'COMMAND_FAILED',
          error: safeSshError(error),
        });
      }
    }
    return { peers, routeCommands, verboseUsed };
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
