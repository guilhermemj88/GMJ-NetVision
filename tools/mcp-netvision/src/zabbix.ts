/**
 * Tools READ-ONLY da API do Zabbix para o MCP do NetVision.
 *
 * Regras de segurança desta camada:
 *  - allowlist fechada de métodos de leitura (nenhum raw/genérico é exposto);
 *  - JSON-RPC 2.0 direto, sem depender da API NetVision;
 *  - ZABBIX_URL / ZABBIX_TOKEN / ZABBIX_AUTH_MODE vêm do runtimeEnv() do MCP;
 *  - o token NUNCA aparece em resultado, erro, log ou snapshot — toda mensagem
 *    passa por `redactSecret` e os normalizadores só devolvem campos conhecidos.
 */

export type ZabbixAuthMode = "AUTH_FIELD" | "BEARER";

export interface ZabbixConfig {
  url: string;
  token: string;
  authMode: ZabbixAuthMode;
  timeoutMs: number;
}

export class ZabbixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZabbixError";
  }
}

/** Allowlist fechada: só leitura. Qualquer outro método é recusado. */
export const ZABBIX_READ_ONLY_METHODS = [
  "apiinfo.version",
  "host.get",
  "item.get",
  "history.get",
  "problem.get",
  "trigger.get",
] as const;

const READ_ONLY_METHODS = new Set<string>(ZABBIX_READ_ONLY_METHODS);

export const ZABBIX_LIMIT_DEFAULT = 50;
export const ZABBIX_LIMIT_MAX = 200;

let requestCounter = 0;

/** Modo de autenticação; default AUTH_FIELD, igual à API NetVision. */
export function zabbixAuthModeFromEnv(value: string | undefined): ZabbixAuthMode {
  return value?.trim().toUpperCase() === "BEARER" ? "BEARER" : "AUTH_FIELD";
}

export function resolveZabbixConfig(
  env: NodeJS.ProcessEnv = process.env,
): ZabbixConfig | null {
  const url = env.ZABBIX_URL?.trim().replace(/\/+$/, "");
  const token = env.ZABBIX_TOKEN?.trim();
  if (!url || !token) return null;
  return {
    url,
    token,
    authMode: zabbixAuthModeFromEnv(env.ZABBIX_AUTH_MODE),
    timeoutMs: 30_000,
  };
}

/** Remove o token de qualquer texto que possa escapar (erro, log, resposta). */
export function redactSecret(text: string, token?: string | null): string {
  if (!token) return text;
  return text.split(token).join("[REDACTED]");
}

export function clampZabbixLimit(
  value: number | undefined,
  fallback = ZABBIX_LIMIT_DEFAULT,
): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (numeric < 1) return 1;
  return Math.min(numeric, ZABBIX_LIMIT_MAX);
}

/** value_type do item → parâmetro `history` da API do Zabbix. */
export function zabbixHistoryType(valueType: unknown): number {
  const numeric = typeof valueType === "number" ? valueType : Number(valueType);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 4) return 3;
  return numeric;
}

export function zabbixHistorySeconds(period: string | undefined): number {
  switch (period) {
    case "15m": return 15 * 60;
    case "6h": return 6 * 60 * 60;
    case "24h": return 24 * 60 * 60;
    case "7d": return 7 * 24 * 60 * 60;
    case "1h":
    default: return 60 * 60;
  }
}

interface ZabbixCallOptions {
  /** `false` somente para apiinfo.version. */
  authenticated?: boolean;
}

/**
 * Chamada JSON-RPC 2.0 ao Zabbix com timeout, tratamento de HTTP error e de
 * `payload.error`. Nunca lança mensagem que contenha o token.
 */
export async function zabbixCall(
  config: ZabbixConfig,
  method: string,
  params: Record<string, unknown> = {},
  options: ZabbixCallOptions = {},
): Promise<unknown> {
  if (!READ_ONLY_METHODS.has(method)) {
    throw new ZabbixError(`Método Zabbix não permitido (somente leitura): ${method}`);
  }
  const authenticated = options.authenticated !== false;
  const requestId = ++requestCounter;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params, id: requestId };
  const headers: Record<string, string> = {
    "content-type": "application/json-rpc",
    accept: "application/json",
  };
  if (authenticated) {
    if (config.authMode === "BEARER") headers.authorization = `Bearer ${config.token}`;
    else body.auth = config.token;
  }

  let response: Response;
  try {
    response = await fetch(`${config.url}/api_jsonrpc.php`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ZabbixError(redactSecret(`Falha de rede ao chamar o Zabbix: ${detail}`, config.token));
  }

  const text = await response.text();
  if (!response.ok) {
    throw new ZabbixError(
      redactSecret(`Zabbix HTTP ${response.status}: ${text.slice(0, 300)}`, config.token),
    );
  }

  let payload: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new ZabbixError(
      redactSecret(`Resposta do Zabbix não é JSON válido: ${text.slice(0, 200)}`, config.token),
    );
  }
  if (payload?.error) {
    const code = payload.error.code ?? "?";
    const message = payload.error.message ?? "erro";
    const data = payload.error.data ? ` — ${String(payload.error.data).slice(0, 200)}` : "";
    throw new ZabbixError(redactSecret(`Zabbix JSON-RPC ${code}: ${message}${data}`, config.token));
  }
  return payload?.result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const rendered = String(value).trim();
  return rendered.length ? rendered : null;
}

