import type { SnmpVarBind } from '../../domain/ports';
import {
  HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS,
  HUAWEI_ENTITY_STATE_WITNESS_OID,
  type HuaweiOpticalCapability,
} from '../topology/huawei-optical';

/**
 * Estado da capability optica de um equipamento (HUAWEI-ENTITY-EXTENT-MIB):
 * - SUPPORTED: a tabela respondeu e as colunas foram confirmadas no agente;
 * - UNSUPPORTED: o equipamento nao publica a tabela (ex.: MA5800-X15);
 * - RESTRICTED_VIEW: o PROFILE espera a tabela (familia comprovada) mas o
 *   agente nao a expoe - caso real do virtual-system NE8-IXBR, onde o MESMO
 *   hardware responde normalmente no contexto principal e responde
 *   `No Such Object`/`No Such Instance` dentro da VS;
 * - UNKNOWN: a sonda falhou (timeout/erro). NAO e cacheada: o coletor volta ao
 *   default do profile naquele ciclo.
 */
export type OpticalCapabilityState = 'SUPPORTED' | 'UNSUPPORTED' | 'RESTRICTED_VIEW' | 'UNKNOWN';

export interface OpticalCapabilitySnapshot {
  state: OpticalCapabilityState;
  table: boolean;
  scalarPower: boolean;
  alarmThresholds: boolean;
  warnings: boolean;
  laneBias: boolean;
  lanes: boolean;
  minMax: boolean;
  checkedAt: string;
}

/** Cliente SNMP minimo usado pela sonda (compativel com SnmpClientImpl.walk). */
export interface OpticalCapabilityProbeClient {
  walk(
    host: string,
    oid: string,
    options: { community: string; version: 'v2c'; port: number },
  ): Promise<SnmpVarBind[]>;
}

