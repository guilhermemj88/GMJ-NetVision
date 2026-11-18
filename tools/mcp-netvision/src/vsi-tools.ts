import { z } from "zod";

/**
 * Ferramentas MCP de diagnostico VSI/MPLS (somente consulta).
 *
 * Camada fina: valida a forma da entrada e repassa a `POST /api/vsi-mcp/tools/:tool`.
 * Toda a autorizacao (papel, aprovacao one-shot, perfil de acesso por host),
 * politica de comandos (somente `display`), limites e evidencia ficam na API.
 *
 * Propositalmente NAO existe ferramenta para criar a aprovacao one-shot: ela
 * continua sendo um ato humano (ADMIN) e nao pode ser concedida pelo modelo.
 * Tambem NAO existe parametro de comando/texto livre em nenhuma ferramenta.
 */

const hostId = z.string().min(1).max(100).describe("ID do host no NetVision (list_hosts).");
const vsiName = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).describe("Nome exato da VSI, ex.: L2-PPPOE-3901.");
const approvalId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .describe("Aprovacao one-shot criada por um ADMIN para este host e esta VSI. Consumida na execucao.");
const interfaces = z
  .array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,32}\d(?:[\d/]*\d)?(?:\.\d+)?$/))
  .min(1)
  .max(8)
  .optional()
  .describe("Opcional: interfaces cuja configuracao deve ser lida. Evita uma segunda sessao SSH.");
const source = z
  .enum(["PERSISTED", "LIVE"])
  .default("PERSISTED")
  .describe("PERSISTED = dados SNMP ja coletados (sem SSH). LIVE = SSH somente-leitura sob demanda (exige approvalId).");
const homologation = z
  .boolean()
  .default(false)
  .describe("Somente ADMIN. Libera comandos ainda CANDIDATOS (sem captura real) para homologacao; o resultado nao deve ser usado como veredito.");
const peerAddress = z
  .string()
  .regex(/^(?:\d{1,3}\.){3}\d{1,3}$/)
  .optional()
  .describe("IP do peer do circuito visto DESTA ponta (necessario se houver mais de um PW).");

const vlanId = z.number().int().min(1).max(4094).optional().describe("Opcional: VLAN a consultar (display vlan <id>). Precisa constar na lista fechada do perfil do host.");
const carrierInterfaces = z
  .array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,32}\d(?:[\d/]*\d)?(?:\.\d+)?$/))
  .min(1)
  .max(4)
  .optional()
  .describe("Opcional: portas transportadoras (ex.: Eth-Trunk1) cuja config sera lida. Precisam constar na lista fechada do perfil do host.");
const eTrunkIds = z
  .array(z.number().int().min(1).max(16))
  .min(1)
  .max(4)
  .optional()
  .describe("Opcional: E-Trunks a consultar (display e-trunk <id>); para cada Eth-Trunk em carrierInterfaces tambem le display eth-trunk <N>. Ids precisam constar na lista fechada do perfil do host. Habilita a classificacao ACTIVE/STANDBY_EXPECTED/DOWN_UNEXPECTED/ROLE_UNKNOWN.");
const endpoint = z.object({ hostId, vsiName, approvalId, peerAddress, interfaces }).strict();

export interface VsiToolDefinition {
  name: string;
  title: string;
  description: string;
  /** true quando a ferramenta nunca abre SSH nem consome aprovacao. */
  persistedOnly: boolean;
  inputSchema: z.ZodObject<z.ZodRawShape>;
}

const READ_NOTE =
  " Somente consulta: nenhum comando de configuracao, reset, shutdown, clear, undo ou commit e possivel; a ferramenta nao aceita comando livre.";
const LIVE_NOTE =
  " Abre UMA sessao SSH sob demanda (sem polling), consome a aprovacao one-shot e pode retornar NOT_SUPPORTED/INCONCLUSIVE quando o comando nao for comprovado para o modelo/versao.";