/** Interface principal do host (main=1) ou a primeira disponível. */
function mainInterface(row: Record<string, unknown>): Record<string, unknown> | null {
  const interfaces = asArray(row.interfaces);
  if (!interfaces.length) return null;
  return interfaces.find((entry) => String(entry.main ?? "") === "1") ?? interfaces[0]!;
}

export function normalizeZabbixHost(row: Record<string, unknown>): Record<string, unknown> {
  const primary = mainInterface(row);
  const inventory = asRecord(row.inventory);
  return {
    hostId: text(row.hostid),
    hostname: text(row.host),
    displayName: text(row.name),
    status: text(row.status) === "0" ? "MONITORED" : "UNMONITORED",
    managementIp: primary ? text(primary.ip) : null,
    interfaceId: primary ? text(primary.interfaceid) : null,
    interfaceType: primary ? text(primary.type) : null,
    vendor: text(inventory.vendor),
    model: text(inventory.model),
  };
}

export function normalizeZabbixItem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    itemId: text(row.itemid),
    name: text(row.name),
    key: text(row.key_),
    lastValue: text(row.lastvalue),
    lastClock: text(row.lastclock),
    units: text(row.units),
    valueType: text(row.value_type),
    status: text(row.status) === "0" ? "ENABLED" : "DISABLED",
  };
}

export function normalizeZabbixProblem(row: Record<string, unknown>): Record<string, unknown> {
  return {
    eventId: text(row.eventid),
    timestamp: text(row.clock),
    name: text(row.name),
    severity: text(row.severity),
    acknowledged: text(row.acknowledged) === "1",
    suppressed: text(row.suppressed) === "1",
    tags: asArray(row.tags)
      .map((tag) => ({ tag: text(tag.tag), value: text(tag.value) }))
      .filter((tag) => tag.tag),
  };
}

export function normalizeZabbixTrigger(row: Record<string, unknown>): Record<string, unknown> {
  return {
    triggerId: text(row.triggerid),
    description: text(row.description),
    priority: text(row.priority),
    status: text(row.status),
    value: text(row.value),
    lastChange: text(row.lastchange),
    hosts: asArray(row.hosts).map((host) => ({
      hostId: text(host.hostid),
      hostname: text(host.host),
      displayName: text(host.name),
    })),
  };
}

function requireConfig(config: ZabbixConfig | null): ZabbixConfig {
  if (!config) {
    throw new ZabbixError(
      "ZABBIX_URL/ZABBIX_TOKEN não estão disponíveis no runtime do MCP. Nenhuma chamada foi feita.",
    );
  }
  return config;
}

/** apiinfo.version (sem auth) + host.get autenticado mínimo. */
export async function zabbixStatus(config: ZabbixConfig | null): Promise<Record<string, unknown>> {
  const resolved = requireConfig(config);
  let version: unknown = null;
  let authenticated = false;
  let visibleHosts: number | null = null;

  version = await zabbixCall(resolved, "apiinfo.version", {}, { authenticated: false });
  const hosts = await zabbixCall(resolved, "host.get", { countOutput: true });
  authenticated = true;
  visibleHosts = Number(hosts);

  return {
    connected: true,
    version: text(version) ?? String(version ?? ""),
    authenticated,
    authMode: resolved.authMode,
    visibleHosts,
  };
}

