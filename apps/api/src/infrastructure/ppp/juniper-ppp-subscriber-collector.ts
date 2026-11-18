import type { PppSubscriberTableCapability } from '../snmp/profiles/types';

/**
 * Cliente SNMP minimo para os dois walks da subscriber table. `SnmpClientImpl`
 * ja satisfaz este contrato.
 */
export interface PppWalkClient {
  walk(
    host: string,
    oid: string,
    options?: {
      community?: string;
      version?: 'v2c' | 'v3';
      port?: number;
      maxVarbinds?: number;
    },
  ): Promise<Array<{ oid: string; value: string | number | Uint8Array }>>;
}

export interface JuniperPppDiagnostics {
  clientTypeRows: number;
  stateRows: number;
  matchedRows: number;
  clientTypeOnly: number;
  stateOnly: number;
  pppoeRows: number;
  activeRows: number;
  pppoeActiveRows: number;
}

export interface JuniperPppResult {
  online: number | null;
  diagnostics: JuniperPppDiagnostics;
  error: string | null;
}

/** Teto de seguranca proprio da subscriber table (medido ~6,1k linhas/coluna). */
export const SUBSCRIBER_TABLE_MAX_VARBINDS = 100_000;

const EMPTY_DIAGNOSTICS: JuniperPppDiagnostics = {
  clientTypeRows: 0,
  stateRows: 0,
  matchedRows: 0,
  clientTypeOnly: 0,
  stateOnly: 0,
  pppoeRows: 0,
  activeRows: 0,
  pppoeActiveRows: 0,
};

/**
 * `jnxSubscriberClientType` vem como OCTET STRING binario (ASN.1 type 4), nao
 * como INTEGER. `Number(value)` devolveria NaN, entao o binario e interpretado
 * como unsigned big-endian. Aceita Uint8Array/Buffer de qualquer comprimento e
 * rejeita valor vazio ou invalido (nunca devolve 0 no lugar de invalido).
 */
export function decodeUnsignedBigEndian(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (!(value instanceof Uint8Array) || value.length === 0) return null;
  let total = 0;
  for (const byte of value) total = total * 256 + byte;
  return Number.isSafeInteger(total) ? total : null;
}

/** `jnxSubscriberState` vem como INTEGER (ASN.1 type 2). Invalido vira null. */
export function decodeSnmpInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?[0-9]+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (value instanceof Uint8Array && value.length > 0 && value.length <= 4) {
    let total = 0;
    for (const byte of value) total = total * 256 + byte;
    return total;
  }
  return null;
}

/**
 * Extrai `<HandleHiWord>.<HandleLoWord>` do OID de um varbind da subscriber
 * table. O join entre as colunas e feito exclusivamente por este indice.
 */
export function subscriberHandleFromOid(oid: string, baseOid: string): string | null {
  if (!oid.startsWith(baseOid + '.')) return null;
  const suffix = oid.slice(baseOid.length + 1);
  const parts = suffix.split('.');
  if (parts.length !== 2) return null;
  if (!parts.every((part) => /^[0-9]+$/.test(part))) return null;
  return parts[0] + '.' + parts[1];
}

/**
 * Conta PPPoE ACTIVE: somente handles presentes nas DUAS colunas, com
 * clientType == PPPoE e state == ACTIVE. Linhas orfas sao ignoradas no snapshot
 * (nunca completadas com valor de coleta anterior).
 */
