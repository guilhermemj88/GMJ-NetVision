import { z } from 'zod';

/**
 * Contratos das ferramentas MCP de diagnostico VSI/MPLS.
 * Todos `.strict()`: campo desconhecido e erro (nao e ignorado silenciosamente),
 * e nenhum campo aceita texto livre que vire comando.
 */

export const hostIdSchema = z.string().min(1).max(100);
export const vsiNameSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'Nome de VSI invalido');
export const interfaceNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,32}\d(?:[\d/]*\d)?(?:\.\d+)?$/, 'Nome de interface invalido');
const approvalIdSchema = z.uuid();
const sourceSchema = z.enum(['PERSISTED', 'LIVE']).default('PERSISTED');

export const listVsiInput = z
  .object({
    hostId: hostIdSchema,
    source: sourceSchema,
    q: z.string().max(64).regex(/^[A-Za-z0-9_.:-]*$/).optional(),
    state: z.enum(['UP', 'DOWN']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    approvalId: approvalIdSchema.optional(),
    /** Somente source=LIVE. VERSION = apenas `display version` (identifica a plataforma). */
    probe: z.enum(['LIST', 'VERSION']).default('LIST'),
    homologation: z.boolean().default(false),
  })
  .strict();

const vsiRef = { hostId: hostIdSchema, vsiName: vsiNameSchema };

export const getVsiDetailsInput = z
  .object({ ...vsiRef, source: sourceSchema, approvalId: approvalIdSchema.optional() })
  .strict();
export const getVsiAcBindingsInput = getVsiDetailsInput;
export const getVsiPseudowiresInput = getVsiDetailsInput;

export const getVsiMacTableInput = z
  .object({
    ...vsiRef,
    approvalId: approvalIdSchema,
    homologation: z.boolean().default(false),
    maxEntries: z.number().int().min(1).max(500).default(200),
  })
  .strict();

export const getVsiVlanEncapsulationInput = z
  .object({
    ...vsiRef,
    approvalId: approvalIdSchema,
    /** Opcional: limita/define quais interfaces ler; evita a segunda sessao SSH. */
    interfaces: z.array(interfaceNameSchema).min(1).max(8).optional(),
    /** Opcional: VLAN a consultar (`display vlan <id>`); precisa constar na lista fechada do perfil do host. */
    vlanId: z.number().int().min(1).max(4094).optional(),
    /** Opcional: portas transportadoras (ex.: Eth-Trunk1) cuja config sera lida; lista fechada no perfil do host. */
    carrierInterfaces: z.array(interfaceNameSchema).min(1).max(4).optional(),
    homologation: z.boolean().default(false),
  })
  .strict();

export const diagnoseVsiInput = z
  .object({
    ...vsiRef,
    approvalId: approvalIdSchema,
    includeMac: z.boolean().default(true),
    interfaces: z.array(interfaceNameSchema).min(1).max(8).optional(),
    /** Opcional: VLAN a consultar (`display vlan <id>`); precisa constar na lista fechada do perfil do host. */
    vlanId: z.number().int().min(1).max(4094).optional(),
    /** Opcional: portas transportadoras (ex.: Eth-Trunk1) cuja config sera lida; lista fechada no perfil do host. */
    carrierInterfaces: z.array(interfaceNameSchema).min(1).max(4).optional(),
    /** Opcional: E-Trunks a consultar (`display e-trunk <id>`); lista fechada no perfil do host. Para cada Eth-Trunk em `carrierInterfaces` tambem e lido `display eth-trunk <N>`. */
    eTrunkIds: z.array(z.number().int().min(1).max(16)).min(1).max(4).optional(),
    homologation: z.boolean().default(false),
  })
  .strict();

const endpointInput = z
  .object({
    ...vsiRef,
    approvalId: approvalIdSchema,
    /** IP do peer, visto DESTA ponta, que identifica o PW do circuito. */
    peerAddress: z.ipv4().optional(),
    interfaces: z.array(interfaceNameSchema).min(1).max(8).optional(),
  })
  .strict();

export const compareVsiEndpointsInput = z
  .object({
    a: endpointInput,
    b: endpointInput,
    includeMac: z.boolean().default(true),
    homologation: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !(v.a.hostId === v.b.hostId && v.a.vsiName === v.b.vsiName), {
    message: 'As duas pontas devem ser distintas',
  });

export const VSI_MCP_TOOLS = {
  list_vsi: listVsiInput,
  get_vsi_details: getVsiDetailsInput,
  get_vsi_ac_bindings: getVsiAcBindingsInput,
  get_vsi_pseudowires: getVsiPseudowiresInput,
  get_vsi_mac_table: getVsiMacTableInput,
  get_vsi_vlan_encapsulation: getVsiVlanEncapsulationInput,
  diagnose_vsi: diagnoseVsiInput,
  compare_vsi_endpoints: compareVsiEndpointsInput,
} as const;
export type VsiMcpToolName = keyof typeof VSI_MCP_TOOLS;
export type ToolInput<T extends VsiMcpToolName> = z.infer<(typeof VSI_MCP_TOOLS)[T]>;

/** Ferramentas que abrem SSH (exigem papel ADMIN/OPERATOR + aprovacao one-shot). */
export const LIVE_ONLY_TOOLS: ReadonlySet<VsiMcpToolName> = new Set([
  'get_vsi_mac_table',
  'get_vsi_vlan_encapsulation',
  'diagnose_vsi',
  'compare_vsi_endpoints',
]);

export type ToolStatus = 'OK' | 'INCONCLUSIVE' | 'NOT_SUPPORTED' | 'ERROR';

export interface ToolEvidence {
  id: string;
  source: 'PERSISTED_SNMP' | 'LIVE_SSH';
  hostId: string;
  hostName: string;
  collectedAt: string;
  /** Instante da ultima observacao no equipamento (persistido); null para SSH ao vivo. */
  observedAt: string | null;
  command: string | null;
  sha256: string | null;
  bytes: number;
  complete: boolean;
  /** Trecho truncado (nunca a saida inteira) para auditoria humana. */
  excerpt: string | null;
}

export interface ToolError {
  code: string;
  message: string;
  hostId?: string;
}

/**
 * Problema de COLETA (nao e falha do servico): saida incompleta, operacao nao executada ou erro
 * da sessao. Derivado de `evidence`/`skipped`/`errors`; nao altera `status` nem os achados.
 */
export interface ToolCollectionIssue {
  code: 'OUTPUT_INCOMPLETE' | 'OPERATION_SKIPPED' | 'COLLECTION_ERROR';
  hostId: string | null;
  /** Comando enviado (OUTPUT_INCOMPLETE), tipo da operacao (OPERATION_SKIPPED) ou null. */
  command: string | null;
  evidenceId: string | null;
  detail: string;
}

export interface ToolEnvelope<T = unknown> {
  tool: VsiMcpToolName;
  status: ToolStatus;
  generatedAt: string;
  hostId: string | null;
  vsiName: string | null;
  data: T | null;
  evidence: ToolEvidence[];
  skipped: Array<{ hostId: string; command: string; reason: string; note: string }>;
  warnings: string[];
  errors: ToolError[];
  /** Aditivo: mesma informacao de `evidence[].complete`, `skipped` e `errors`, em forma estruturada. */
  collectionIssues: ToolCollectionIssue[];
}

/** Escopo do aprovacao one-shot: distinto do escopo (vsiId) do diagnostico legado. */
export const approvalScope = (vsiName?: string): string =>
  vsiName === undefined ? 'vsi-host:discovery' : `vsi-name:${vsiName}`;
