import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRoot = path.resolve(currentDir, "../../..");
const apiRoot = path.join(repoRoot, "apps/api");
const PORT = Number(process.env.MCP_PORT ?? 3334);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const API_BASE_URL = process.env.NETVISION_API_URL ?? "http://127.0.0.1:3333";
const API_HEALTH_URL = process.env.NETVISION_API_HEALTH_URL ?? `${API_BASE_URL}/health`;
const SERVICE_CANDIDATES = [
  "netvision-api",
  "netvision-mcp",
  "netvision-web",
  "gmj-netvision-api",
  "gmj-netvision-web",
  "netvision",
] as const;
const SAFE_ENV_KEYS = [
  "DATABASE_URL",
  "CREDENTIAL_ENCRYPTION_KEY",
  "DEMO_MODE",
  "SNMP_POLLING_ENABLED",
  "SNMP_POLL_INTERVAL_SECONDS",
  "ZABBIX_URL",
  "ZABBIX_TOKEN",
  "NETVISION_MCP_USERNAME",
  "NETVISION_MCP_PASSWORD",
] as const;
const ENV_FILES = [
  path.join(repoRoot, ".env"),
  path.join(apiRoot, ".env"),
  "/etc/default/netvision",
  "/etc/netvision/netvision.env",
  "/etc/netvision.env",
] as const;
const REDACTED_KEYS = /(?:password|community|encryptedpayload|encryption_key|database_url|token|secret|authorization)/i;

function ensureInsideRepo(relativePath: string): string {
  const resolved = path.resolve(repoRoot, relativePath);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) throw new Error("Path outside repository is not allowed");
  return resolved;
}

async function runProcess(executable: string, args: string[], cwd = repoRoot, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    return `${stdout}${stderr}`.trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    return `${error?.stdout ?? ""}${error?.stderr ?? ""}\n${error?.message ?? String(error)}`.trim();
  }
}

async function runGit(args: string[]) { return runProcess("git", args); }
async function runNpm(script: string) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return runProcess(comspec, ["/d", "/s", "/c", `npm run ${script}`], repoRoot);
  }
  return runProcess("npm", ["run", script], repoRoot);
}

function parseEnvFile(content: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;
    const key = normalized.slice(0, equals).trim();
    let value = normalized.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key) result[key] = value;
  }
  return result;
}

async function fileExists(filename: string): Promise<boolean> {
  try { await access(filename); return true; } catch { return false; }
}

async function runtimeEnv(): Promise<{ env: NodeJS.ProcessEnv; sources: string[] }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const sources: string[] = ["mcp-process"];
  for (const filename of ENV_FILES) {
    if (!(await fileExists(filename))) continue;
    try {
      Object.assign(env, parseEnvFile(await readFile(filename, "utf8")));
      sources.push(filename);
    } catch { /* optional env files */ }
  }
  return { env, sources };
}

async function envStatus(): Promise<string> {
  const { env, sources } = await runtimeEnv();
  const status = Object.fromEntries(SAFE_ENV_KEYS.map((key) => [key, Boolean(env[key])]));
  return JSON.stringify({ status, sources }, null, 2);
}

async function prismaCommand(args: string[]): Promise<string> {
  const { env } = await runtimeEnv();
  if (!env.DATABASE_URL) return "DATABASE_URL is not available to the MCP runtime or known NetVision env files. No database command was executed.";
  return runProcess("npx", ["prisma", ...args], apiRoot, env);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = REDACTED_KEYS.test(key) ? "[REDACTED]" : sanitize(item);
    return output;
  }
  return value;
}

let cachedSessionCookie: string | null = null;

async function mcpCredentials(): Promise<{ usernameOrEmail: string; password: string } | null> {
  const { env } = await runtimeEnv();
  const usernameOrEmail = env.NETVISION_MCP_USERNAME?.trim();
  if (!usernameOrEmail || !env.NETVISION_MCP_PASSWORD) return null;
  return { usernameOrEmail, password: env.NETVISION_MCP_PASSWORD };
}