export interface OpticalCapabilityProbeInput {
  deviceId: string;
  host: string;
  port: number;
  community: string;
  /** Muda quando profile/sysObjectID/sysDescr mudam - invalida o cache. */
  fingerprint: string;
  /** O profile declara a tabela optica como suportada nesta familia? */
  expectsOpticalTable: boolean;
  /** Default do profile: usado quando UMA coluna falha (nunca desliga sozinho). */
  profile: HuaweiOpticalCapability;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/** Colunas sondadas individualmente (walk pequeno, uma por grupo). */
const PROBE_COLUMN_OIDS = {
  warnings: HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxLowWarningCentiDbm,
  laneBias: HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.biasCurrentByLane,
  lanes: HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxPowerByLane,
  minMax: HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.maxRxPowerCentiDbm,
} as const;

function emptySnapshot(state: OpticalCapabilityState): OpticalCapabilitySnapshot {
  return {
    state,
    table: false,
    scalarPower: false,
    alarmThresholds: false,
    warnings: false,
    laneBias: false,
    lanes: false,
    minMax: false,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Plano de walks do poll: o PROFILE e a autoridade (sem capability declarada
 * nenhum walk acontece) e a sonda so pode confirmar/negar. Em UNKNOWN (sonda
 * falhou) vale o default do profile. WARNING/bias/lanes exigem os DOIS lados.
 */
export function opticalWalkPlan(
  profile: HuaweiOpticalCapability,
  snapshot: OpticalCapabilitySnapshot,
): {
  table: boolean;
  scalarPower: boolean;
  alarmThresholds: boolean;
  warnings: boolean;
  laneBias: boolean;
  lanes: boolean;
} {
  const trusted = snapshot.state !== 'UNKNOWN';
  const confirm = (declared: boolean, probed: boolean): boolean =>
    declared && (trusted ? probed : true);
  return {
    table: confirm(profile.capabilities.table, snapshot.table),
    scalarPower: confirm(profile.capabilities.scalarPower, snapshot.scalarPower),
    alarmThresholds: confirm(profile.capabilities.alarmThresholds, snapshot.alarmThresholds),
    warnings: confirm(profile.capabilities.warnings, snapshot.warnings),
    laneBias: confirm(profile.capabilities.laneBias, snapshot.laneBias),
    lanes: confirm(profile.capabilities.lanes, snapshot.lanes),
  };
}

/**
 * Sonda READ-ONLY e CACHEADA por device. Roda no maximo uma vez por TTL (ou
 * quando o fingerprint muda) - nunca a cada poll. Invalida por: restart do
 * processo (cache em memoria), rediscovery explicito, mudanca de
 * profile/versao (fingerprint) e TTL.
 */
export class HuaweiOpticalCapabilityProbe {
  private readonly cache = new Map<
    string,
    { snapshot: OpticalCapabilitySnapshot; fingerprint: string; expiresAt: number }
  >();

  constructor(
    private readonly client: OpticalCapabilityProbeClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Ultimo resultado cacheado (diagnostico) - nao dispara sonda. */
  getCached(deviceId: string): OpticalCapabilitySnapshot | null {
    return this.cache.get(deviceId)?.snapshot ?? null;
  }

  invalidate(deviceId: string): void {
    this.cache.delete(deviceId);
  }

  async capabilityFor(input: OpticalCapabilityProbeInput): Promise<OpticalCapabilitySnapshot> {
    const cached = this.cache.get(input.deviceId);
    const now = Date.now();
    if (cached && cached.fingerprint === input.fingerprint && cached.expiresAt > now) {
      return cached.snapshot;
    }

    const options = { community: input.community, version: 'v2c' as const, port: input.port };
    let scalarRows: SnmpVarBind[];
    try {
      scalarRows = await this.client.walk(
        input.host,
        HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxPowerRaw,
        options,
      );
    } catch {
      return emptySnapshot('UNKNOWN');
    }

    // Sem linhas em .8 pode ser (a) tabela ausente/view restrita ou (b) modulo
    // sem potencia publicada: .32 (lanes) e .13 (thresholds) dao a segunda
    // chance antes de declarar a tabela ausente.
    let lanesRows: SnmpVarBind[] = [];
    let alarmRows: SnmpVarBind[] = [];
    if (!scalarRows.length) {
      try {
        [lanesRows, alarmRows] = await Promise.all([
          this.client.walk(input.host, HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxPowerByLane, options),
          this.client.walk(input.host, HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxLowAlarmCentiDbm, options),
        ]);
      } catch {
        return emptySnapshot('UNKNOWN');
      }
    }

    if (!scalarRows.length && !lanesRows.length && !alarmRows.length) {
      // Tabela vazia: distinguir "nao existe" de "view restrita". A testemunha
      // (hwEntityAdminStatus, mesma subarvore) confirma se a MIB responde.
      try {
        await this.client.walk(input.host, HUAWEI_ENTITY_STATE_WITNESS_OID, options);
      } catch {
        return emptySnapshot('UNKNOWN');
      }
      const snapshot = emptySnapshot(
        input.expectsOpticalTable ? 'RESTRICTED_VIEW' : 'UNSUPPORTED',
      );
      this.store(input, snapshot, now);
      return snapshot;
    }

    const columnPresence = async (oid: string): Promise<boolean | null> => {
      try {
        return (await this.client.walk(input.host, oid, options)).length > 0;
      } catch {
        // Falha em UMA coluna opcional nao derruba a sonda nem a desliga: cai no
        // default do profile e o resultado NAO e cacheado (tenta de novo depois).
        return null;
      }
    };
    const [warnings, laneBias, minMax] = await Promise.all([
      columnPresence(PROBE_COLUMN_OIDS.warnings),
      columnPresence(PROBE_COLUMN_OIDS.laneBias),
      columnPresence(PROBE_COLUMN_OIDS.minMax),
    ]);
    // A coluna de lanes ja foi sondada quando .8 estava vazio (segunda chance).
    const lanes = lanesRows.length > 0 ? true : await columnPresence(PROBE_COLUMN_OIDS.lanes);

    const scalarPower = scalarRows.length > 0;
    const snapshot: OpticalCapabilitySnapshot = {
      state: 'SUPPORTED',
      table: true,
      scalarPower,
      alarmThresholds: scalarPower || alarmRows.length > 0,
      warnings: warnings ?? input.profile.capabilities.warnings,
      laneBias: laneBias ?? input.profile.capabilities.laneBias,
      lanes: lanes ?? input.profile.capabilities.lanes,
      minMax: minMax ?? input.profile.capabilities.minMax,
      checkedAt: new Date().toISOString(),
    };
    const complete = warnings !== null && laneBias !== null && lanes !== null && minMax !== null;
    if (complete) this.store(input, snapshot, now);
    return snapshot;
  }

  private store(
    input: OpticalCapabilityProbeInput,
    snapshot: OpticalCapabilitySnapshot,
    now: number,
  ): void {
    this.cache.set(input.deviceId, {
      snapshot,
      fingerprint: input.fingerprint,
      expiresAt: now + this.ttlMs,
    });
  }
}
