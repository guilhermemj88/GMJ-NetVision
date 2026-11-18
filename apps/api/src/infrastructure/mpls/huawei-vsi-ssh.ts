import type { HostRecord, MplsLdpPeer } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';
import { SshClientImpl } from '../ssh/ssh-client-impl';
import {
  L2VC_COMMAND,
  LDP_REMOTE_PEERS_COMMAND,
  LDP_SESSIONS_COMMAND,
  VSI_SUMMARY_COMMAND,
  VSI_VERBOSE_COMMAND,
  vsiVerboseByNameCommand,
} from './huawei-vsi-commands';
import {
  parseHuaweiL2vc,
  parseHuaweiL2vcSummary,
  parseHuaweiLdpRemotePeers,
  parseHuaweiLdpSessions,
  parseHuaweiVsiNames,
  parseHuaweiVsiVerbose,
  type HuaweiL2vcSummary,
  type ParsedL2vc,
  type ParsedLdpRemotePeer,
  type ParsedVsi,
} from './huawei-vsi-ssh-parser';

interface VsiSshClientOptions {
  port: number;
  username: string;
  password: string;
  contextCommand?: string | null;
}

export type VsiSshClientFactory = (options: VsiSshClientOptions) => SshClient;

export type VsiCommandOutcome =
  | { status: 'SUCCESS'; output: string }
  | { status: 'UNSUPPORTED'; errorSafe: string }
  | { status: 'COMMAND_FAILED'; errorSafe: string };

export interface HuaweiVsiSshReading {
  /** O comando principal respondeu nesta coleta (mesmo que sem VSI). */
  available: boolean;
  /**
   * O VRP reconhece `display vsi`? `null` = nao foi possivel concluir (timeout,
   * autenticacao, SSH desabilitado) — diferente de "nao suporta".
   */
  supported: boolean | null;
  collectedAt: Date;
  vsis: ParsedVsi[];
  ldpPeers: MplsLdpPeer[];
  l2vcs: ParsedL2vc[];
  /** Linha de totais do l2vc, quando impressa (evidencia de coleta completa). */
  l2vcSummary?: HuaweiL2vcSummary | undefined;
  warnings: string[];
  /** Erro seguro da leitura principal, quando ela nao concluiu. */
  errorSafe: string | null;
}

/** Quantas VSI podem ser detalhadas uma a uma quando o verbose global falha. */
const MAX_DETAILED_VSIS = 32;

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
  return /(?:unrecognized\s+command|wrong\s+parameter|incomplete\s+command|error\s*:)/i.test(output);
}

function unsupportedCommandOutput(output: string): boolean {
  return /(?:unrecognized\s+command|wrong\s+parameter|incomplete\s+command|too\s+many\s+parameters)/i.test(
    output,
  );
}

/** Rotula a sessao LDP com o nome do remote-peer, casando pelo IP do vizinho. */
function withRemotePeerNames(
  peers: MplsLdpPeer[],
  remotePeers: ParsedLdpRemotePeer[],
): MplsLdpPeer[] {
  if (!remotePeers.length) return peers;
  return peers.map((peer) => {
    if (peer.name) return peer;
    const peerIp = peer.peerLdpId.split(':')[0];
    const match = remotePeers.find((remote) => peerIp && remote.ipAddress === peerIp);
    return match ? { ...peer, name: match.name } : peer;
  });
}

/**
 * Leitura READ-ONLY de VSI/VPLS por CLI.
 *
 * `display vsi verbose` e a fonte principal porque enxerga a VSI sinalizada por
 * LDP exatamente como o operador a ve no equipamento. As Sessoes LDP e o l2vc
 * sao enriquecimento: falham em isolamento e nunca derrubam a descoberta.
 */
export class HuaweiVsiSshService {
  constructor(
    private readonly repository: HostRepository,
    private readonly clientFactory: VsiSshClientFactory = (options) => new SshClientImpl(options),
  ) {}

  async readVsi(device: HostRecord): Promise<HuaweiVsiSshReading> {
    const empty = (
      errorSafe: string | null,
      supported: boolean | null,
      warnings: string[] = [],
    ): HuaweiVsiSshReading => ({
      available: false,
      supported,
      collectedAt: new Date(),
      vsis: [],
      ldpPeers: [],
      l2vcs: [],
      warnings,
      errorSafe,
    });

    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) {
      return empty('SSH não está habilitado para este host', null);
    }

    let client: SshClient;
    try {
      client = await this.createClient(device);
    } catch (error) {
      return empty(safeSshError(error), null);
    }

    const host = device.ssh.host;
    const verbose = await this.executeCommand(client, host, VSI_VERBOSE_COMMAND);
    if (verbose.status === 'UNSUPPORTED') {
      return empty(verbose.errorSafe, false, ['VSI: comando não suportado pelo VRP']);
    }
    if (verbose.status === 'COMMAND_FAILED') {
      return empty(verbose.errorSafe, null, ['VSI: SSH command failed']);
    }

