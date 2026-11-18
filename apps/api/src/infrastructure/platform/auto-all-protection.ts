/**
 * A1-e (3a auditoria): equipamentos PROTEGIDOS pelo AUTO-ALL nao recebem
 * habilitacao do fallback CLI do MPLS sem politica explicita e aprovacao
 * futura.
 *
 * O AUTO-ALL executa mitigacao real nesses equipamentos. Abrir sessao de CLI
 * para descoberta MPLS concorre com as VTY que a mitigacao usa e amplia a
 * superficie de erro exatamente onde uma escrita pode acontecer. A regra e
 * fail-closed: na duvida, protegido.
 *
 * Este modulo e puro (sem banco, sem SSH) para poder ser usado pela rota, pelo
 * pre-flight e pelos testes.
 */
export type AutoAllProtectionBy = 'SINGLE_PILOT_F1A' | 'MITIGATION_ALLOWLIST' | 'AUTO_PROFILE';

export type AutoAllProtection =
  | { protected: true; by: AutoAllProtectionBy; detail: string }
  | { protected: false };

export interface AutoAllProtectionInput {
  deviceId: string;
  hostname: string;
  /** MITIGATION_ALLOWED_DEVICE_IDS: allowlist de leitura/escrita real. */
  mitigationAllowlist: readonly string[];
  /** Devices com algum profile de mitigacao em modo AUTO. */
  autoProfileDeviceIds: readonly string[];
  /** Alvo unico do piloto (F1A). Default: constante do piloto. */
  singlePilot?: { deviceId: string; hostname: string };
}

export function evaluateAutoAllProtection(input: AutoAllProtectionInput): AutoAllProtection {
  const pilot = input.singlePilot;
  if (pilot) {
    const host = input.hostname.trim().toLowerCase();
    if (
      (pilot.deviceId && input.deviceId === pilot.deviceId) ||
      (pilot.hostname && host === pilot.hostname.trim().toLowerCase())
    ) {
      return {
        protected: true,
        by: 'SINGLE_PILOT_F1A',
        detail: `piloto AUTO-ALL (${pilot.hostname})`,
      };
    }
  }
  if (input.mitigationAllowlist.includes(input.deviceId)) {
    return {
      protected: true,
      by: 'MITIGATION_ALLOWLIST',
      detail: 'autorizado em MITIGATION_ALLOWED_DEVICE_IDS',
    };
  }
  if (input.autoProfileDeviceIds.includes(input.deviceId)) {
    return {
      protected: true,
      by: 'AUTO_PROFILE',
      detail: 'possui profile de mitigacao em modo AUTO',
    };
  }
  return { protected: false };
}
