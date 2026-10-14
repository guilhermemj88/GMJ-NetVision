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

export type SweepAddressFamily = 'IPV4' | 'IPV6';

export interface AutoDescriptionSweepProfile {
  id: string;
  persisted: boolean;
  addressFamily: SweepAddressFamily;
  mode: MitigationProfileMode;
  autoModeExempt: boolean;
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
}

export interface MitigationAutoDescriptionSweepDeps {
  enabled: boolean;
  /** Familias habilitadas para promocao automatica. Default: `['IPV4']`. */
  families?: readonly SweepAddressFamily[];
  listProfiles(): Promise<AutoDescriptionSweepProfile[]>;
  setMode(id: string, mode: MitigationProfileMode): Promise<void>;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_FAMILIES: readonly SweepAddressFamily[] = ['IPV4'];

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
    };
    if (!this.deps.enabled) return result;
    const families = this.deps.families ?? DEFAULT_FAMILIES;

    const profiles = await this.deps.listProfiles();
    for (const profile of profiles) {
      if (!profile.persisted) continue;
      result.evaluated += 1;
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
          await this.deps.setMode(profile.id, 'ALERT_ONLY');
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
        await this.deps.setMode(profile.id, 'AUTO');
        result.promoted.push(profile.id);
        this.log('promocao automatica por DESCRIPTION', profile);
        continue;
      }
      if (profile.autoState === 'OFF' && profile.mode === 'AUTO') {
        await this.deps.setMode(profile.id, 'ALERT_ONLY');
        result.demoted.push(profile.id);
        this.log('autorizacao perdida: novas ativacoes AUTO desabilitadas', profile);
      }
    }
    return result;
  }

  private log(message: string, profile: AutoDescriptionSweepProfile): void {
    this.deps.logger?.(`auto: sweep DESCRIPTION - ${message}`, {
      profileId: profile.id,
      mode: profile.mode,
      addressFamily: profile.addressFamily,
      autoState: profile.autoState,
      reason: profile.autoStateReason,
    });
  }
}
