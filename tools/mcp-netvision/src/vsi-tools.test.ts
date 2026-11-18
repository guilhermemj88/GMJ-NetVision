import test from "node:test";
import assert from "node:assert/strict";
import { VSI_TOOL_DEFINITIONS, decideMcpRole, isOperationalCall, registerVsiMcpTools, type RoleGuard } from "./vsi-tools.js";

const UUID = "11111111-1111-4111-8111-111111111111";

function harness() {
  type Config = { annotations: Record<string, boolean>; description: string };
  type Handler = (a: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const registered = new Map<string, { config: Config; handler: Handler }>();
  const server = { registerTool: (name: string, config: Config, handler: Handler) => void registered.set(name, { config, handler }) };
  const calls: Array<{ tool: string; args: unknown }> = [];
  const names = registerVsiMcpTools(server, async (tool, args) => (calls.push({ tool, args }), JSON.stringify({ ok: true })));
  return { registered, calls, names };
}

test("registra exatamente as 8 ferramentas de diagnostico VSI", () => {
  const { names } = harness();
  assert.deepEqual(names, ["list_vsi", "get_vsi_details", "get_vsi_ac_bindings", "get_vsi_pseudowires", "get_vsi_mac_table", "get_vsi_vlan_encapsulation", "diagnose_vsi", "compare_vsi_endpoints"]);
});

test("nao existe ferramenta para criar aprovacao nem para executar comando livre", () => {
  const { names } = harness();
  assert.equal(names.some((n) => /approv|exec|command|run|ssh|cli/i.test(n)), false);
});

test("nenhum schema aceita campo de comando/texto livre", () => {
  for (const tool of VSI_TOOL_DEFINITIONS) {
    const keys = Object.keys(tool.inputSchema.shape);
    assert.equal(keys.some((k) => /^(command|commands|cmd|raw|script|shell|args|expression)$/i.test(k)), false, tool.name);
    assert.throws(() => tool.inputSchema.parse({ hostId: "h", vsiName: "X", a: undefined, command: "reboot" }), tool.name);
  }
});

test("nome de VSI com metacaractere e rejeitado no schema", () => {
  const diagnose = VSI_TOOL_DEFINITIONS.find((t) => t.name === "diagnose_vsi")!;
  for (const vsiName of ["X; reboot", "X | include a", "X\nundo", "a b", ""]) {
    assert.equal(diagnose.inputSchema.safeParse({ hostId: "h", vsiName, approvalId: UUID }).success, false, JSON.stringify(vsiName));
  }
  assert.equal(diagnose.inputSchema.safeParse({ hostId: "h", vsiName: "L2-PPPOE-3901", approvalId: UUID }).success, true);
});

test("ferramentas ao vivo exigem approvalId UUID; list_vsi nao", () => {
  const byName = Object.fromEntries(VSI_TOOL_DEFINITIONS.map((t) => [t.name, t]));
  assert.equal(byName.diagnose_vsi!.inputSchema.safeParse({ hostId: "h", vsiName: "X" }).success, false);
  assert.equal(byName.get_vsi_mac_table!.inputSchema.safeParse({ hostId: "h", vsiName: "X", approvalId: "nao-uuid" }).success, false);
  assert.equal(byName.list_vsi!.inputSchema.safeParse({ hostId: "h" }).success, true);
});

test("compare exige as duas pontas com aprovacao propria", () => {
  const compare = VSI_TOOL_DEFINITIONS.find((t) => t.name === "compare_vsi_endpoints")!;
  const a = { hostId: "a", vsiName: "X", approvalId: UUID };
  assert.equal(compare.inputSchema.safeParse({ a, b: { hostId: "b", vsiName: "X", approvalId: UUID } }).success, true);
  assert.equal(compare.inputSchema.safeParse({ a, b: { hostId: "b", vsiName: "X" } }).success, false);
});

test("handler repassa para /api/vsi-mcp/tools/:tool com os argumentos validados", async () => {
  const { registered, calls } = harness();
  const out = await registered.get("get_vsi_details")!.handler({ hostId: "h", vsiName: "X", source: "PERSISTED" });
  assert.deepEqual(calls, [{ tool: "get_vsi_details", args: { hostId: "h", vsiName: "X", source: "PERSISTED" } }]);
  assert.equal(out.content[0].type, "text");
});

test("anotacoes: todas podem consumir aprovacao e abrir SSH => nao somente-leitura/idempotentes, nunca destrutivas", () => {
  const { registered } = harness();
  for (const [name, { config }] of registered) {
    assert.equal(config.annotations.readOnlyHint, false, name);
    assert.equal(config.annotations.destructiveHint, false, name);
    assert.equal(config.annotations.idempotentHint, false, name);
  }
});

test("descricoes declaram somente consulta", () => {
  for (const tool of VSI_TOOL_DEFINITIONS) assert.match(tool.description, /Somente consulta/, tool.name);
});

// ---- F-06: governanca da conta de servico do MCP ----
function guarded(guard: RoleGuard) {
  type Handler = (a: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const registered = new Map<string, Handler>();
  const server = { registerTool: (name: string, _config: unknown, handler: Handler) => void registered.set(name, handler) };
  const calls: string[] = [];
  registerVsiMcpTools(server, async (tool) => (calls.push(tool), JSON.stringify({ ok: true })), guard);
  return { registered, calls };
}

test("decideMcpRole: so OPERATOR executa; ADMIN, VIEWER, vazio e desconhecido sao recusados (falha fechada)", () => {
  assert.equal(decideMcpRole("OPERATOR").allowed, true);
  for (const role of ["ADMIN", "VIEWER", "", undefined, null, 42, "operator"]) assert.equal(decideMcpRole(role).allowed, false, String(role));
  assert.match(decideMcpRole("ADMIN").reason, /ADMIN/);
});

test("conta ADMIN: toda execucao OPERACIONAL e recusada ANTES de chamar a API; nenhuma chamada sai", async () => {
  const { registered, calls } = guarded(async () => decideMcpRole("ADMIN"));
  const live = [
    ["list_vsi", { hostId: "h", source: "LIVE" }],
    ["get_vsi_details", { hostId: "h", vsiName: "X", source: "LIVE", approvalId: UUID }],
    ["get_vsi_mac_table", { hostId: "h", vsiName: "X", approvalId: UUID }],
    ["get_vsi_vlan_encapsulation", { hostId: "h", vsiName: "X", approvalId: UUID }],
    ["diagnose_vsi", { hostId: "h", vsiName: "X", approvalId: UUID }],
  ] as const;
  for (const [tool, args] of live) {
    const out = JSON.parse((await registered.get(tool)!(args)).content[0].text);
    assert.equal(out.code, "MCP_ROLE_NOT_ALLOWED", tool);
    assert.equal(out.status, "ERROR", tool);
  }
  assert.deepEqual(calls, []);
});

test("conta ADMIN: consultas PERSISTIDAS (sem SSH) continuam funcionando", async () => {
  const { registered, calls } = guarded(async () => decideMcpRole("ADMIN"));
  await registered.get("list_vsi")!({ hostId: "h" });
  await registered.get("get_vsi_details")!({ hostId: "h", vsiName: "X", source: "PERSISTED" });
  assert.deepEqual(calls, ["list_vsi", "get_vsi_details"]);
});

test("conta OPERATOR: a execucao operacional segue para a API", async () => {
  const { registered, calls } = guarded(async () => decideMcpRole("OPERATOR"));
  await registered.get("diagnose_vsi")!({ hostId: "h", vsiName: "X", approvalId: UUID });
  assert.deepEqual(calls, ["diagnose_vsi"]);
});

test("papel nao verificavel (erro, 401, vazio): recusa", async () => {
  const { registered, calls } = guarded(async () => decideMcpRole(undefined));
  const out = JSON.parse((await registered.get("diagnose_vsi")!({ hostId: "h", vsiName: "X", approvalId: UUID })).content[0].text);
  assert.equal(out.code, "MCP_ROLE_NOT_ALLOWED");
  assert.match(out.message, /nao verificavel/);
  assert.deepEqual(calls, []);
});

test("isOperationalCall: ferramentas sempre ao vivo, source=LIVE ou approvalId; persistido puro nao", () => {
  assert.equal(isOperationalCall("diagnose_vsi", {}), true);
  assert.equal(isOperationalCall("compare_vsi_endpoints", {}), true);
  assert.equal(isOperationalCall("list_vsi", { source: "LIVE" }), true);
  assert.equal(isOperationalCall("get_vsi_details", { approvalId: UUID }), true);
  assert.equal(isOperationalCall("list_vsi", {}), false);
  assert.equal(isOperationalCall("get_vsi_pseudowires", { source: "PERSISTED" }), false);
});

test("a mensagem de recusa nao carrega segredo nem dados do equipamento", async () => {
  const { registered } = guarded(async () => decideMcpRole("ADMIN"));
  const text = (await registered.get("diagnose_vsi")!({ hostId: "host-secreto", vsiName: "VSI-SECRETA", approvalId: UUID })).content[0].text;
  assert.equal(/host-secreto|VSI-SECRETA|senha|password/i.test(text), false);
});