export async function zabbixListHosts(
  config: ZabbixConfig | null,
  input: { q?: string; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const resolved = requireConfig(config);
  const params: Record<string, unknown> = {
    output: ["hostid", "host", "name", "status"],
    selectInterfaces: ["interfaceid", "ip", "type", "main"],
    selectInventory: ["vendor", "model"],
    limit: input.limit === 0 ? ZABBIX_LIMIT_MAX : clampZabbixLimit(input.limit),
  };
  const query = input.q?.trim();
  if (query) params.search = { host: query, name: query };
  return asArray(await zabbixCall(resolved, "host.get", params)).map(normalizeZabbixHost);
}

export async function zabbixGetHost(
  config: ZabbixConfig | null,
  input: { hostId: string },
): Promise<Record<string, unknown> | null> {
  const resolved = requireConfig(config);
  const rows = asArray(
    await zabbixCall(resolved, "host.get", {
      hostids: input.hostId,
      output: ["hostid", "host", "name", "status"],
      selectInterfaces: ["interfaceid", "ip", "dns", "port", "type", "main"],
      selectInventory: ["vendor", "model", "type", "os"],
      selectGroups: ["groupid", "name"],
      selectParentTemplates: ["templateid", "name"],
    }),
  );
  const row = rows[0];
  if (!row) return null;
  const base = normalizeZabbixHost(row);
  return {
    ...base,
    interfaces: asArray(row.interfaces).map((entry) => ({
      interfaceId: text(entry.interfaceid),
      ip: text(entry.ip),
      dns: text(entry.dns),
      port: text(entry.port),
      type: text(entry.type),
      main: text(entry.main) === "1",
    })),
    inventory: asRecord(row.inventory),
    groups: asArray(row.groups).map((group) => ({
      groupId: text(group.groupid),
      name: text(group.name),
    })),
    templates: asArray(row.parentTemplates).map((template) => ({
      templateId: text(template.templateid),
      name: text(template.name),
    })),
  };
}

export async function zabbixListItems(
  config: ZabbixConfig | null,
  input: { hostId: string; q?: string; limit?: number },
): Promise<Record<string, unknown>[]> {
  const resolved = requireConfig(config);
  const params: Record<string, unknown> = {
    hostids: input.hostId,
    output: ["itemid", "name", "key_", "lastvalue", "lastclock", "units", "value_type", "status"],
    sortfield: "name",
    limit: clampZabbixLimit(input.limit),
  };
  const query = input.q?.trim();
  if (query) params.search = { name: query, key_: query };
  return asArray(await zabbixCall(resolved, "item.get", params)).map(normalizeZabbixItem);
}

/** Descobre o value_type e usa o `history` correto do item. */
export async function zabbixGetItemHistory(
  config: ZabbixConfig | null,
  input: { itemId: string; period?: string; limit?: number },
): Promise<Record<string, unknown>> {
  const resolved = requireConfig(config);
  const items = asArray(
    await zabbixCall(resolved, "item.get", { itemids: input.itemId, output: ["itemid", "value_type", "name"] }),
  );
  const item = items[0];
  if (!item) return { itemId: input.itemId, historyType: null, samples: [] };
  const historyType = zabbixHistoryType(item.value_type);
  const now = Math.floor(Date.now() / 1000);
  const from = now - zabbixHistorySeconds(input.period);
  const rows = asArray(
    await zabbixCall(resolved, "history.get", {
      itemids: input.itemId,
      history: historyType,
      sortfield: "clock",
      sortorder: "ASC",
      time_from: from,
      limit: clampZabbixLimit(input.limit, 100),
    }),
  );
  return {
    itemId: input.itemId,
    name: text(item.name),
    valueType: text(item.value_type),
    historyType,
    samples: rows.map((row) => ({ timestamp: text(row.clock), value: text(row.value) })),
  };
}

export async function zabbixGetProblems(
  config: ZabbixConfig | null,
  input: { hostId?: string; recent?: boolean; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const resolved = requireConfig(config);
  const params: Record<string, unknown> = {
    output: "extend",
    selectTags: "extend",
    sortfield: ["eventid"],
    sortorder: "DESC",
    limit: clampZabbixLimit(input.limit),
  };
  if (input.hostId) params.hostids = input.hostId;
  if (input.recent) params.recent = true;
  return asArray(await zabbixCall(resolved, "problem.get", params)).map(normalizeZabbixProblem);
}

export async function zabbixGetTriggers(
  config: ZabbixConfig | null,
  input: { hostId?: string; q?: string; onlyProblem?: boolean; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const resolved = requireConfig(config);
  const params: Record<string, unknown> = {
    output: ["triggerid", "description", "priority", "status", "value", "lastchange"],
    selectHosts: ["hostid", "host", "name"],
    sortfield: "lastchange",
    sortorder: "DESC",
    limit: clampZabbixLimit(input.limit),
  };
  if (input.hostId) params.hostids = input.hostId;
  const query = input.q?.trim();
  if (query) params.search = { description: query };
  if (input.onlyProblem) params.filter = { value: 1 };
  return asArray(await zabbixCall(resolved, "trigger.get", params)).map(normalizeZabbixTrigger);
}
