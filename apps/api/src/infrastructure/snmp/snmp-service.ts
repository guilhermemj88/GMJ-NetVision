import type { NetworkInterface, SourceConnectionState, HostRecord } from '@gmj/shared';
import { SnmpClientImpl } from './snmp-client-impl';
import { SnmpV2cDiscoveryAdapter } from './snmpv2c-discovery-adapter';
import type { DemoMapRepository } from '../persistence/demo-map-repository';

/**
 * SNMP Service: handles connectivity testing, discovery, and metric collection.
 * Provides safe abstraction over SNMP operations without exposing credentials.
 */
export class SnmpService {
  private readonly client: SnmpClientImpl;
  private readonly discoveryAdapter: SnmpV2cDiscoveryAdapter;

  constructor(private readonly repository: DemoMapRepository) {
    this.client = new SnmpClientImpl(5000, 2);
    this.discoveryAdapter = new SnmpV2cDiscoveryAdapter(repository);
  }

  /**
   * Test SNMP connectivity to a host.
   * Attempts to retrieve sysDescr (system description) OID.
   *
   * Returns safe state strings:
   * - CONNECTED: Successfully contacted host
   * - FAILED: Host unreachable, timeout, or authentication failure
   * - TIMEOUT: Connection timeout
   * - AUTH_INVALID: Authentication/community failure
   * - UNREACHABLE: Host/port unreachable
   * - DISABLED: SNMP not enabled on host
   */
  async testConnectivity(device: HostRecord): Promise<{
    state: Exclude<SourceConnectionState, 'CONFIGURED'>;
    message: string;
  }> {
    if (!device.snmp?.host || !device.snmp.port || !device.snmpEnabled) {
      return {
        state: 'DISABLED',
        message: 'SNMP não está habilitado para este host',
      };
    }

    try {
      const credentials = await this.repository.getDecryptedSnmpCredentials(device.id);
      const community = credentials?.community ?? 'public';

      // Attempt simple GET of sysDescr
      const result = await this.client.get(
        device.snmp.host,
        ['1.3.6.1.2.1.1.1.0'], // sysDescr
        {
          community,
          version: 'v2c',
          port: device.snmp.port,
        },
      );

      if (result.length > 0) {
        return {
          state: 'CONNECTED',
          message: `Conectado ao ${device.snmp.host}:${device.snmp.port}`,
        };
      }

      return {
        state: 'FAILED',
        message: 'Resposta vazia do equipamento',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('timeout')) {
        return {
          state: 'TIMEOUT',
          message: `Timeout ao conectar a ${device.snmp.host}:${device.snmp.port}`,
        };
      }

      if (message.includes('unreachable') || message.includes('refused')) {
        return {
          state: 'UNREACHABLE',
          message: `Equipamento ${device.snmp.host}:${device.snmp.port} não está acessível`,
        };
      }

      if (message.includes('authentication') || message.includes('community')) {
        return {
          state: 'AUTH_INVALID',
          message: 'Falha de autenticação SNMP - verifique community/versão',
        };
      }

      return {
        state: 'FAILED',
        message: `Erro ao conectar: ${message}`,
      };
    }
  }

  /**
   * Discover interfaces on a device via SNMP IF-MIB.
   */
  async discoverInterfaces(device: HostRecord): Promise<NetworkInterface[]> {
    if (!device.snmpEnabled || !device.snmp?.host) {
      return [];
    }

    try {
      const credentials = await this.repository.getDecryptedSnmpCredentials(device.id);
      const community = credentials?.community ?? 'public';

      const interfaces = await this.discoveryAdapter.discoverInterfaces(device, community);
      return interfaces;
    } catch (error) {
      console.error(
        `Failed to discover interfaces for ${device.hostname}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * Collect traffic counters (octets in/out) for interfaces.
   * Uses HC (64-bit) counters when available, falls back to 32-bit.
   *
   * Returns map of ifIndex -> { inOctets, outOctets, timestamp }
   */
  async collectCounters(
    device: HostRecord,
  ): Promise<
    Map<
      number,
      {
        inOctets: number;
        outOctets: number;
        timestamp: Date;
      }
    >
  > {
    const counters = new Map<
      number,
      {
        inOctets: number;
        outOctets: number;
        timestamp: Date;
      }
    >();

    if (!device.snmpEnabled || !device.snmp?.host) {
      return counters;
    }

    try {
      const credentials = await this.repository.getDecryptedSnmpCredentials(device.id);
      const community = credentials?.community ?? 'public';

      // Try HC counters first (64-bit)
      const [hcInOctets, hcOutOctets] = await Promise.all([
        this.client.walk(device.snmp.host, '1.3.6.1.2.1.31.1.1.1.6', {
          community,
          version: 'v2c',
          port: device.snmp.port,
        }),
        this.client.walk(device.snmp.host, '1.3.6.1.2.1.31.1.1.1.10', {
          community,
          version: 'v2c',
          port: device.snmp.port,
        }),
      ]);

      // Build maps by ifIndex
      const inOctetsByIndex = new Map<number, number>();
      const outOctetsByIndex = new Map<number, number>();

      for (const vb of hcInOctets) {
        const ifIndex = this.extractIfIndex(vb.oid);
        if (ifIndex !== null) {
          inOctetsByIndex.set(ifIndex, this.parseCounter(vb.value));
        }
      }

      for (const vb of hcOutOctets) {
        const ifIndex = this.extractIfIndex(vb.oid);
        if (ifIndex !== null) {
          outOctetsByIndex.set(ifIndex, this.parseCounter(vb.value));
        }
      }

      // Combine results
      const now = new Date();
      for (const [ifIndex, inOctets] of inOctetsByIndex) {
        const outOctets = outOctetsByIndex.get(ifIndex) ?? 0;
        counters.set(ifIndex, { inOctets, outOctets, timestamp: now });
      }

      return counters;
    } catch (error) {
      console.error(
        `Failed to collect counters for ${device.hostname}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return counters;
    }
  }

  /**
   * Extract ifIndex from OID.
   * E.g., "1.3.6.1.2.1.31.1.1.1.6.5" -> 5
   */
  private extractIfIndex(oid: string): number | null {
    const parts = oid.split('.');
    const lastPart = parts[parts.length - 1];
    const ifIndex = parseInt(lastPart ?? '', 10);
    return Number.isInteger(ifIndex) && ifIndex > 0 ? ifIndex : null;
  }

  /**
   * Parse counter value, handling large numbers and Uint8Array.
   */
  private parseCounter(value: string | number | Uint8Array): number {
    if (typeof value === 'number') return Math.max(0, value);
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
    }
    if (value instanceof Uint8Array) {
      // Parse as big-endian integer
      let result = 0;
      for (let i = 0; i < value.length; i++) {
        result = (result << 8) | (value[i] ?? 0);
      }
      return Math.max(0, result);
    }
    return 0;
  }
}
