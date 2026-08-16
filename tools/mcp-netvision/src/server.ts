import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
const PORT = Number(process.env.MCP_PORT ?? 3334);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";

function ensureInsideRepo(relativePath: string): string {
  const resolved = path.resolve(repoRoot, relativePath);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) {
    throw new Error("Path outside repository is not allowed");
  }
  return resolved;
}

async function runProcess(executable: string, args: string[], cwd = repoRoot): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    return `${stdout}${stderr}`.trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const stdout = error?.stdout ?? "";
    const stderr = error?.stderr ?? "";
    const message = error?.message ?? String(error);
    return `${stdout}${stderr}\n${message}`.trim();
  }
}

async function runGit(args: string[]) {
  return runProcess("git", args);
}

async function runNpm(script: string) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return runProcess(comspec, ["/d", "/s", "/c", `npm run ${script}`], repoRoot);
  }
  return runProcess("npm", ["run", script], repoRoot);
}

function createNetVisionMcpServer() {
  const server = new McpServer({ name: "gmj-netvision-dev", version: "0.3.1" });

  server.registerTool(
    "repo_status",
    { title: "Repository Status", description: "Show the Git status of the GMJ NetVision repository.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: (await runGit(["status", "--short", "--branch"])) || "Working tree clean" }] }),
  );

  server.registerTool(
    "repo_diff",
    { title: "Repository Diff", description: "Show the current uncommitted Git diff.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: (await runGit(["diff"])) || "No tracked changes" }] }),
  );

  server.registerTool(
    "repo_read_file",
    { title: "Read Repository File", description: "Read a UTF-8 text file inside the GMJ NetVision repository.", inputSchema: z.object({ path: z.string().min(1) }) },
    async ({ path: relativePath }) => ({ content: [{ type: "text", text: await readFile(ensureInsideRepo(relativePath), "utf8") }] }),
  );

  server.registerTool(
    "repo_write_file",
    { title: "Write Repository File", description: "Create or replace a UTF-8 text file inside the GMJ NetVision repository.", inputSchema: z.object({ path: z.string().min(1), content: z.string() }) },
    async ({ path: relativePath, content }) => {
      const absolutePath = ensureInsideRepo(relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
      return { content: [{ type: "text", text: `Written: ${relativePath}` }] };
    },
  );

  server.registerTool(
    "repo_search",
    { title: "Search Repository", description: "Search text recursively inside the GMJ NetVision Git repository.", inputSchema: z.object({ query: z.string().min(1) }) },
    async ({ query }) => ({ content: [{ type: "text", text: (await runGit(["grep", "-n", "-I", "-e", query])) || "No matches" }] }),
  );

  server.registerTool(
    "run_lint",
    { title: "Run Lint", description: "Run the GMJ NetVision lint script.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: await runNpm("lint") }] }),
  );

  server.registerTool(
    "run_typecheck",
    { title: "Run Typecheck", description: "Run the GMJ NetVision TypeScript typecheck.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: await runNpm("typecheck") }] }),
  );

  server.registerTool(
    "run_tests",
    { title: "Run Tests", description: "Run the GMJ NetVision test suite.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: await runNpm("test") }] }),
  );

  server.registerTool(
    "run_build",
    { title: "Run Build", description: "Run the GMJ NetVision production build.", inputSchema: z.object({}) },
    async () => ({ content: [{ type: "text", text: await runNpm("build") }] }),
  );

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
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal MCP server error" }));
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`GMJ NetVision MCP listening on http://${HOST}:${PORT}/mcp`);
});
