import type { MitigationProfileMode } from './mitigation-types';
import type { MitigationAutoState } from './mitigation-auto-authorization';

// AUTO-ALL: sweep de sincronizacao do modo AUTO derivado da DESCRIPTION.
//
// Idempotente e de escopo minimo: escreve SOMENTE `mode` (ALERT_ONLY <-> AUTO).
// Nunca toca runtime, mitigacao, Huawei, exclusoes ou direcao de telemetria.
//
//   READY  + mode != AUTO  -> promove para AUTO
//   OFF    + mode == AUTO  -> demove para ALERT_ONLY (sem REMOVE de mitigacao;
//                             o motor apenas para de iniciar novas ativacoes)
//   EXEMPT + mode == AUTO  -> devolve para ALERT_ONLY (pin explicito do operador)
//   BLOCKED                 -> NAO muda modo; reporta o motivo (a UI mostra)
//   DISABLED                -> intocado
//
// "OFF" so aparece quando os DADOS PERSISTIDOS perderam a autorizacao (fonte da
// banda != DESCRIPTION/banda nula/exclusao). Falha temporaria de discovery NAO
// altera dados persistidos - logo nao demove nada (nao confundir falha com
// retirada confirmada de banda).
//
// FAMILIA: a promocao automatica e LIMITADA por familia. O default e SOMENTE
// IPv4 (fase atual: IPv6 fica em ALERT_ONLY, sem ativacao real) e o operador
// pode estender com `MITIGATION_AUTO_DESCRIPTION_FAMILIES=IPV4,IPV6` quando a
// acao de mitigacao IPv6 estiver validada. Fail-closed por padrao.
//
// LOTES: a promocao e GRADUAL e a ordem e DETERMINISTICA (policy, interface,
// id). A semantica de `MITIGATION_AUTO_DESCRIPTION_BATCH_SIZE` e UNAMBIGUA:
//   - ausente/invalido (negativo, decimal, texto) -> 5 (fail-safe);
//   - `0`            -> SEGURA (hold): nesta execucao NADA e promovido;
//   - 1..N           -> promove no maximo N perfis por execucao;
//   - `unlimited`    -> sem limite (promocao de todos os elegiveis de uma vez).
// Interrupcao definitiva das promocoes = `MITIGATION_AUTO_DESCRIPTION_ENABLED=0`
// (a flag de autorizacao). A graduacao e protecao de implantacao, nunca
// exigencia permanente de promocao manual.
//
// CONCORRENCIA: `run()` nunca executa duas vezes em paralelo no mesmo processo
// (rehydrate + intervalo): a segunda chamada concorrente devolve
// `skippedConcurrent=true` sem promover nada - dois lotes simultaneos nao podem
// "atropelar" o limite configurado.
//
// REINICIO: a ordem e deterministica e o que ja foi promovido esta persistido
// (mode + proveniencia), entao apos um restart o sweep CONTINUA do lote
// seguinte; a proveniencia mantem os promovidos sob o controle de execucao.
//
// PROVENIENCIA: cada promocao marca `autoPromotedBySweep=true` (e cada demote
// limpa a marca). E essa marca que permite ao motor pausar NOVAS ativacoes
// automaticas sem tocar no AUTO manual (ex.: BHNET-3043).

export type SweepAddressFamily = 'IPV4' | 'IPV6';

/** `0` = segurar (hold); numero > 0 = lote; `unlimited` = sem limite. */
export type SweepBatchSize = number | 'unlimited';

export const DEFAULT_SWEEP_BATCH_SIZE = 5;

/**
 * Converte o valor do ENV na semantica do lote. Valor ausente ou invalido cai
 * no default SEGURO (5) - nunca em "sem limite" nem em "segurar" por acidente.
 * Aceita APENAS digitos decimais (sem sinal, decimal, hexa ou notacao
 * cientifica) ou as palavras `unlimited`/`all`.
 */
