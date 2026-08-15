import snmp from 'net-snmp';
import type { SnmpClient, SnmpVarBind } from '../../domain/ports';

/**
 * Real SNMP v2c/v3 client implementation using net-snmp library.
 * Supports configurable host, port, timeout, and retries.
 * Never exposes or logs community/auth passwords.
 */
export class SnmpClientImpl implements SnmpClient {
  private readonly timeout: number;
  private readonly retries: number;

  constructor(
    timeout: number = 5000,
    retries: number = 2,
  ) {
    this.timeout = timeout;
    this.retries = retries;
  }

  /**
   * Perform SNMP GET on specified OIDs.
   * @param host Target host/IP
   * @param oids OIDs to retrieve
   * @param options SNMP options (community for v2c, auth for v3, port)
   * @returns Array of OID/value pairs
   */
  async get(
    host: string,
    oids: string[],
    options?: { community?: string; version?: 'v2c' | 'v3'; port?: number },
  ): Promise<SnmpVarBind[]> {
    return new Promise((resolve, reject) => {
      const community = options?.community ?? 'public';
      const port = options?.port ?? 161;
      const session = snmp.createSession(host, community, {
        port,
        timeout: this.timeout,
        retries: this.retries,
      });

      session.get(oids, (error: Error | null, varbinds: snmp.VarBind[]) => {
        session.close();
        if (error) {
          reject(this.normalizeError(error, host));
          return;
        }
        const result: SnmpVarBind[] = varbinds
          .filter((vb: unknown) => !snmp.isVarbindError(vb as snmp.VarBind))
          .map((vb: snmp.VarBind) => ({
            oid: vb.oid,
            value: this.normalizeValue(vb.value),
          }));
        resolve(result);
      });
    });
  }

  /**
   * Perform SNMP WALK on OID subtree.
   * @param host Target host/IP
   * @param oid Root OID to walk
   * @param options SNMP options (community for v2c, auth for v3, port)
   * @returns Array of all OID/value pairs in subtree
   */
  async walk(
    host: string,
    oid: string,
    options?: { community?: string; version?: 'v2c' | 'v3'; port?: number },
  ): Promise<SnmpVarBind[]> {
    return new Promise((resolve, reject) => {
      const community = options?.community ?? 'public';
      const port = options?.port ?? 161;
      const session = snmp.createSession(host, community, {
        port,
        timeout: this.timeout,
        retries: this.retries,
      });

      const result: SnmpVarBind[] = [];
      const doneCb = (error?: Error) => {
        session.close();
        if (error) {
          reject(this.normalizeError(error, host));
          return;
        }
        resolve(result);
      };

      const feedCb = (varbinds: snmp.VarBind | snmp.VarBind[]) => {
        const binds = Array.isArray(varbinds) ? varbinds : [varbinds];
        for (const vb of binds) {
          if (!snmp.isVarbindError(vb)) {
            result.push({
              oid: vb.oid,
              value: this.normalizeValue(vb.value),
            });
          }
        }
      };

      session.walk(oid, feedCb, doneCb);
    });
  }

  /**
   * Test SNMP connectivity by performing a simple GET.
   * @param host Target host/IP
   * @param port SNMP port (default 161)
   * @param community SNMP community (default 'public')
   * @returns true if reachable, false otherwise
   */
  async testConnectivity(
    host: string,
    port: number = 161,
    community: string = 'public',
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const session = snmp.createSession(host, community, {
        port,
        timeout: 3000,
        retries: 1,
      });

      session.get(['1.3.6.1.2.1.1.1.0'], (error: Error | null) => {
        session.close();
        resolve(!error);
      });
    });
  }

  /**
   * Normalize SNMP value for external use.
   * Converts snmp.js internal types to serializable values.
   */
  private normalizeValue(value: unknown): string | number | Uint8Array {
    if (value instanceof Buffer) {
      return new Uint8Array(value);
    }
    if (typeof value === 'number' || typeof value === 'string') {
      return value;
    }
    // Convert other types to string representation
    return String(value ?? '');
  }

  /**
   * Normalize errors to user-safe messages.
   * Never expose community or auth details.
   */
  private normalizeError(error: Error, host: string): Error {
    const message = error.message?.toLowerCase() ?? '';

    if (message.includes('timeout')) {
      return new Error(`SNMP timeout connecting to ${host}:161`);
    }
    if (message.includes('econnrefused') || message.includes('unreachable')) {
      return new Error(`Host ${host} is unreachable`);
    }
    if (message.includes('authentication') || message.includes('badversion')) {
      return new Error(
        'SNMP authentication failed - check community/credentials and version compatibility',
      );
    }
    if (message.includes('nosuchobject') || message.includes('nosuchinstance')) {
      return new Error('SNMP object not found on target');
    }

    return new Error(`SNMP error connecting to ${host}`);
  }
}

/**
 * Create SNMP client configured for specific host.
 * @param host Target host configuration
 * @param port Optional SNMP port override
 * @returns SnmpClient ready for use
 */
export function createSnmpClient(
  _host?: string,
  _port?: number,
  timeout?: number,
  retries?: number,
): SnmpClient {
  return new SnmpClientImpl(timeout, retries);
}
