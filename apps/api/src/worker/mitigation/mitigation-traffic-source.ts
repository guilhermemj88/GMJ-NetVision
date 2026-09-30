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

export interface MitigationTrafficSource {
  sample(target: MitigationTrafficTarget): Promise<bigint | null>;
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
  private readonly queues = new Map<string, (bigint | null)[]>();
  private readonly fallback = new Map<string, bigint | null>();

  push(profileId: string, value: bigint | null): void {
    const queue = this.queues.get(profileId) ?? [];
    queue.push(value);
    this.queues.set(profileId, queue);
  }

  setDefault(profileId: string, value: bigint | null): void {
    this.fallback.set(profileId, value);
  }

  async sample(target: MitigationTrafficTarget): Promise<bigint | null> {
    const queue = this.queues.get(target.profileId);
    if (queue && queue.length > 0) return queue.shift() ?? null;
    return this.fallback.get(target.profileId) ?? null;
  }
}