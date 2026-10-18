/**
 * IDENTIDADE DA INSTALAÇÃO — decisão de disponibilidade por instalação.
 *
 * Regra do produto (adendo de identificação da IMPLANTAR):
 *  - a instalação **IMPLANTAR** disponibiliza permanentemente o módulo de
 *    mitigação DDoS (aba em BGP → Mitigação DDoS e rotas autorizadas);
 *  - as demais instalações **não** disponibilizam o módulo, salvo opt-in
 *    explícito por flag (`NEXT_PUBLIC_DDOS_MITIGATION_UI=true`).
 *
 * A identidade vem de duas fontes, nesta ordem:
 *  1. `NETVISION_INSTALLATION_ID` (identidade configurada da instalação) —
 *     vence sempre que reconhecida;
 *  2. `hostname` do servidor (`netvision-implantar`), normalizado (minúsculo,
 *     sem domínio).
 *
 * IMPORTANTE — isto é DISPONIBILIDADE DE INTERFACE, não autorização. O hostname
 * sozinho nunca é mecanismo de segurança: a API continua exigindo sessão
 * autenticada e o RBAC existente em cada rota de mitigação. Quem chama esta
 * função decide apenas se a entrada de UI aparece.
 *
 * Função pura: sem I/O, sem `process.env`, sem relógio — totalmente testável.
 */

/** Identificadores de instalação reconhecidos pelo produto. */
export type NetvisionInstallationId = 'IMPLANTAR' | 'UNKNOWN';

/** Hostname canônico da instalação IMPLANTAR. */
export const IMPLANTAR_HOSTNAME = 'netvision-implantar';

/** Identidade explícita aceita em `NETVISION_INSTALLATION_ID`. */
export const IMPLANTAR_INSTALLATION_ID = 'implantar';

/** Como a identidade foi determinada. */
export type InstallationIdentitySource = 'installation-id' | 'hostname' | 'none';

export interface InstallationIdentity {
  id: NetvisionInstallationId;
  source: InstallationIdentitySource;
  /** Hostname normalizado usado na decisão (null quando não informado). */
  hostname: string | null;
}

export interface InstallationIdentityInput {
  /** `hostname` do servidor que executa a instalação. */
  hostname?: string | null;
  /** Valor de `NETVISION_INSTALLATION_ID` (identidade configurada). */
  installationId?: string | null;
}

/** Minúsculas, sem espaços e sem o domínio (`host.example.com` → `host`). */
export function normalizeInstallationToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutDomain = trimmed.split('.')[0] ?? trimmed;
  return withoutDomain || null;
}

/** Identidade explícita reconhecida (aceita `implantar`, `IMPLANTAR`, etc.). */
export function parseInstallationId(value: unknown): NetvisionInstallationId {
  const token = normalizeInstallationToken(value);
  return token === IMPLANTAR_INSTALLATION_ID ? 'IMPLANTAR' : 'UNKNOWN';
}

/**
 * Resolve a identidade da instalação: identidade configurada vence o hostname,
 * que por sua vez vence o desconhecido. Nada aqui é sensível a caixa/domínio.
 */
export function resolveInstallationIdentity(
  input: InstallationIdentityInput = {},
): InstallationIdentity {
  const hostname = normalizeInstallationToken(input.hostname);
  const configured = parseInstallationId(input.installationId);
  if (configured === 'IMPLANTAR') {
    return { id: 'IMPLANTAR', source: 'installation-id', hostname };
  }
  if (hostname !== null && hostname === IMPLANTAR_HOSTNAME) {
    return { id: 'IMPLANTAR', source: 'hostname', hostname };
  }
  return { id: 'UNKNOWN', source: 'none', hostname };
}

/** Módulos operacionais cuja disponibilidade depende da instalação. */
export type InstallationModule = 'DDOS_MITIGATION_UI';

/** Por que a disponibilidade foi decidida assim (para logs/diagnóstico). */
export type InstallationModuleReason =
  /** Instalação IMPLANTAR: disponível permanentemente. */
  | 'installation-implantar'
  /** Outra instalação com opt-in explícito pela flag. */
  | 'explicit-flag'
  /** Outra instalação sem opt-in: indisponível. */
  | 'installation-not-implantar';

export interface InstallationModuleAvailability {
  enabled: boolean;
  reason: InstallationModuleReason;
  identity: InstallationIdentity;
  /** Valores normalizados de entrada (útil em diagnóstico; nada sensível). */
  inputs: {
    hostname: string | null;
    installationId: string | null;
    flag: string | null;
  };
}

export interface InstallationModuleInput extends InstallationIdentityInput {
  /**
   * Valor bruto da flag de opt-in (`NEXT_PUBLIC_DDOS_MITIGATION_UI`). Aceita
   * booleano ou string; somente `true`/`"true"` liga o módulo.
   */
  flag?: string | boolean | null;
}

function flagIsTrue(flag: string | boolean | null | undefined): boolean {
  if (flag === true) return true;
  if (typeof flag !== 'string') return false;
  return flag.trim().toLowerCase() === 'true';
}

/**
 * Disponibilidade do módulo de mitigação DDoS na interface.
 *
 * Precedência:
 *  1. IMPLANTAR (identidade configurada ou hostname) → SEMPRE habilitado, mesmo
 *     que a flag de build esteja ausente ou `false` (regra do operador: a aba
 *     não pode ser desligada por um build feito sem a variável);
 *  2. outra instalação + flag `true` → habilitado (opt-in explícito);
 *  3. caso contrário → desabilitado.
 */
export function resolveInstallationModuleAvailability(
  _module: InstallationModule,
  input: InstallationModuleInput = {},
): InstallationModuleAvailability {
  const identity = resolveInstallationIdentity(input);
  const flag = flagIsTrue(input.flag);
  const inputs = {
    hostname: identity.hostname,
    installationId: normalizeInstallationToken(input.installationId),
    flag: flag ? 'true' : null,
  };
  if (identity.id === 'IMPLANTAR') {
    return { enabled: true, reason: 'installation-implantar', identity, inputs };
  }
  if (flag) {
    return { enabled: true, reason: 'explicit-flag', identity, inputs };
  }
  return { enabled: false, reason: 'installation-not-implantar', identity, inputs };
}

/** Atalho: a aba BGP → Mitigação DDoS deve aparecer nesta instalação? */
export function isDdosMitigationModuleEnabled(input: InstallationModuleInput = {}): boolean {
  return resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', input).enabled;
}
