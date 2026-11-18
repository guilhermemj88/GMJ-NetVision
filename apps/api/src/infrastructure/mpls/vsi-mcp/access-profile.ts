import { lstat, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { HostRecord } from '@gmj/shared';
import { isDiagnosticSshContext } from '../../ssh/ssh-context';
import { interfaceName as isInterfaceName } from '../vsi-diagnostic-policy';
import { VSI_MCP_OPERATIONS, type VsiMcpOperation } from './command-policy';

/**
 * Perfil de acesso SSH do diagnostico VSI por MCP.
 *
 * Arquivo SEPARADO do perfil do diagnostico legado (VSI_DIAGNOSTIC_ACCESS_FILE)
 * de proposito: ampliar operacoes/familias aqui nao altera o que o diagnostico
 * em producao ja esta autorizado a executar. Mesmas defesas: arquivo regular,
 * nao-symlink, <=64 KiB, sem escrita por grupo/outros, fingerprint de host
 * fixado, validade, prompts esperados e nenhuma credencial no arquivo.
 */

export const VSI_MCP_FAMILIES = [
  'S6730_V200',
  'S6750_YUNSHAN_V600',
  'NE8000_V800',
  'NE40E_V800',
] as const;

const prompt = z.string().regex(/^<[A-Za-z0-9_.:-]{1,120}>$/);

export const vsiMcpProfileSchema = z
  .object({
    hostId: z.string().min(1).max(100),
    endpoint: z.string().refine((v) => isIP(v) === 4),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(64),
    context: z.string().refine(isDiagnosticSshContext).nullable(),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
    initialPrompt: prompt,
    expectedPrompt: prompt,
    vendor: z.literal('HUAWEI'),
    /** Familia DECLARADA pelo operador; confirmada contra `display version` a cada sessao. */
    family: z.enum(VSI_MCP_FAMILIES),
    disablePagingTemporary: z.literal(true),
    validFrom: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    operations: z.array(z.enum(VSI_MCP_OPERATIONS)).min(1).max(VSI_MCP_OPERATIONS.length),
    /** Teto de interfaces lidas por execucao neste equipamento. */
    maxInterfaces: z.number().int().min(1).max(12).default(8),
    /** VLANs que `display vlan <id>` pode consultar neste host (lista fechada; vazio = VLAN_INFO bloqueado). */
    vlans: z.array(z.number().int().min(1).max(4094)).max(8).default([]),
    /** Interfaces NAO-AC (ex.: Eth-Trunk) cuja config pode ser lida como "transportadora" (lista fechada). */
    carrierInterfaces: z.array(z.string().refine(isInterfaceName)).max(8).default([]),
    /** E-Trunks que `display e-trunk <id>` pode consultar neste host (lista fechada; vazio = bloqueado). */
    eTrunks: z.array(z.number().int().min(1).max(16)).max(8).default([]),
  })
  .strict();

export type VsiMcpAccessProfile = z.infer<typeof vsiMcpProfileSchema>;

/**
 * Contas de SERVICO do diagnostico VSI (ex.: a do MCP), por username, em `VSI_MCP_SERVICE_ACCOUNTS` (separadas por virgula).
 * Uma conta listada nunca cria aprovacao e, se tiver papel ADMIN, nunca executa. Vazio = nenhuma conta marcada
 * (a separacao entre quem aprova e quem executa continua valendo para qualquer conta).
 */
export function vsiMcpServiceAccounts(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set((env.VSI_MCP_SERVICE_ACCOUNTS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function vsiMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VSI_MCP_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export async function readVsiMcpProfiles(filename: string | undefined): Promise<VsiMcpAccessProfile[]> {
  if (!filename) return [];
  try {
    const stat = await lstat(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 65536 ||
      (process.platform !== 'win32' && stat.mode & 0o022)
    )
      return [];
    return z
      .object({ profiles: z.array(vsiMcpProfileSchema).max(100) })
      .strict()
      .parse(JSON.parse(await readFile(filename, 'utf8'))).profiles;
  } catch {
    return [];
  }
}

export class VsiMcpProfileError extends Error {
  constructor(
    readonly code: 'NO_PROFILE' | 'AMBIGUOUS_PROFILE' | 'OPERATION_NOT_AUTHORIZED' | 'INVENTORY_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'VsiMcpProfileError';
  }
}

/**
 * Resolve o UNICO perfil valido do host. Qualquer divergencia entre inventario
 * (endpoint/porta/usuario/contexto) e perfil bloqueia: o perfil nao e um
 * "atalho" para alcançar outro destino.
 */
export function matchVsiMcpProfile(
  profiles: readonly VsiMcpAccessProfile[],
  host: HostRecord,
  requiredOperations: readonly (typeof VSI_MCP_OPERATIONS)[number][],
  now = Date.now(),
): VsiMcpAccessProfile {
  if (!host.sshEnabled || !host.ssh?.credentialConfigured || !isIP(host.ssh.host))
    throw new VsiMcpProfileError('INVENTORY_MISMATCH', 'SSH nao disponivel no inventario deste host');
  if (host.vendor && !/^(?:generic|unknown|n\/d)$/i.test(host.vendor) && !/huawei/i.test(host.vendor))
    throw new VsiMcpProfileError('INVENTORY_MISMATCH', 'Fabricante nao Huawei');

  const forHost = profiles.filter(
    (p) => p.hostId === host.id && Date.parse(p.validFrom) <= now && Date.parse(p.expiresAt) > now,
  );
  if (forHost.length === 0) throw new VsiMcpProfileError('NO_PROFILE', 'Host sem perfil de diagnostico VSI valido');
  const exact = forHost.filter(
    (p) =>
      p.endpoint === host.ssh!.host &&
      p.port === host.ssh!.port &&
      p.username === host.ssh!.username &&
      p.context === (host.ssh!.contextCommand ?? null),
  );
  if (exact.length === 0)
    throw new VsiMcpProfileError('INVENTORY_MISMATCH', 'Perfil nao corresponde ao SSH atual do inventario');
  if (exact.length > 1) throw new VsiMcpProfileError('AMBIGUOUS_PROFILE', 'Mais de um perfil para o host');
  const profile = exact[0]!;
  const missing = requiredOperations.filter((op) => !profile.operations.includes(op));
  if (missing.length)
    throw new VsiMcpProfileError('OPERATION_NOT_AUTHORIZED', `Operacao nao autorizada no perfil: ${missing.join(',')}`);
  return profile;
}

/** Escopo fechado por host: VLAN e interfaces transportadoras so as listadas no perfil. */
export function checkVsiMcpScope(profile: VsiMcpAccessProfile, operations: readonly VsiMcpOperation[]): void {
  for (const operation of operations) {
    if (operation.kind === 'VLAN_INFO' && !profile.vlans.includes(operation.vlanId))
      throw new VsiMcpProfileError('OPERATION_NOT_AUTHORIZED', `VLAN ${operation.vlanId} fora do escopo do perfil`);
    if (operation.kind === 'INTERFACE_CONFIG' && operation.role === 'CARRIER' && !profile.carrierInterfaces.includes(operation.interfaceName))
      throw new VsiMcpProfileError('OPERATION_NOT_AUTHORIZED', `Interface ${operation.interfaceName} fora do escopo do perfil`);
    // `display eth-trunk N` so para Eth-Trunk listado como transportadora; `display e-trunk N` so para id listado.
    if (operation.kind === 'ETH_TRUNK_INFO' && !profile.carrierInterfaces.includes(`Eth-Trunk${operation.trunkId}`))
      throw new VsiMcpProfileError('OPERATION_NOT_AUTHORIZED', `Eth-Trunk${operation.trunkId} fora do escopo do perfil`);
    if (operation.kind === 'ETRUNK_INFO' && !profile.eTrunks.includes(operation.eTrunkId))
      throw new VsiMcpProfileError('OPERATION_NOT_AUTHORIZED', `E-Trunk ${operation.eTrunkId} fora do escopo do perfil`);
  }
}