export function parseSweepBatchSize(raw: string | null | undefined): SweepBatchSize {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return DEFAULT_SWEEP_BATCH_SIZE;
  if (value === 'unlimited' || value === 'all') return 'unlimited';
  if (!/^\d+$/.test(value)) return DEFAULT_SWEEP_BATCH_SIZE;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_SWEEP_BATCH_SIZE;
  return parsed;
}

export interface AutoDescriptionSweepProfile {
  id: string;
  persisted: boolean;
  addressFamily: SweepAddressFamily;
  /** Ordenacao deterministica dos lotes (policy + interface). */
  policyName?: string | null;
  interfaceName?: string | null;
  mode: MitigationProfileMode;
  autoModeExempt: boolean;
  /** `true` = modo AUTO autorizado pelo proprio sweep (proveniencia). */
  promotedBySweep?: boolean;
  autoState: MitigationAutoState;
  autoStateReason: string | null;
}

export interface AutoDescriptionSweepResult {
  enabled: boolean;
  evaluated: number;
  promoted: string[];
  demoted: string[];
  blocked: { profileId: string; reason: string | null }[];
  skippedExempt: number;
  skippedDisabled: number;
  /** Perfis fora das familias habilitadas (ex.: IPv6 na fase IPv4-only). */
  skippedFamily: number;
  /** Elegiveis que ficaram para os proximos lotes (interrompiveis). */
  heldByBatch: number;
  /** `true` = execucao SEGURADA por `BATCH_SIZE=0` (nada foi promovido). */
  held: boolean;
  /** `true` = ja existia uma execucao em andamento (nada foi feito). */
  skippedConcurrent: boolean;
  /** Lote efetivo desta execucao (auditoria do rollout). */
  batchSize: SweepBatchSize;
  /** Total de perfis com proveniencia de sweep ANTES desta execucao. */
  promotedTotalBefore: number;
  /** Total de perfis com proveniencia de sweep DEPOIS desta execucao. */
  promotedTotal: number;
}

export interface MitigationAutoDescriptionSweepDeps {
  enabled: boolean;
  /** Familias habilitadas para promocao automatica. Default: `['IPV4']`. */
  families?: readonly SweepAddressFamily[];
  /** Lote por execucao (ver `SweepBatchSize`). Default: 5. */
  batchSize?: SweepBatchSize;
  listProfiles(): Promise<AutoDescriptionSweepProfile[]>;
  setMode(id: string, mode: MitigationProfileMode): Promise<void>;
  /** Marca/limpa a proveniencia do AUTO (sweep x manual). */
  setProvenance(id: string, promoted: boolean): Promise<void>;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_FAMILIES: readonly SweepAddressFamily[] = ['IPV4'];

export class MitigationAutoDescriptionSweep {
  /** Guarda de concorrencia: uma execucao por vez NESTE processo. */
  private running = false;

  constructor(private readonly deps: MitigationAutoDescriptionSweepDeps) {}