function sessionCookieFromHeaders(headers: Headers): string | null {
  const raw = headers.get("set-cookie");
  if (!raw) return null;
  const match = /(?:^|[;,]\s*)netvision_session=([^;,\s]+)/i.exec(raw);
  return match ? `netvision_session=${match[1]}` : null;
}

async function loginAndCacheSession(): Promise<string | null> {
  const credentials = await mcpCredentials();
  if (!credentials) return null;
  try {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const cookie = sessionCookieFromHeaders(response.headers);
    cachedSessionCookie = cookie;
    return cookie;
  } catch {
    return null;
  }
}

interface ApiRequestResult {
  status: number;
  ok: boolean;
  body: unknown;
}

async function apiFetchRaw(method: "GET" | "POST" | "PATCH", route: string, requestBody?: unknown): Promise<ApiRequestResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (requestBody !== undefined) headers["content-type"] = "application/json";
  if (cachedSessionCookie) headers["cookie"] = cachedSessionCookie;
  const response = await fetch(`${API_BASE_URL}${route}`, {
    method,
    headers,
    body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: response.status, ok: response.ok, body };
}

async function apiRequestJson(method: "GET" | "POST" | "PATCH", route: string, requestBody?: unknown): Promise<ApiRequestResult> {
  const credentials = await mcpCredentials();
  if (!credentials) return apiFetchRaw(method, route, requestBody);

  if (!cachedSessionCookie) await loginAndCacheSession();

  let result = await apiFetchRaw(method, route, requestBody);
  if (result.status === 401) {
    // Session may have expired: drop it, authenticate again and retry once.
    cachedSessionCookie = null;
    const cookie = await loginAndCacheSession();
    if (cookie) result = await apiFetchRaw(method, route, requestBody);
  }
  return result;
}

function apiErrorText(result: ApiRequestResult): string {
  return JSON.stringify({ status: result.status, ok: false, body: sanitize(result.body) }, null, 2);
}

async function apiRequest(method: "GET" | "POST" | "PATCH", route: string, requestBody?: unknown): Promise<string> {
  try {
    const result = await apiRequestJson(method, route, requestBody);
    return JSON.stringify({ status: result.status, ok: result.ok, body: sanitize(result.body) }, null, 2);
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
  }
}

const HOST_COMPACT_FIELDS = [
  "id", "hostname", "displayName", "managementIp", "vendor", "model", "deviceType",
  "status", "uptimeSeconds", "discoveryMethod", "sshEnabled", "snmpEnabled",
] as const;

const INTERFACE_COMPACT_FIELDS = [
  "id", "name", "alias", "description", "ifIndex", "adminStatus", "operStatus", "speedBps",
] as const;

const INTERFACE_DETAIL_FIELDS = [
  "id", "name", "alias", "description", "ifIndex", "mac", "mtu", "speedBps",
  "adminStatus", "operStatus", "rxBps", "txBps", "rxUtilization", "txUtilization",
  "rxErrors", "txErrors", "rxDiscards", "txDiscards",
  "telemetryAvailable", "telemetryUpdatedAt", "dataSources",
] as const;

function pickFields(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) if (field in source) output[field] = source[field];
  return output;
}

function pickHostCompact(host: Record<string, unknown>): Record<string, unknown> {
  return pickFields(host, HOST_COMPACT_FIELDS);
}

function pickInterfaceCompact(item: Record<string, unknown>): Record<string, unknown> {
  return pickFields(item, INTERFACE_COMPACT_FIELDS);
}