export function countPppoeActive(
  clientTypeRows: Array<{ oid: string; value: string | number | Uint8Array }>,
  stateRows: Array<{ oid: string; value: string | number | Uint8Array }>,
  capability: Pick<PppSubscriberTableCapability, 'clientTypeOid' | 'stateOid' | 'clientTypePppoe' | 'stateActive'>,
): { online: number; diagnostics: JuniperPppDiagnostics } {
  const clientTypes = new Map<string, number | null>();
  for (const row of clientTypeRows) {
    const handle = subscriberHandleFromOid(row.oid, capability.clientTypeOid);
    if (handle) clientTypes.set(handle, decodeUnsignedBigEndian(row.value));
  }
  const states = new Map<string, number | null>();
  for (const row of stateRows) {
    const handle = subscriberHandleFromOid(row.oid, capability.stateOid);
    if (handle) states.set(handle, decodeSnmpInteger(row.value));
  }

  let matchedRows = 0;
  let pppoeRows = 0;
  let activeRows = 0;
  let pppoeActiveRows = 0;
  for (const [handle, clientType] of clientTypes) {
    if (clientType === capability.clientTypePppoe) pppoeRows += 1;
    if (!states.has(handle)) continue;
    matchedRows += 1;
    const state = states.get(handle);
    if (state === capability.stateActive) activeRows += 1;
    if (clientType === capability.clientTypePppoe && state === capability.stateActive) {
      pppoeActiveRows += 1;
    }
  }
  let clientTypeOnly = 0;
  for (const handle of clientTypes.keys()) if (!states.has(handle)) clientTypeOnly += 1;
  let stateOnly = 0;
  for (const handle of states.keys()) if (!clientTypes.has(handle)) stateOnly += 1;

  return {
    online: pppoeActiveRows,
    diagnostics: {
      clientTypeRows: clientTypes.size,
      stateRows: states.size,
      matchedRows,
      clientTypeOnly,
      stateOnly,
      pppoeRows,
      activeRows,
      pppoeActiveRows,
    },
  };
}

/**
 * Collector PPPoE do Juniper via JUNIPER-SUBSCRIBER-MIB.
 *
 * - exatamente dois walks (clientType, depois state), nunca em paralelo;
 * - cadencia propria (300 s por padrao), independente do poll de 60 s;
 * - protecao por device: nao inicia uma segunda coleta enquanto a anterior roda;
 * - qualquer falha devolve online = null (o chamador preserva o ultimo valor).
 */
export class JuniperPppSubscriberCollector {
  private readonly inFlight = new Map<string, Promise<JuniperPppResult>>();
  private readonly lastAttemptAt = new Map<string, number>();

  constructor(private readonly client: PppWalkClient) {}

  shouldSkip(deviceId: string, intervalSeconds: number, now: number = Date.now()): boolean {
    const last = this.lastAttemptAt.get(deviceId);
    return last !== undefined && now - last < intervalSeconds * 1000;
  }

  isInFlight(deviceId: string): boolean {
    return this.inFlight.has(deviceId);
  }

  /** devolve `null` quando a coleta deve ser pulada (janela ou overlap). */
  async collect(
    input: { deviceId: string; host: string; port: number },
    community: string,
    capability: PppSubscriberTableCapability,
    now: number = Date.now(),
  ): Promise<JuniperPppResult | null> {
    if (this.shouldSkip(input.deviceId, capability.intervalSeconds, now)) return null;
    const running = this.inFlight.get(input.deviceId);
    if (running) return running;

    const task = this.run(input, community, capability)
      .finally(() => { this.inFlight.delete(input.deviceId); })
      .then((result) => {
        this.lastAttemptAt.set(input.deviceId, now);
        return result;
      });
    this.inFlight.set(input.deviceId, task);
    return task;
  }

  private async run(
    input: { deviceId: string; host: string; port: number },
    community: string,
    capability: PppSubscriberTableCapability,
  ): Promise<JuniperPppResult> {
    // A subscriber table tem milhares de linhas (medido: 5.735 / 6.084), acima
    // do limite padrao de 4.096 varbinds do walk generico.
    const options = {
      community,
      version: 'v2c' as const,
      port: input.port,
      maxVarbinds: SUBSCRIBER_TABLE_MAX_VARBINDS,
    };
    try {
      const clientTypeRows = await this.client.walk(input.host, capability.clientTypeOid, options);
      const stateRows = await this.client.walk(input.host, capability.stateOid, options);
      const { online, diagnostics } = countPppoeActive(clientTypeRows, stateRows, capability);
      return { online, diagnostics, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha na coleta PPP via subscriber table';
      return { online: null, diagnostics: { ...EMPTY_DIAGNOSTICS }, error: message };
    }
  }
}
