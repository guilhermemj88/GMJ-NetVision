// Type declarations for net-snmp library
declare module 'net-snmp' {
  export interface VarBind {
    oid: string;
    type?: number;
    value: string | number | Buffer | Uint8Array;
  }

  export interface Session {
    get(oids: string[], callback: (error: Error | null, varbinds: VarBind[]) => void): void;
    walk(oid: string, feedCb: (varbind: VarBind | VarBind[]) => void, doneCb: (error?: Error) => void): void;
    close(): void;
  }

  export interface SessionOptions {
    port?: number;
    timeout?: number;
    retries?: number;
    version?: number;
  }

  export function createSession(
    target: string,
    community: string,
    options?: SessionOptions,
  ): Session;

  export const Version1: number;
  export const Version2c: number;

  export function isVarbindError(varbind: VarBind): boolean;
}
