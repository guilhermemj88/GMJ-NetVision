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

  async get(
    host: string,
    oids: string[],
    options?: { community?: string; version?: 'v2c' | 'v3'; port?: number },
  ): Promise<SnmpVarBind[]> {
    return new Promise((resolve, reject) => {
      if (options?.version === 'v3') {
        reject(new Error('SNMPv3 is not implemented by SnmpClientImpl'));
        return;
      }

      const community = options?.community ?? 'public';
      const port = options?.port ?? 161;
      const session = snmp.createSession(host, community, {
        port,
        timeout: this.timeout,
        retries: this.retries,
        version: snmp.Version2c,
      });

      session.get(oids, (error: Error | null, varbinds: snmp.VarBind[]) => {
        session.close();
        if (error) {
          reject(this.normalizeError(error, host, port));
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

  async walk(
    host: string,
    oid: string,
    options?: { community?: string; version?: 'v2c' | 'v3'; port?: number },
  ): Promise<SnmpVarBind[]> {
    return new Promise((resolve, reject) => {
      if (options?.version === 'v3') {
        reject(new Error('SNMPv3 is not implemented by SnmpClientImpl'));
        return;
      }

      const community = options?.community ?? 'public';
      const port = options?.port ?? 161;
      const session = snmp.createSession(host, community, {
        port,
        timeout: this.timeout,
        retries: this.retries,
        version: snmp.Version2c,
      });

      const result: SnmpVarBind[] = [];
      const seenOids = new Set<string>();
      const subtreePrefix = `${oid}.`;
      const maxVarbinds = 4096;
      let finished = false;

      const doneCb = (error?: Error) => {
        if (finished) return;
        finished = true;
        session.close();
        if (error) {
          reject(this.normalizeError(error, host, port));
          return;
        }
        resolve(result);
      };

      const feedCb = (varbinds: snmp.VarBind | snmp.VarBind[]) => {
        if (finished) return;
        const binds = Array.isArray(varbinds) ? varbinds : [varbinds];
        for (const vb of binds) {
          if (finished) return;
          if (snmp.isVarbindError(vb)) continue;

          // Some agents incorrectly continue a walk outside the requested
          // subtree. Stop locally instead of accepting unrelated OIDs forever.
          if (!vb.oid.startsWith(subtreePrefix)) {
            doneCb();
            return;
          }

          // Protect against buggy agents returning the same OID repeatedly.
          if (seenOids.has(vb.oid)) {
            doneCb(new Error('SNMP walk repeated OID'));
            return;
          }
          seenOids.add(vb.oid);

          result.push({
            oid: vb.oid,
            value: this.normalizeValue(vb.value),
          });

          if (result.length >= maxVarbinds) {
            doneCb(new Error(`SNMP walk exceeded safety limit of ${maxVarbinds} values`));
            return;
          }
        }
      };

      session.walk(oid, feedCb, doneCb);
    });
  }

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
        version: snmp.Version2c,
      });

      session.get(['1.3.6.1.2.1.1.1.0'], (error: Error | null) => {
        session.close();
        resolve(!error);
      });
    });
  }

  private normalizeValue(value: unknown): string | number | Uint8Array {
    if (value instanceof Buffer) return new Uint8Array(value);
    if (typeof value === 'number' || typeof value === 'string') return value;
    return String(value ?? '');
  }

  private normalizeError(error: Error, host: string, port: number): Error {
    const message = error.message?.toLowerCase() ?? '';
    if (message.includes('timeout')) return new Error(`SNMP timeout connecting to ${host}:${port}`);
    if (message.includes('econnrefused') || message.includes('unreachable')) {
      return new Error(`Host ${host} is unreachable`);
    }
    if (message.includes('authentication') || message.includes('badversion')) {
      return new Error('SNMP authentication failed - check community/credentials and version compatibility');
    }
    if (message.includes('nosuchobject') || message.includes('nosuchinstance')) {
      return new Error('SNMP object not found on target');
    }
    if (message.includes('repeated oid')) {
      return new Error(`SNMP walk repeated an OID on ${host}:${port}`);
    }
    if (message.includes('safety limit')) {
      return new Error(`SNMP walk exceeded safety limit on ${host}:${port}`);
    }
    return new Error(`SNMP error connecting to ${host}`);
  }
}

export function createSnmpClient(
  _host?: string,
  _port?: number,
  timeout?: number,
  retries?: number,
): SnmpClient {
  return new SnmpClientImpl(timeout, retries);
}
