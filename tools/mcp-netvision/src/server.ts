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

async function apiRequest(method: "GET" | "POST", route: string): Promise<string> {
  try {
    const response = await fetch(`${API_BASE_URL}${route}`, {
      method,
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return JSON.stringify({ status: response.status, ok: response.ok, body: sanitize(body) }, null, 2);
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
  }
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

function createNetVisionMcpServer() {
  const server = new McpServer({ name: "gmj-netvision-implantar", version: "0.5.0" });

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

  server.registerTool("api_list_hosts", { title: "List NetVision Hosts", description: "List persisted NetVision hosts through the local API. Secret-like fields are redacted defensively.", inputSchema: z.object({ q: z.string().optional(), source: z.enum(["ZABBIX", "SSH", "SNMP"]).optional() }) }, async ({ q, source }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (source) params.set("source", source);
    return textResult(await apiRequest("GET", `/api/hosts${params.size ? `?${params.toString()}` : ""}`));
  });
  server.registerTool("api_get_host", { title: "Get NetVision Host", description: "Read one persisted NetVision host by ID with defensive secret redaction.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => textResult(await apiRequest("GET", `/api/hosts/${encodeURIComponent(hostId)}`)));
  server.registerTool("api_test_snmp", { title: "Test Host SNMP", description: "Test the stored SNMP configuration for a persisted host without exposing credentials.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => textResult(await apiRequest("POST", `/api/hosts/${encodeURIComponent(hostId)}/test/snmp`)));
  server.registerTool("api_discover_interfaces", { title: "Discover SNMP Interfaces", description: "Run SNMP interface discovery for a persisted host and persist the discovered interfaces.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => textResult(await apiRequest("POST", `/api/hosts/${encodeURIComponent(hostId)}/interfaces/discover`)));
  server.registerTool("api_poll_host", { title: "Poll Host SNMP", description: "Run one manual SNMP poll for a persisted host. Automatic polling remains unchanged.", inputSchema: z.object({ hostId: z.string().min(1) }) }, async ({ hostId }) => textResult(await apiRequest("POST", `/api/hosts/${encodeURIComponent(hostId)}/poll`)));
  server.registerTool("api_interface_history", { title: "Interface Metric History", description: "Read persisted interface metric history for a supported period.", inputSchema: z.object({ interfaceId: z.string().min(1), period: z.enum(["15m", "1h", "6h", "24h", "7d"]).default("1h") }) }, async ({ interfaceId, period }) => textResult(await apiRequest("GET", `/api/interfaces/${encodeURIComponent(interfaceId)}/history?period=${period}`)));

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

httpServer.listen(PORT, HOST, () => {
  console.log(`GMJ NetVision MCP listening on http://${HOST}:${PORT}/mcp`);
});