export const VSI_TOOL_DEFINITIONS: readonly VsiToolDefinition[] = [
  {
    name: "list_vsi",
    title: "List VSIs",
    persistedOnly: false,
    description: "Lista as VSIs de um equipamento. PERSISTED (padrao) usa SNMP ja coletado, sem SSH; em NE8000/NE40E nao ha SNMP VPLS e o resultado e INCONCLUSIVE. LIVE descobre por SSH: probe=VERSION executa so 'display version' (identifica a plataforma); probe=LIST executa 'display vsi' (homologacao). LIVE usa aprovacao one-shot de escopo de host." + READ_NOTE + LIVE_NOTE,
    inputSchema: z.object({ hostId, source, q: z.string().max(64).regex(/^[A-Za-z0-9_.:-]*$/).optional(), state: z.enum(["UP", "DOWN"]).optional(), limit: z.number().int().min(1).max(200).default(50), approvalId: approvalId.optional(), probe: z.enum(["LIST", "VERSION"]).default("LIST"), homologation }).strict(),
  },
  {
    name: "get_vsi_details",
    title: "Get VSI Details",
    persistedOnly: false,
    description: "Sinalizacao, tipo de encapsulamento, MTU, RD e estado de uma VSI. PERSISTED usa SNMP; LIVE le 'display vsi name <vsi> verbose'." + READ_NOTE + LIVE_NOTE,
    inputSchema: z.object({ hostId, vsiName, source, approvalId: approvalId.optional() }).strict(),
  },
  {
    name: "get_vsi_ac_bindings",
    title: "Get VSI AC Bindings",
    persistedOnly: false,
    description: "Interfaces fisicas, subinterfaces e ACs vinculados a VSI. Em LIVE tambem le a configuracao de cada AC e sinaliza binding duplicado (interface-pai e subinterface na mesma VSI)." + READ_NOTE + LIVE_NOTE,
    inputSchema: z.object({ hostId, vsiName, source, approvalId: approvalId.optional() }).strict(),
  },
  {
    name: "get_vsi_pseudowires",
    title: "Get VSI Pseudowires",
    persistedOnly: false,
    description: "Peers, estado, labels local/remoto e tunel de cada pseudowire da VSI." + READ_NOTE + LIVE_NOTE,
    inputSchema: z.object({ hostId, vsiName, source, approvalId: approvalId.optional() }).strict(),
  },
  {
    name: "get_vsi_mac_table",
    title: "Get VSI MAC Table",
    persistedOnly: false,
    description: "MACs aprendidos na VSI, separados por AC e por PW. A sintaxe de consulta de MAC por VSI so e executada onde estiver homologada; senao retorna NOT_SUPPORTED." + READ_NOTE + LIVE_NOTE,
    inputSchema: z.object({ hostId, vsiName, approvalId, homologation, maxEntries: z.number().int().min(1).max(500).default(200) }).strict(),
  },
  {
    name: "get_vsi_vlan_encapsulation",
    title: "Get VSI VLAN Encapsulation",
    persistedOnly: false,
    description: "Dot1Q, QinQ, termination, stacking, mapping e rewrite de cada AC da VSI (a partir da configuracao da interface), com a VLAN de entrada e a transportada." + READ_NOTE + LIVE_NOTE,
    inputSchema: z.object({ hostId, vsiName, approvalId, interfaces, vlanId, carrierInterfaces, homologation }).strict(),
  },
  {
    name: "diagnose_vsi",
    title: "Diagnose VSI",
    persistedOnly: false,
    description: "Correlaciona VSI, ACs, PWs, encapsulamento e MAC de UMA ponta e aponta inconsistencias provaveis. Cada achado separa FATO (certainty) de EFEITO (impactCertainty: CONFIRMED/PROBABLE/HYPOTHESIS); nunca declara causa raiz confirmada." + READ_NOTE + LIVE_NOTE,
    inputSchema: z.object({ hostId, vsiName, approvalId, includeMac: z.boolean().default(true), interfaces, vlanId, carrierInterfaces, eTrunkIds, homologation }).strict(),
  },
  {
    name: "compare_vsi_endpoints",
    title: "Compare VSI Endpoints",
    persistedOnly: false,
    description: "Compara os dois lados de um circuito MPLS/VPLS: tipo de encapsulamento, MTU, estado e labels do PW, VLAN original x transportada, tags e onde o aprendizado de MAC deixa de ser observado. Exige uma aprovacao one-shot por ponta." + READ_NOTE + LIVE_NOTE,
    inputSchema: z.object({ a: endpoint, b: endpoint, includeMac: z.boolean().default(true), homologation }).strict(),
  },
];

type ToolCaller = (tool: string, args: unknown) => Promise<string>;

/**
 * Governanca da conta de servico do MCP (F-06). O MCP so executa diagnostico OPERACIONAL (SSH sob demanda) se a propria
 * conta tiver o papel OPERATOR. ADMIN e recusado (ADMIN cria aprovacao: quem aprova nao pode ser quem executa), VIEWER nao
 * executa, e papel nao verificavel tambem e recusado (falha fechada). A API repete a separacao (aprovador != executor).
 */
export type RoleDecision = { allowed: boolean; reason: string };
export type RoleGuard = () => Promise<RoleDecision>;

export function decideMcpRole(role: unknown): RoleDecision {
  if (role === "OPERATOR") return { allowed: true, reason: "papel OPERATOR" };
  if (role === "ADMIN")
    return { allowed: false, reason: "a conta de servico do MCP tem papel ADMIN: execucao operacional recusada (aprovar e executar sao funcoes separadas)" };
  if (typeof role === "string" && role) return { allowed: false, reason: `papel ${role} nao autorizado a executar diagnostico operacional` };
  return { allowed: false, reason: "papel da conta de servico nao verificavel: execucao operacional recusada" };
}

/** Ferramentas que SEMPRE abrem SSH; as demais so quando `source=LIVE` ou quando recebem `approvalId`. */
const ALWAYS_LIVE = new Set(["get_vsi_mac_table", "get_vsi_vlan_encapsulation", "diagnose_vsi", "compare_vsi_endpoints"]);

export function isOperationalCall(tool: string, args: unknown): boolean {
  if (ALWAYS_LIVE.has(tool)) return true;
  const a = (args ?? {}) as { source?: unknown; approvalId?: unknown };
  return a.source === "LIVE" || a.approvalId !== undefined;
}
type McpRegistrar = {
  registerTool: (
    name: string,
    config: { title: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape>; annotations: Record<string, boolean> },
    handler: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
  ) => unknown;
};

export function registerVsiMcpTools(server: unknown, call: ToolCaller, guard?: RoleGuard): string[] {
  const registrar = server as McpRegistrar;
  for (const tool of VSI_TOOL_DEFINITIONS) {
    registrar.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.persistedOnly
          ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
          : // Consome uma aprovacao one-shot e abre SSH ao equipamento: nao e idempotente.
            { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => {
        if (guard && isOperationalCall(tool.name, args)) {
          const decision = await guard();
          if (!decision.allowed)
            return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ERROR", code: "MCP_ROLE_NOT_ALLOWED", message: decision.reason }) }] };
        }
        return { content: [{ type: "text" as const, text: await call(tool.name, args) }] };
      },
    );
  }
  return VSI_TOOL_DEFINITIONS.map((t) => t.name);
}