function opticalSummary(item: Record<string, unknown>): Record<string, unknown> | null {
  const rx = item.rxPowerDbm;
  const tx = item.txPowerDbm;
  const source = item.opticalSource;
  const updatedAt = item.opticalUpdatedAt;
  const lanes = Array.isArray(item.opticalLanes) ? item.opticalLanes.length : null;
  if (rx === undefined && tx === undefined && source === undefined && lanes === null) return null;
  return {
    ...(rx !== undefined ? { rxPowerDbm: rx } : {}),
    ...(tx !== undefined ? { txPowerDbm: tx } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(lanes !== null ? { laneCount: lanes } : {}),
  };
}

function pickInterfaceDetail(item: Record<string, unknown>): Record<string, unknown> {
  const detail = pickFields(item, INTERFACE_DETAIL_FIELDS);
  if (typeof item.deviceId === "string") {
    detail.hostId = item.deviceId;
    detail.deviceId = item.deviceId;
  }
  const optical = opticalSummary(item);
  if (optical) detail.optical = optical;
  return detail;
}

export type BgpScopeArg = "MONITORED" | "ALL";
export type BgpStateArg = "UP" | "DOWN";
export type BgpFamilyArg = "ALL" | "IPV4" | "IPV6";

export function bgpListQuery(
  scope: BgpScopeArg,
  state?: BgpStateArg,
  q?: string,
  deviceId?: string,
  family?: BgpFamilyArg,
): string {
  const params = new URLSearchParams();
  params.set("scope", scope === "ALL" ? "all" : "monitored");
  if (state) params.set("state", state === "UP" ? "up" : "down");
  if (family && family !== "ALL") params.set("family", family);
  if (q?.trim()) params.set("q", q.trim());
  if (deviceId?.trim()) params.set("deviceId", deviceId.trim());
  return params.toString();
}

export function flattenBgpDashboardPeers(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== "object") return [];
  const devices = (body as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) return [];
  return devices.flatMap((device) => {
    const peers = (device as { peers?: unknown }).peers;
    return Array.isArray(peers) ? (peers as Record<string, unknown>[]) : [];
  });
}

export function compactBgpPeer(peer: Record<string, unknown>): Record<string, unknown> {
  const iface = (peer.interface ?? null) as Record<string, unknown> | null;
  return {
    id: peer.id,
    deviceId: peer.deviceId,
    hostname: peer.deviceHostname,
    deviceName: peer.deviceDisplayName,
    peerAddress: peer.peerAddress,
    displayName: peer.displayName,
    addressFamily: peer.addressFamily,
    localAs: peer.localAs,
    remoteAs: peer.remoteAs,
    state: peer.state,
    stateCode: peer.stateCode,
    established: peer.established,
    receivedPrefixes: peer.receivedPrefixes,
    establishedSince: peer.establishedSince,
    interfaceId: iface?.id ?? null,
    interfaceName: iface?.name ?? null,
    rxBps: iface?.rxBps ?? null,
    txBps: iface?.txBps ?? null,
    lastPollingAt: peer.lastPollingAt,
  };
}

export function compactBgpPeerDetail(peer: Record<string, unknown>): Record<string, unknown> {
  const iface = (peer.interface ?? null) as Record<string, unknown> | null;
  return {
    ...compactBgpPeer(peer),
    role: peer.role,
    monitoringEnabled: peer.monitoringEnabled,
    bgpMonitoringEnabled: peer.bgpMonitoringEnabled,
    /** UNKNOWN means no SSH read-back ever confirmed the administrative state. */
    adminState: peer.adminState,
    adminStateCheckedAt: peer.adminStateCheckedAt,
    interfaceAlias: iface?.alias ?? null,
    interfaceDescription: iface?.description ?? null,
    lastDiscoveryAt: peer.lastDiscoveryAt,
  };
}