  async run(): Promise<AutoDescriptionSweepResult> {
    const result: AutoDescriptionSweepResult = {
      enabled: this.deps.enabled,
      evaluated: 0,
      promoted: [],
      demoted: [],
      blocked: [],
      skippedExempt: 0,
      skippedDisabled: 0,
      skippedFamily: 0,
      heldByBatch: 0,
      held: false,
      skippedConcurrent: false,
      batchSize: this.deps.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE,
      promotedTotalBefore: 0,
      promotedTotal: 0,
    };
    if (!this.deps.enabled) return result;
    if (this.running) {
      result.skippedConcurrent = true;
      this.deps.logger?.('auto: sweep DESCRIPTION - execucao anterior ainda em andamento', {
        skippedConcurrent: true,
      });
      return result;
    }
    this.running = true;
    try {
      return await this.runOnce(result);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(result: AutoDescriptionSweepResult): Promise<AutoDescriptionSweepResult> {
    const families = this.deps.families ?? DEFAULT_FAMILIES;
    const batchSize = this.deps.batchSize ?? DEFAULT_SWEEP_BATCH_SIZE;

    const profiles = await this.deps.listProfiles();
    const persisted = profiles.filter((profile) => profile.persisted);
    result.evaluated = persisted.length;
    result.promotedTotalBefore = persisted.filter(
      (profile) => profile.promotedBySweep === true,
    ).length;

    // 1) Elegiveis para LOTES: ordem DETERMINISTICA (policy, interface, id).
    const eligible = persisted
      .filter(
        (profile) =>
          families.includes(profile.addressFamily) &&
          profile.autoState === 'READY' &&
          profile.mode !== 'AUTO',
      )
      .sort(
        (left, right) =>
          (left.policyName ?? '').localeCompare(right.policyName ?? '') ||
          (left.interfaceName ?? '').localeCompare(right.interfaceName ?? '') ||
          left.id.localeCompare(right.id),
      );
    // `0` = SEGURAR (hold): nada e promovido nesta execucao.
    const batch =
      batchSize === 0
        ? []
        : batchSize === 'unlimited'
          ? eligible
          : eligible.slice(0, batchSize);
    result.heldByBatch = eligible.length - batch.length;
    result.held = batchSize === 0 && eligible.length > 0;
    result.batchSize = batchSize;

    let demotedWithProvenance = 0;

    for (const profile of persisted) {
      // Fase IPv4-only (default): perfis IPv6 ficam em ALERT_ONLY - o sweep
      // nunca troca o modo de uma familia fora da lista habilitada.
      if (!families.includes(profile.addressFamily)) {
        result.skippedFamily += 1;
        this.log('familia fora da fase: modo preservado', profile);
        continue;
      }
      if (profile.autoState === 'DISABLED') {
        result.skippedDisabled += 1;
        continue;
      }
      if (profile.autoState === 'EXEMPT') {
        result.skippedExempt += 1;
        if (profile.mode === 'AUTO') {
          const hadProvenance = profile.promotedBySweep === true;
          await this.deps.setMode(profile.id, 'ALERT_ONLY');
          await this.deps.setProvenance(profile.id, false);
          if (hadProvenance) demotedWithProvenance += 1;
          result.demoted.push(profile.id);
          this.log('excecao manual: modo devolvido para ALERT_ONLY', profile);
        }
        continue;
      }
      if (profile.autoState === 'BLOCKED') {
        result.blocked.push({ profileId: profile.id, reason: profile.autoStateReason });
        continue;
      }
      if (profile.autoState === 'READY' && profile.mode !== 'AUTO') {
        if (!batch.some((item) => item.id === profile.id)) continue; // fica para o proximo lote
        await this.deps.setMode(profile.id, 'AUTO');
        await this.deps.setProvenance(profile.id, true);
        result.promoted.push(profile.id);
        this.log('promocao automatica por DESCRIPTION (lote)', profile);
        continue;
      }      if (profile.autoState === 'OFF' && profile.mode === 'AUTO') {
        const hadProvenance = profile.promotedBySweep === true;
        await this.deps.setMode(profile.id, 'ALERT_ONLY');
        await this.deps.setProvenance(profile.id, false);
        if (hadProvenance) demotedWithProvenance += 1;
        result.demoted.push(profile.id);
        this.log('autorizacao perdida: novas ativacoes AUTO desabilitadas', profile);
      }
    }
    result.promotedTotal =
      result.promotedTotalBefore + result.promoted.length - demotedWithProvenance;
    return result;
  }

  private log(message: string, profile: AutoDescriptionSweepProfile): void {
    this.deps.logger?.(`auto: sweep DESCRIPTION - ${message}`, {
      profileId: profile.id,
      policyName: profile.policyName ?? null,
      interfaceName: profile.interfaceName ?? null,
      mode: profile.mode,
      addressFamily: profile.addressFamily,
      autoState: profile.autoState,
      promotedBySweep: profile.promotedBySweep === true,
      reason: profile.autoStateReason,
    });
  }
}