    const warnings: string[] = [];
    let vsis = parseHuaweiVsiVerbose(verbose.output);
    if (!vsis.length) {
      const detailed = await this.readVsisByName(client, host, warnings);
      if (detailed.length) vsis = detailed;
    }

    const ldpPeers = withRemotePeerNames(
      await this.readLdpSessions(client, host, warnings),
      await this.readLdpRemotePeers(client, host),
    );
    const l2vc = await this.readL2vcs(client, host, warnings);
    const l2vcSummary = parseHuaweiL2vcSummary(l2vc.output ?? '');
    if (
      l2vcSummary.total !== null &&
      l2vc.rows.length > 0 &&
      l2vc.rows.length < l2vcSummary.total
    ) {
      warnings.push(
        `L2VC: ${l2vc.rows.length} de ${l2vcSummary.total} circuitos foram lidos`,
      );
    }

    return {
      available: true,
      supported: true,
      collectedAt: new Date(),
      vsis,
      ldpPeers,
      l2vcs: l2vc.rows,
      l2vcSummary,
      warnings,
      errorSafe: null,
    };
  }

  /** `display vsi name <NOME> verbose` para uma VSI; `null` quando nao leu. */
  async readVsiDetail(device: HostRecord, name: string): Promise<ParsedVsi | null> {
    let command: string;
    try {
      command = vsiVerboseByNameCommand(name);
    } catch {
      return null;
    }

    let client: SshClient;
    try {
      client = await this.createClient(device);
    } catch {
      return null;
    }

    const outcome = await this.executeCommand(client, device.ssh!.host, command);
    if (outcome.status !== 'SUCCESS') return null;
    return parseHuaweiVsiVerbose(outcome.output)[0] ?? null;
  }

  private async readVsisByName(
    client: SshClient,
    host: string,
    warnings: string[],
  ): Promise<ParsedVsi[]> {
    const summary = await this.executeCommand(client, host, VSI_SUMMARY_COMMAND);
    if (summary.status !== 'SUCCESS') {
      if (summary.status === 'UNSUPPORTED') warnings.push('VSI: comando não suportado pelo VRP');
      return [];
    }

    const names = parseHuaweiVsiNames(summary.output).slice(0, MAX_DETAILED_VSIS);
    const vsis: ParsedVsi[] = [];
    for (const name of names) {
      const outcome = await this.executeCommand(client, host, vsiVerboseByNameCommand(name));
      if (outcome.status !== 'SUCCESS') {
        warnings.push(`VSI ${name}: leitura detalhada indisponível`);
        continue;
      }
      const parsed = parseHuaweiVsiVerbose(outcome.output);
      if (parsed.length) {
        vsis.push(...parsed);
      } else {
        warnings.push(`VSI ${name}: saída não reconhecida`);
      }
    }
    return vsis;
  }

  private async readLdpSessions(
    client: SshClient,
    host: string,
    warnings: string[],
  ): Promise<MplsLdpPeer[]> {
    const outcome = await this.executeCommand(client, host, LDP_SESSIONS_COMMAND);
    if (outcome.status === 'SUCCESS') return parseHuaweiLdpSessions(outcome.output);
    warnings.push(
      outcome.status === 'UNSUPPORTED'
        ? 'LDP: comando de sessões não suportado pelo VRP'
        : `LDP: ${outcome.errorSafe}`,
    );
    return [];
  }

  private async readLdpRemotePeers(
    client: SshClient,
    host: string,
  ): Promise<ParsedLdpRemotePeer[]> {
    const outcome = await this.executeCommand(client, host, LDP_REMOTE_PEERS_COMMAND);
    return outcome.status === 'SUCCESS' ? parseHuaweiLdpRemotePeers(outcome.output) : [];
  }

  private async readL2vcs(
    client: SshClient,
    host: string,
    warnings: string[],
  ): Promise<{ rows: ParsedL2vc[]; output: string | null }> {
    const outcome = await this.executeCommand(client, host, L2VC_COMMAND);
    if (outcome.status === 'SUCCESS') {
      return { rows: parseHuaweiL2vc(outcome.output), output: outcome.output };
    }
    warnings.push(
      outcome.status === 'UNSUPPORTED'
        ? 'L2VC: comando não suportado pelo VRP'
        : `L2VC: ${outcome.errorSafe}`,
    );
    return { rows: [], output: null };
  }

  private async executeCommand(
    client: SshClient,
    host: string,
    command: string,
  ): Promise<VsiCommandOutcome> {
    try {
      const results = await client.execute(host, ['screen-length 0 temporary', command]);
      const result = results.at(-1);
      if (!result || result.exitCode !== 0) {
        return { status: 'COMMAND_FAILED', errorSafe: 'SSH command failed' };
      }
      if (unsupportedCommandOutput(result.stdout)) {
        return {
          status: 'UNSUPPORTED',
          errorSafe: 'O equipamento não reconheceu o comando de VSI/VPLS.',
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
}