export function compactBgpHistory(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return { samples: [], events: [] };
  const record = body as {
    peerId?: unknown;
    samples?: unknown;
    events?: unknown;
  };
  const samples = Array.isArray(record.samples)
    ? record.samples.map((sample) => {
        const item = sample as Record<string, unknown>;
        return {
          timestamp: item.timestamp,
          state: item.state,
          established: item.established,
          receivedPrefixes: item.receivedPrefixes,
        };
      })
    : [];
  const events = Array.isArray(record.events)
    ? record.events.map((event) => {
        const item = event as Record<string, unknown>;
        return {
          previousState: item.previousState,
          currentState: item.currentState,
          occurredAt: item.occurredAt,
        };
      })
    : [];
  return { peerId: record.peerId, samples, events };
}

async function httpGet(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    return JSON.stringify({ url, status: response.status, ok: response.ok, body }, null, 2);
  } catch (error) {
    return JSON.stringify({ url, ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
  }
}

async function serviceStatus(): Promise<string> {
  if (process.platform === "win32") return "Service inspection is available only on the IMPLANTAR Linux host.";
  const rows: Array<{ service: string; loadState: string; activeState: string; subState: string }> = [];
  for (const service of SERVICE_CANDIDATES) {
    const output = await runProcess("systemctl", ["show", service, "--property=LoadState,ActiveState,SubState", "--value"]);
    const values = output.split(/\r?\n/).filter(Boolean);
    if (values.includes("not-found") || output.includes("could not be found")) continue;
    if (values.length >= 3) rows.push({ service, loadState: values[0] ?? "unknown", activeState: values[1] ?? "unknown", subState: values[2] ?? "unknown" });
  }
  return rows.length ? JSON.stringify(rows, null, 2) : "No known NetVision systemd service was detected.";
}

async function serviceLogs(service: typeof SERVICE_CANDIDATES[number], lines: number): Promise<string> {
  if (process.platform === "win32") return "Service logs are available only on the IMPLANTAR Linux host.";
  return runProcess("journalctl", ["-u", service, "-n", String(lines), "--no-pager", "--output=short-iso"]);
}

function textResult(text: string) { return { content: [{ type: "text" as const, text }] }; }

export function createNetVisionMcpServer() {
  const server = new McpServer({ name: "gmj-netvision-implantar", version: "0.7.0" });

  server.registerTool("repo_status", { title: "Repository Status", description: "Show the Git status of the GMJ NetVision repository.", inputSchema: z.object({}) }, async () => textResult((await runGit(["status", "--short", "--branch"])) || "Working tree clean"));
  server.registerTool("repo_diff", { title: "Repository Diff", description: "Show the current uncommitted Git diff.", inputSchema: z.object({}) }, async () => textResult((await runGit(["diff"])) || "No tracked changes"));
  server.registerTool("repo_read_file", { title: "Read Repository File", description: "Read a UTF-8 text file inside the GMJ NetVision repository.", inputSchema: z.object({ path: z.string().min(1) }) }, async ({ path: relativePath }) => textResult(await readFile(ensureInsideRepo(relativePath), "utf8")));
  server.registerTool("repo_write_file", { title: "Write Repository File", description: "Create or replace a UTF-8 text file inside the GMJ NetVision repository.", inputSchema: z.object({ path: z.string().min(1), content: z.string() }) }, async ({ path: relativePath, content }) => {
    const absolutePath = ensureInsideRepo(relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    return textResult(`Written: ${relativePath}`);
  });
  server.registerTool("repo_search", { title: "Search Repository", description: "Search text recursively inside the GMJ NetVision Git repository.", inputSchema: z.object({ query: z.string().min(1) }) }, async ({ query }) => textResult((await runGit(["grep", "-n", "-I", "-e", query])) || "No matches"));
  server.registerTool("run_lint", { title: "Run Lint", description: "Run the GMJ NetVision lint script.", inputSchema: z.object({}) }, async () => textResult(await runNpm("lint")));
  server.registerTool("run_typecheck", { title: "Run Typecheck", description: "Run the GMJ NetVision TypeScript typecheck.", inputSchema: z.object({}) }, async () => textResult(await runNpm("typecheck")));
  server.registerTool("run_tests", { title: "Run Tests", description: "Run the GMJ NetVision test suite.", inputSchema: z.object({}) }, async () => textResult(await runNpm("test")));
  server.registerTool("run_build", { title: "Run Build", description: "Run the GMJ NetVision production build.", inputSchema: z.object({}) }, async () => textResult(await runNpm("build")));
  server.registerTool("env_status", { title: "NetVision Environment Status", description: "Report whether required NetVision runtime environment variables are present, without returning any secret values.", inputSchema: z.object({}) }, async () => textResult(await envStatus()));
  server.registerTool("prisma_migrate_status", { title: "Prisma Migration Status", description: "Run Prisma migrate status using the NetVision runtime database environment without exposing DATABASE_URL.", inputSchema: z.object({}) }, async () => textResult(await prismaCommand(["migrate", "status"])));
  server.registerTool("prisma_migrate_deploy", { title: "Deploy Prisma Migrations", description: "Apply pending production Prisma migrations using the NetVision runtime database environment without exposing DATABASE_URL.", inputSchema: z.object({}) }, async () => textResult(await prismaCommand(["migrate", "deploy"])));
  server.registerTool("api_health", { title: "NetVision API Health", description: "Check the running NetVision API health endpoint on the IMPLANTAR host.", inputSchema: z.object({}) }, async () => textResult(await httpGet(API_HEALTH_URL)));
  server.registerTool("service_status", { title: "NetVision Service Status", description: "Inspect known NetVision systemd service states on the IMPLANTAR host.", inputSchema: z.object({}) }, async () => textResult(await serviceStatus()));
  server.registerTool("service_logs", { title: "NetVision Service Logs", description: "Read recent journal logs for an allow-listed NetVision service. This is read-only.", inputSchema: z.object({ service: z.enum(SERVICE_CANDIDATES), lines: z.number().int().min(10).max(500).default(100) }) }, async ({ service, lines }) => textResult(await serviceLogs(service, lines)));

  server.registerTool("list_hosts", { title: "List NetVision Hosts", description: "List NetVision hosts in compact form for host discovery and selection. Use get_host when detailed information about one known host is required.", inputSchema: z.object({ q: z.string().optional(), source: z.enum(["ZABBIX", "SSH", "SNMP"]).optional() }) }, async ({ q, source }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (source) params.set("source", source);
    const result = await apiRequestJson("GET", `/api/hosts${params.size ? `?${params.toString()}` : ""}`);
    if (!result.ok) return textResult(apiErrorText(result));
    const hosts = Array.isArray(result.body) ? result.body : [];
    return textResult(JSON.stringify(hosts.map((host) => pickHostCompact(host as Record<string, unknown>)), null, 2));
  });
  server.registerTool("get_host", { title: "Get NetVision Host", description: "Return compact details for one known NetVision host. Does not return the host's full interface list. Use list_interfaces to inspect interfaces.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => {
    const result = await apiRequestJson("GET", `/api/hosts/${encodeURIComponent(hostId)}`);
    if (!result.ok) return textResult(apiErrorText(result));
    return textResult(JSON.stringify(pickHostCompact(result.body as Record<string, unknown>), null, 2));
  });
  server.registerTool("test_host_snmp", { title: "Test Host SNMP", description: "Test the stored SNMP configuration for a persisted host without exposing credentials.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => textResult(await apiRequest("POST", `/api/hosts/${encodeURIComponent(hostId)}/test/snmp`)));
  server.registerTool("discover_interfaces", { title: "Discover SNMP Interfaces", description: "Run SNMP interface discovery for a persisted host and persist the discovered interfaces.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => textResult(await apiRequest("POST", `/api/hosts/${encodeURIComponent(hostId)}/interfaces/discover`)));
  server.registerTool("poll_host", { title: "Poll Host SNMP", description: "Run one manual SNMP poll for a persisted host. Automatic polling remains unchanged.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => textResult(await apiRequest("POST", `/api/hosts/${encodeURIComponent(hostId)}/poll`)));
  server.registerTool("list_interfaces", { title: "List Host Interfaces", description: "List interfaces for one known NetVision host in compact form. Use get_interface for detailed current information about one interface and get_interface_metrics for historical metrics.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => {
    const result = await apiRequestJson("GET", `/api/hosts/${encodeURIComponent(hostId)}/interfaces`);
    if (!result.ok) return textResult(apiErrorText(result));
    const interfaces = Array.isArray(result.body) ? result.body : [];
    return textResult(JSON.stringify(interfaces.map((item) => pickInterfaceCompact(item as Record<string, unknown>)), null, 2));
  });
  server.registerTool("get_interface", { title: "Get Interface", description: "Return detailed current state for one known NetVision interface. Use get_interface_metrics when historical time-series data is required.", inputSchema: z.object({ interfaceId: z.string().min(1) }) }, async ({ interfaceId }) => {
    const result = await apiRequestJson("GET", "/api/hosts");
    if (!result.ok) return textResult(apiErrorText(result));
    const hosts = Array.isArray(result.body) ? result.body : [];
    for (const host of hosts) {
      const record = host as Record<string, unknown>;
      const interfaces = record.interfaces;
      if (!Array.isArray(interfaces)) continue;
      const found = interfaces.find((item) => (item as Record<string, unknown>).id === interfaceId);
      if (found) return textResult(JSON.stringify(pickInterfaceDetail(found as Record<string, unknown>), null, 2));
    }
    return textResult(JSON.stringify({ ok: false, error: `Interface ${interfaceId} not found` }, null, 2));
  });
  server.registerTool("get_interface_metrics", { title: "Interface Metric History", description: "Return persisted historical metrics for one interface over a supported period.", inputSchema: z.object({ interfaceId: z.string().min(1), period: z.enum(["15m", "1h", "6h", "24h", "7d"]).default("1h") }) }, async ({ interfaceId, period }) => textResult(await apiRequest("GET", `/api/interfaces/${encodeURIComponent(interfaceId)}/history?period=${period}`)));

  server.registerTool("discover_lldp_topology", { title: "Discover LLDP Topology", description: "Discover the LLDP adjacency topology for all SNMP/SSH-enabled hosts of a map and return a review preview. SSH is used as a fallback only. This operation does not change the database.", inputSchema: z.object({ mapId: z.string().min(1), deepValidation: z.boolean().optional() }) }, async ({ mapId, deepValidation }) => textResult(await apiRequest("POST", "/api/topology/lldp/discover", { mapId, ...(deepValidation !== undefined ? { deepValidation } : {}) })));
  server.registerTool("preview_lldp_topology", { title: "Preview LLDP Topology", description: "Return a previously discovered LLDP topology preview by ID without changing anything.", inputSchema: z.object({ previewId: z.string().min(1) }) }, async ({ previewId }) => textResult(await apiRequest("POST", "/api/topology/lldp/preview", { previewId })));
  server.registerTool("apply_lldp_topology", { title: "Apply LLDP Topology", description: "Create only the selected (CREATE_LINK) LLDP adjacency links on a map. Ambiguous or unknown neighbors are never applied.", inputSchema: z.object({ previewId: z.string().min(1), mapId: z.string().min(1), selections: z.array(z.object({ adjacencyId: z.string().min(1), action: z.enum(["CREATE_LINK", "IGNORE"]) })).min(1) }) }, async ({ previewId, mapId, selections }) => textResult(await apiRequest("POST", "/api/topology/lldp/apply", { previewId, mapId, selections })));

  server.registerTool("list_bgp_peers", { title: "List BGP Peers", description: "List current BGP peers (IPv4 and IPv6 together) in compact form. Defaults to the MONITORED scope, which only includes devices with bgpMonitoringEnabled=true. Use scope=ALL to include every device that has at least one persisted BGP peer, and family to restrict the address family.", inputSchema: z.object({ deviceId: z.string().optional(), q: z.string().optional(), state: z.enum(["UP", "DOWN"]).optional(), family: z.enum(["ALL", "IPV4", "IPV6"]).default("ALL"), scope: z.enum(["MONITORED", "ALL"]).default("MONITORED") }) }, async ({ deviceId, q, state, family, scope }) => {
    const query = bgpListQuery(scope, state, q, deviceId, family);
    const result = await apiRequestJson("GET", `/api/bgp${query ? `?${query}` : ""}`);
    if (!result.ok) return textResult(apiErrorText(result));
    const peers = flattenBgpDashboardPeers(result.body).map((peer) => compactBgpPeer(peer));
    return textResult(JSON.stringify(peers, null, 2));
  });
  server.registerTool("get_bgp_peer", { title: "Get BGP Peer", description: "Return current compact details for one known BGP peer: address family, local and remote AS, state, address-family-specific received routes, associated interface with RX/TX and the administratively confirmed adminState (UNKNOWN until an SSH read-back confirms it). Use list_bgp_peers to discover peer ids.", inputSchema: z.object({ peerId: z.string().min(1) }) }, async ({ peerId }) => {
    const result = await apiRequestJson("GET", `/api/bgp/peers/${encodeURIComponent(peerId)}`);
    if (!result.ok) return textResult(apiErrorText(result));
    return textResult(JSON.stringify(compactBgpPeerDetail(result.body as Record<string, unknown>), null, 2));
  });
  server.registerTool("get_bgp_peer_history", { title: "BGP Peer History", description: "Return persisted BGP history for one peer (state samples and state-change events) over a supported period. Traffic history is intentionally excluded; use get_interface_metrics for interface RX/TX history.", inputSchema: z.object({ peerId: z.string().min(1), period: z.enum(["1h", "6h", "24h", "7d"]).default("1h") }) }, async ({ peerId, period }) => {
    const result = await apiRequestJson("GET", `/api/bgp/peers/${encodeURIComponent(peerId)}/history?period=${period}`);
    if (!result.ok) return textResult(apiErrorText(result));
    return textResult(JSON.stringify(compactBgpHistory(result.body), null, 2));
  });
  server.registerTool("discover_bgp", { title: "Discover BGP via SSH", description: "Run a manual SSH BGP discovery for a persisted host. Works even when bgpMonitoringEnabled is false and never enables monitoring automatically. Does not expose SSH credentials.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => textResult(await apiRequest("POST", `/api/hosts/${encodeURIComponent(hostId)}/bgp/discover`)));
  server.registerTool("set_bgp_monitoring", { title: "Set BGP Monitoring", description: "Enable or disable BGP polling for a persisted host by setting Device.bgpMonitoringEnabled. The decision is manual and is never inferred from vendor or model.", inputSchema: z.object({ hostId: z.string().min(1), enabled: z.boolean() }) }, async ({ hostId, enabled }) => {
    const result = await apiRequestJson("PATCH", `/api/hosts/${encodeURIComponent(hostId)}`, { bgpMonitoringEnabled: enabled });
    if (!result.ok) return textResult(apiErrorText(result));
    const host = result.body as Record<string, unknown>;
    return textResult(JSON.stringify({ hostId, hostname: host.hostname ?? null, bgpMonitoringEnabled: host.bgpMonitoringEnabled ?? enabled }, null, 2));
  });

  return server;
}

const httpServer = createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "gmj-netvision-mcp" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createNetVisionMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
    res.on("close", () => { void transport.close(); void server.close(); });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal MCP server error" }));
  }
});

if (process.env.MCP_SKIP_LISTEN !== "1") {
  httpServer.listen(PORT, HOST, () => {
    console.log(`GMJ NetVision MCP listening on http://${HOST}:${PORT}/mcp`);
  });
}