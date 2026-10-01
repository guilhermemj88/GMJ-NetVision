import type { MitigationRepository } from '../../infrastructure/bgp/mitigation/mitigation-repository';
import type { InterfaceTrafficReader } from '../../infrastructure/bgp/mitigation/prisma-interface-traffic-reader';

/**
 * Porta de TELEMETRIA do motor AUTO.
 *
 * O motor nunca usa `simulatedTrafficBps` em produção: ele pergunta a taxa ATUAL
 * do target a esta porta. Sem amostra confiável a resposta é `null` e o AUTO
 * NÃO escreve (fail-closed).
 */
export interface MitigationTrafficTarget {
  profileId: string;
  deviceId: string;
  interfaceId: string | null;
  bandwidthBps: bigint | null;
}

/**
 * Amostra de telemetria COM IDENTIDADE.
 *
 * `sampleKey` é a identidade da amostra no equipamento (timestamp da
 * `InterfaceMetricSample`). O motor só conta um novo sample de threshold quando
 * a identidade MUDA: 3 ticks lendo a MESMA amostra não valem 3 samples.
 */
export interface MitigationTrafficSample {
  bps: bigint;
  sampleKey: string;
  occurredAt: Date | null;
}

export interface MitigationTrafficSource {
  sample(target: MitigationTrafficTarget): Promise<bigint | null>;
  /** Obrigatório para o motor AUTO: identidade + valor da amostra. */
  sampleWithId(target: MitigationTrafficTarget): Promise<MitigationTrafficSample | null>;
}

/**
 * Fonte de produção: última amostra consolidada no runtime do target.
 *
 * Aceita apenas amostra FRESCA (mais nova que `maxAgeMs`); amostra velha é
 * telemetria morta e não pode disparar escrita.
 */
export class RuntimeTrafficSource implements MitigationTrafficSource {
  constructor(
    private readonly repository: Pick<MitigationRepository, 'getRuntime'>,
    private readonly maxAgeMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async sampleWithId(target: MitigationTrafficTarget): Promise<MitigationTrafficSample | null> {
    const runtime = await this.repository.getRuntime(target.profileId);
    const bps = await this.sample(target);
    if (bps === null) return null;
    const occurredAt = runtime?.lastSampleAt ?? null;
    return { bps, sampleKey: occurredAt ? occurredAt.toISOString() : `runtime:${bps.toString()}`, occurredAt };
  }

  async sample(target: MitigationTrafficTarget): Promise<bigint | null> {
    const runtime = await this.repository.getRuntime(target.profileId);
    if (runtime?.currentTrafficBps == null) return null;
    if (!runtime.lastSampleAt) return null;
    const age = this.now().getTime() - runtime.lastSampleAt.getTime();
    if (age < 0 || age > this.maxAgeMs) return null;
    return runtime.currentTrafficBps;
  }
}

/**
 * Fonte de produção do AUTO: telemetria REAL de interface.
 *
 * Direção: `tx` por padrão — o tráfego que a mitigação desvia é o que SAI em
 * direção ao cliente (prefixos anunciados por ele). Configurável por ambiente
 * (`MITIGATION_AUTO_TRAFFIC_DIRECTION=rx|tx`) para o operador fixar a leitura.
 *
 * Fail-closed: interface ausente, sem amostra, amostra velha (mais antiga que
 * `maxAgeMs`), NaN ou negativa => `null` e o AUTO não escreve.
 */
export class InterfaceTrafficSource implements MitigationTrafficSource {
  constructor(
    private readonly reader: InterfaceTrafficReader,
    private readonly options: {
      /**
       * Direção explícita POR PROFILE. Sem entrada para o profile NÃO há direção
       * => `null` => TELEMETRY_UNAVAILABLE => zero ACTIVATE (fail-closed).
       *
       * Medição real (BHNET-CEASA / Eth-Trunk1.3043) mostrou polaridade que não
       * confirma o default "download do cliente": rx ~40 Mbps x tx ~0,01-0,1 Mbps.
       * Por isso a direção é decisão do operador por target, não um default global.
       */
      directionByProfile?: Record<string, 'rx' | 'tx'>;
      /** Direção fixa (usada por testes/integrações que já a definem). */
      direction?: 'rx' | 'tx';
      maxAgeMs: number;
      now?: () => Date;
    },
  ) {}

  async sampleWithId(target: MitigationTrafficTarget): Promise<MitigationTrafficSample | null> {
    const bps = await this.sample(target);
    if (bps === null) return null;
    const row = target.interfaceId ? await this.reader.latestTraffic(target.interfaceId) : null;
    const occurredAt = row?.timestamp ?? null;
    return {
      bps,
      sampleKey: occurredAt ? occurredAt.toISOString() : `interface:${bps.toString()}`,
      occurredAt,
    };
  }

  async sample(target: MitigationTrafficTarget): Promise<bigint | null> {
    if (!target.interfaceId) return null;
    const direction = this.options.directionByProfile?.[target.profileId] ?? this.options.direction;
    if (!direction) return null;
    const row = await this.reader.latestTraffic(target.interfaceId);
    if (!row) return null;
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const age = now - row.timestamp.getTime();
    if (!Number.isFinite(age) || age < 0 || age > this.options.maxAgeMs) return null;
    const raw = direction === 'tx' ? row.txBps : row.rxBps;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
    return BigInt(Math.round(raw));
  }
}

/** Fonte determinística para teste: fila por profile + valor padrão opcional. */
export class SequenceTrafficSource implements MitigationTrafficSource {
  private readonly queues = new Map<string, { bps: bigint; sampleKey: string; occurredAt: Date | null }[]>();
  private readonly fallback = new Map<string, bigint | null>();
  private readonly sticky = new Map<string, { bps: bigint | null; sampleKey: string; occurredAt: Date | null }>();
  private sequence = 0;

  /** Cada `push` representa uma amostra NOVA do equipamento (identidade própria). */
  push(profileId: string, value: bigint | null, sampleKey?: string, occurredAt: Date | null = null): void {
    if (value === null) return;
    const queue = this.queues.get(profileId) ?? [];
    queue.push({ bps: value, sampleKey: sampleKey ?? `${profileId}-s${(this.sequence += 1)}`, occurredAt });
    this.queues.set(profileId, queue);
  }

  setDefault(profileId: string, value: bigint | null): void {
    this.fallback.set(profileId, value);
  }

  /** Amostra "colada": repetida em todos os ticks com a MESMA identidade. */
  setSticky(profileId: string, value: bigint | null, sampleKey = 'sticky', occurredAt: Date | null = null): void {
    this.sticky.set(profileId, { bps: value, sampleKey, occurredAt });
  }

  async sampleWithId(target: MitigationTrafficTarget): Promise<MitigationTrafficSample | null> {
    const queue = this.queues.get(target.profileId);
    if (queue && queue.length > 0) {
      const item = queue.shift() ?? null;
      if (!item) return null;
      return { bps: item.bps, sampleKey: item.sampleKey, occurredAt: item.occurredAt };
    }
    const sticky = this.sticky.get(target.profileId);
    if (sticky) {
      if (sticky.bps === null) return null;
      return { bps: sticky.bps, sampleKey: sticky.sampleKey, occurredAt: sticky.occurredAt };
    }
    const fallback = this.fallback.get(target.profileId) ?? null;
    if (fallback === null) return null;
    return { bps: fallback, sampleKey: 'fallback', occurredAt: null };
  }

  async sample(target: MitigationTrafficTarget): Promise<bigint | null> {
    const withId = await this.sampleWithId(target);
    return withId?.bps ?? null;
  }
}