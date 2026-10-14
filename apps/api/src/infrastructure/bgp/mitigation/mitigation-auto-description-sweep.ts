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
// LOTES: a promocao e GRADUAL (`batchSize`, default 5). A ordem e
// DETERMINISTICA (policy, interface, id) e `batchSize=0` significa "sem limite"
// (a graduacao e protecao de implantacao, nunca exigencia permanente). Basta
// desligar a flag de autorizacao para interromper a PROXIMA promocao - nenhuma
// mitigacao e removida e nenhum modo ja promovido e alterado.
//
// PROVENIENCIA: cada promocao marca `autoPromotedBySweep=true` (e cada demote
// limpa a marca). E essa marca que permite ao motor pausar NOVAS ativacoes
// automaticas sem tocar no AUTO manual (ex.: BHNET-3043).

export type SweepAddressFamily = 'IPV4' | 'IPV6';

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
  /** Total de perfis com proveniencia de sweep ANTES desta execucao. */
  promotedTotalBefore: number;
  /** Total de perfis com proveniencia de sweep DEPOIS desta execucao. */
  promotedTotal: number;
}

export interface MitigationAutoDescriptionSweepDeps {
  enabled: boolean;
  /** Familias habilitadas para promocao automatica. Default: `['IPV4']`. */
  families?: readonly SweepAddressFamily[];
  /**
   * Maximo de PROMOCOES por execucao (lote). `0` = sem limite. Default: 5.
   */
  batchSize?: number;
  listProfiles(): Promise<AutoDescriptionSweepProfile[]>;
  setMode(id: string, mode: MitigationProfileMode): Promise<void>;
  /** Marca/limpa a proveniencia do AUTO (sweep x manual). */
  setProvenance(id: string, promoted: boolean): Promise<void>;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_FAMILIES: readonly SweepAddressFamily[] = ['IPV4'];
const DEFAULT_BATCH_SIZE = 5;

export class MitigationAutoDescriptionSweep {
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
      promotedTotalBefore: 0,
      promotedTotal: 0,
    };
    if (!this.deps.enabled) return result;
    const families = this.deps.families ?? DEFAULT_FAMILIES;
    const batchSize = this.deps.batchSize ?? DEFAULT_BATCH_SIZE;

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
    const batch = batchSize > 0 ? eligible.slice(0, batchSize) : eligible;
    result.heldByBatch = eligible.length - batch.length;

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
      }
      if (profile.autoState === 'OFF' && profile.mode === 'AUTO') {
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
