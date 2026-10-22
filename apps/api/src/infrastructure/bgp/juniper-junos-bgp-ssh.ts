import type { HostRecord } from '@gmj/shared';
import type { SshClient } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';
import { SshClientImpl } from '../ssh/ssh-client-impl';
import {
  JuniperBgpConfigError,
  assertJunosReadOnly,
  buildJunosAdvertisedRoutesCommand,
  buildJunosRouteCommand,
  parseJunosAdvertisedRoutes,
  parseJunosBgpConfig,
  parseJunosBgpSummary,
  parseJunosRouteLookup,
  type JunosAdvertisedRoutes,
} from './juniper-junos-bgp-parser';
import type { BgpSshDiscoveryProvider, BgpSshDiscoveryReading } from './bgp-ssh-discovery';

export interface JunosSshOptions {
  port: number;
  username: string;
  password: string;
  contextCommand?: string | null;
}

export type JunosSshClientFactory = (options: JunosSshOptions) => SshClient;

/** Saída bruta de um comando, ou null quando o equipamento reportou erro. */
type CommandResult = { ok: true; output: string } | { ok: false; error: string };

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'Falha SSH sem detalhe').slice(0, 240);
}

/**
 * Sessões curtas e ISOLADAS: no Junos, dois comandos grandes na mesma sessão já
 * provocaram `SSH transport failed`. Cada comando grande abre a sua própria
 * sessão; as consultas de rota (pequenas) reaproveitam uma sessão por lote.
 */
const ROUTE_LOOKUPS_PER_SESSION = 8;

export class JuniperJunosBgpSshProvider implements BgpSshDiscoveryProvider {
  constructor(
    private readonly repository: HostRepository,
    private readonly clientFactory: JunosSshClientFactory = (options) => new SshClientImpl(options),
  ) {}

  async discover(device: HostRecord): Promise<BgpSshDiscoveryReading> {
    const warnings: string[] = [];
    const summary = await this.runCommand(device, 'show bgp summary | no-more');
    if (!summary.ok) throw new JuniperBgpConfigError(summary.error);

    const parsed = parseJunosBgpSummary(summary.output);
    warnings.push(...parsed.warnings);

    // Configuração: sessões separadas (comandos grandes, um por sessão).
    const bgpConfig = await this.runCommand(device, 'show configuration protocols bgp | display set | no-more');
    const routingOptions = await this.runCommand(
      device,
      'show configuration routing-options | display set | no-more',
    );
    if (!bgpConfig.ok) warnings.push(`Configuração BGP: ${bgpConfig.error}`);
    if (!routingOptions.ok) warnings.push(`routing-options: ${routingOptions.error}`);
    const config = parseJunosBgpConfig(
      bgpConfig.ok ? bgpConfig.output : '',
      routingOptions.ok ? routingOptions.output : '',
    );

    const routeLookups = await this.lookupRoutes(
      device,
      parsed.peers.map((peer) => peer.peerAddress),
    );

    const peers = parsed.peers.map((peer) => {
      const neighbor = config.neighbors.get(peer.peerAddress);
      const group = neighbor?.group ? config.groups.get(neighbor.group) : undefined;
      // Precedência do AS local: peer > grupo > autonomous-system global.
      const localAs = neighbor?.localAs ?? group?.localAs ?? config.autonomousSystem ?? null;
      const lookup = routeLookups.get(peer.peerAddress);
      return {
        peerAddress: peer.peerAddress,
        addressFamily: peer.addressFamily,
        remoteAs: peer.remoteAs,
        localAs,
        stateCode: peer.stateCode,
        state: peer.state,
        sessionUptimeSeconds: peer.sessionUptimeSeconds,
        cliReceivedPrefixes: peer.receivedPrefixes,
        bgpPeerDescription: neighbor?.description?.trim() || group?.description?.trim() || null,
        routeLookup: lookup?.ok
          ? { status: 'SUCCESS' as const, lookup: parseJunosRouteLookup(lookup.output, peer.addressFamily) }
          : { status: 'COMMAND_FAILED' as const, error: lookup?.error ?? 'Rota não consultada' },
      };
    });

    return {
      peers,
      localAs: config.autonomousSystem,
      localAsAmbiguous: false,
      ipv6Supported: true,
      logicalUnitFallback: true,
      warnings,
    };
  }

  /** Rotas anunciadas (SOMENTE LEITURA) para um peer já persistido. */
  async readAdvertisedRoutes(
    device: HostRecord,
    peerAddress: string,
    localAs: bigint | null,
  ): Promise<JunosAdvertisedRoutes> {
    const command = buildJunosAdvertisedRoutesCommand(peerAddress);
    const result = await this.runCommand(device, command);
    if (!result.ok) throw new JuniperBgpConfigError(result.error);
    return parseJunosAdvertisedRoutes(result.output, { localAs });
  }

  private async runCommand(device: HostRecord, command: string): Promise<CommandResult> {
    assertJunosReadOnly(command);
    try {
      const client = await this.createClient(device);
      const results = await client.execute(device.ssh!.host, [command]);
      const result = results.at(-1);
      if (!result || result.exitCode !== 0) {
        return { ok: false, error: result?.stderr?.trim() || 'Comando SSH falhou' };
      }
      return { ok: true, output: result.stdout };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  private async lookupRoutes(
    device: HostRecord,
    peerAddresses: readonly string[],
  ): Promise<Map<string, CommandResult>> {
    const results = new Map<string, CommandResult>();
    for (let index = 0; index < peerAddresses.length; index += ROUTE_LOOKUPS_PER_SESSION) {
      const batch = peerAddresses.slice(index, index + ROUTE_LOOKUPS_PER_SESSION);
      let client: SshClient | null = null;
      try {
        client = await this.createClient(device);
        for (const peerAddress of batch) {
          const command = buildJunosRouteCommand(peerAddress);
          assertJunosReadOnly(command);
          try {
            const executed = await client.execute(device.ssh!.host, [command]);
            const result = executed.at(-1);
            results.set(
              peerAddress,
              result && result.exitCode === 0
                ? { ok: true, output: result.stdout }
                : { ok: false, error: result?.stderr?.trim() || 'Comando SSH falhou' },
            );
          } catch (error) {
            results.set(peerAddress, { ok: false, error: safeError(error) });
          }
        }
      } catch (error) {
        for (const peerAddress of batch) {
          if (!results.has(peerAddress)) results.set(peerAddress, { ok: false, error: safeError(error) });
        }
      }
    }
    return results;
  }

  private async createClient(device: HostRecord): Promise<SshClient> {
    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) {
      throw new JuniperBgpConfigError('SSH não está habilitado para este equipamento');
    }
    const credentials = await this.repository.getDecryptedSshCredentials(device.id);
    if (!credentials?.password) throw new JuniperBgpConfigError('Credencial SSH não configurada');
    return this.clientFactory({
      port: device.ssh.port,
      username: device.ssh.username,
      password: credentials.password,
      contextCommand: device.ssh.contextCommand ?? null,
    });
  }
}
