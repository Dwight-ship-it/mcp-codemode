// MCP Code Mode gateway: one MCP server in front of every backend MCP server.
// Front-end tools: search_tools (find APIs, get TypeScript types) and run_code
// (run a script against those APIs in a Deno sandbox; writes ask the user first).
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Catalog } from "./catalog.ts";
import { policyFor } from "./policy.ts";
import { auditLog, requestApproval, type Answer } from "./approval.ts";
import { runInSandbox } from "./sandbox.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATE = process.env.CODEMODE_STATE ?? join(ROOT, ".state");
const AUDIT = join(STATE, "audit.jsonl");
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const STDIO = argv.includes("--stdio");
const PORT = Number(flag("--port") ?? process.env.CODEMODE_PORT ?? 7801);
const CONFIG = flag("--config") ?? join(ROOT, "config", "mcporter.json");
// Test modes skip the dialog. Only for automated tests and measurement runs, never for daily use.
const APPROVALS = (flag("--approvals") ?? "dialog") as "dialog" | "test-approve" | "test-deny";
const MAX_RESULT_CHARS = 24_000;
const RUN_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 120_000;

const log = (s: string) => process.stderr.write(`[codemode] ${s}\n`);
if (APPROVALS !== "dialog") {
  if (STDIO || PORT === 7801) { log("refusing: test approval modes never run on stdio or the daily-use port 7801"); process.exit(2); }
  log(`WARNING: approvals in ${APPROVALS} mode (tests only)`);
}
const catalog = new Catalog(CONFIG, log);

// ---------- results ----------

interface RunState {
  client: string;
  images: Map<string, { data: string; mimeType: string }>;
  shown: Set<string>;
  untrusted: string[];
  approveRest: boolean;
  calls: number;
  done: boolean;
  logs: string[];
  logChars: number;
}

/** MCP CallToolResult -> plain value for the script. Images become { type: "image", ref }. */
function toValue(result: any, run: RunState): unknown {
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) return result;
  if (result.isError) {
    const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    throw new Error(text || "Tool returned an error");
  }
  if (result.structuredContent !== undefined) {
    const imgs = result.content.filter((c: any) => c.type === "image").map((c: any) => keepImage(c, run));
    return imgs.length ? { ...result.structuredContent, images: imgs } : result.structuredContent;
  }
  const items = result.content.map((c: any) => {
    if (c.type === "text") { try { return JSON.parse(c.text); } catch { return c.text; } }
    if (c.type === "image") return keepImage(c, run);
    if (c.type === "resource") return { type: "resource", uri: c.resource?.uri, text: c.resource?.text, mimeType: c.resource?.mimeType };
    if (c.type === "resource_link") return { type: "resource_link", uri: c.uri, name: c.name };
    return c;
  });
  return items.length === 1 ? items[0] : items;
}

function keepImage(c: any, run: RunState) {
  const ref = `img_${run.images.size + 1}`;
  run.images.set(ref, { data: c.data, mimeType: c.mimeType ?? "image/png" });
  return { type: "image", ref, mimeType: c.mimeType ?? "image/png", note: "Pass to show() to let the model see it" };
}

function collectRefs(v: unknown, out: Set<string>, depth = 0) {
  if (depth > 8 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) collectRefs(x, out, depth + 1); return; }
  const o = v as Record<string, unknown>;
  if (o.type === "image" && typeof o.ref === "string") out.add(o.ref);
  for (const x of Object.values(o)) collectRefs(x, out, depth + 1);
}

function truncate(text: string, max = MAX_RESULT_CHARS) {
  return text.length <= max ? text : text.slice(0, max) + `\n--- TRUNCATED (${text.length - max} more chars). Filter or summarize inside the script and return less. ---`;
}

// ---------- one script run ----------

interface Session { untrusted: string[] } // outside content read earlier in this client session

async function runCode(code: string, client: string, session: Session) {
  await catalog.ready;
  catalog.retryFailed(); // servers that failed earlier (e.g. offline at login) load in the background for the next script
  // Outside content from earlier scripts reached the model too, so it carries over.
  const run: RunState = { client, images: new Map(), shown: new Set(), untrusted: session.untrusted, approveRest: false, calls: 0, done: false, logs: [], logChars: 0 };

  const markUntrusted = (source: string) => { run.untrusted.push(source); run.approveRest = false; }; // every later write asks again

  const approve = async (server: string, tool: string, reason: string, args: any) => {
    let answer: Answer = "approve-rest";
    if (!run.approveRest) {
      answer = await requestApproval({
        client, server, tool, reason, args,
        untrustedSources: run.untrusted, allowApproveRest: run.untrusted.length === 0, cancelled: () => run.done,
      }, APPROVALS);
    }
    if (run.done) answer = "deny"; // the script ended while the dialog was open
    auditLog(AUDIT, { client, server, tool, answer, reason, args });
    const what = `${server}.${tool} (${reason})`;
    if (answer === "deny") throw new Error(`The user denied ${what}. Do not retry it; tell them what you wanted to do.`);
    if (answer === "no-answer") throw new Error(`The user did not answer the approval dialog for ${what} within 2 minutes, so it did not run. Tell them; they may be away.`);
    if (answer === "dialog-failed") throw new Error(`The approval dialog for ${what} could not be shown, so it did not run. Tell the user.`);
    // Outside content may have arrived while the dialog was open; then the approval covers this call only.
    if (answer === "approve-rest" && run.untrusted.length === 0) run.approveRest = true;
  };

  const onCall = async (ns: string, jsName: string, args: any): Promise<unknown> => {
    if (ns === "$") {
      if (jsName === "show") { collectRefs(args?.value, run.shown); return { shown: [...run.shown] }; }
      if (jsName === "resource") {
        const s = catalog.servers.get(String(args?.server));
        if (!s) throw new Error(`Unknown server ${args?.server}`);
        if (++run.calls > 200) throw new Error("More than 200 tool calls in one script; split the work.");
        // No per-server rule covers resource URIs, so reading one asks, and its content counts as outside content.
        await approve(s.backend, "resources/read", "reads a resource that no rule covers", { uri: String(args?.uri) });
        markUntrusted(`${s.backend}.resource`);
        return toValue(await catalog.runtime.readResource(s.backend, String(args?.uri), { disableOAuth: true }), run);
      }
      throw new Error(`Unknown helper ${jsName}`);
    }
    const server = catalog.servers.get(ns);
    const tool = server?.tools.get(jsName);
    if (!server || !tool) throw new Error(`${ns}.${jsName} does not exist`);
    if (++run.calls > 200) throw new Error("More than 200 tool calls in one script; split the work.");
    const policy = policyFor(server.backend);
    const verdict = policy.check(tool.name, args ?? {});
    if (verdict.ask) await approve(server.backend, tool.name, verdict.reason, args ?? {});
    if (policy.untrusted?.(tool.name)) markUntrusted(`${server.backend}.${tool.name}`); // before the call: its errors carry outside text too
    const result = await catalog.runtime.callTool(server.backend, tool.name, { args, timeoutMs: CALL_TIMEOUT_MS, disableOAuth: true });
    return toValue(result, run);
  };

  const onLog = (level: string, text: string) => {
    if (run.logChars > 8000) return;
    const line = (level === "log" || level === "info" ? "" : `[${level}] `) + text;
    run.logs.push(line.slice(0, 2000));
    run.logChars += line.length;
  };

  const outcome = await runInSandbox({ code, servers: catalog.namespaces(), onCall, onLog, timeoutMs: RUN_TIMEOUT_MS });
  run.done = true;
  if (outcome.ok) collectRefs(outcome.value, run.shown);
  const head = outcome.ok
    ? (typeof outcome.value === "string" ? outcome.value : JSON.stringify(outcome.value))
    : `Error: ${outcome.error}`;
  const logText = run.logs.length ? `\n\nconsole output:\n${run.logs.join("\n")}` : "";
  const text = truncate(`${head}${logText}\n\n(${run.calls} tool calls)`);
  // Opt-in run log for tuning (CODEMODE_RUN_LOG=1): scripts and outcome sizes, never tool results.
  if (process.env.CODEMODE_RUN_LOG === "1") auditLog(join(STATE, "runs.jsonl"), { client, code: code.slice(0, 4000), ok: outcome.ok, error: outcome.error?.slice(0, 300), resultChars: text.length, toolCalls: run.calls });
  const content: any[] = [{ type: "text", text }];
  for (const ref of run.shown) {
    const img = run.images.get(ref);
    if (img) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  return { content, isError: !outcome.ok };
}

// ---------- MCP front end ----------

const RUN_CODE_DOC = (servers: string) => `Run a JavaScript script that calls MCP tools as typed async functions, and get back only what it returns.
Use this instead of calling tools one by one: chain calls, loop, filter and summarize inside the script, return a small result.

Servers (each is a global namespace in the script):
${servers}

How to:
1. Call search_tools first to get the exact function names and argument types.
2. Write the script body; use await and end with return. Do the whole task in one script when you can: if you don't know a result's shape, handle both likely shapes or log a sample and continue. Example:
   const docs = await photocraft.command_list({ filter: "blur" });
   return docs.slice(0, 5).map(d => d.id);
3. Every function takes ONE object argument (the tool's parameters) and returns the parsed result.
4. Images come back as { type: "image", ref }. Call show(img) (or return it) so you can see it.
5. console.log output is returned as logs. Read a resource with ns.$resource(uri).
6. Actions that save, export, send, deploy, delete or spend money pause and ask the user in a dialog. If they deny, the call throws; don't retry it.
7. The apps here are the gateway's own headless sessions, shared by every agent: a document you opened with a direct tool is not open here, and the active document may belong to someone else. Open or create the file inside the script and address it explicitly (by index or id); never assume the active document is yours.
Limits: no network or files except through these tools, 120 s run time, 200 tool calls, ~24k chars of output.`;

function buildServer(): McpServer {
  const session: Session = { untrusted: [] };
  const server = new McpServer({ name: "codemode", version: "0.1.0" }, {
    instructions: "MCP Code Mode gateway. All of the user's MCP servers are behind two tools: search_tools (find functions and their TypeScript types) and run_code (run a script that calls them). Prefer one run_code script over many small calls.",
  });
  const clientName = () => {
    const v = server.server.getClientVersion();
    return v ? `${v.name} ${v.version}` : "unknown client";
  };
  server.server.oninitialized = () => {
    const caps = server.server.getClientCapabilities();
    log(`client connected: ${clientName()} (elicitation: ${caps?.elicitation ? "yes" : "no"})`);
    auditLog(join(STATE, "clients.jsonl"), { client: clientName(), elicitation: !!caps?.elicitation, capabilities: caps });
  };

  server.registerTool("search_tools", {
    title: "Find MCP functions",
    description: "Search the MCP servers behind run_code and get TypeScript declarations for matching functions. Ask for everything the task needs in one call: put one search per step in queries (e.g. [\"list projects\", \"deployments\", \"runtime errors\"]). Pass server with an empty query to list all its function names.",
    inputSchema: {
      queries: z.array(z.string()).optional().describe("Several searches at once, one per step of the task"),
      query: z.string().optional().describe("A single search; empty or '*' with server lists all names"),
      server: z.string().optional().describe("Limit to one server namespace"),
      limit: z.number().int().min(1).max(25).optional().describe("Max functions per search (default 6)"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ queries, query, server: srv, limit }) => {
    await catalog.ready;
    const qs = queries?.length ? queries : [query ?? ""];
    return { content: [{ type: "text", text: truncate(catalog.searchMany(qs, srv, limit ?? 6)) }] };
  });

  server.registerTool("run_code", {
    title: "Run a script against MCP tools",
    description: RUN_CODE_DOC(catalog.servers.size ? catalog.summary() : "(loading; call search_tools to see them)"),
    inputSchema: { code: z.string().describe("Script body (JavaScript, top-level await allowed, end with return)") },
  }, async ({ code }) => runCode(code, clientName(), session) as any);

  return server;
}

// ---------- transports ----------

function loadToken(): string {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const p = join(STATE, "token");
  if (!existsSync(p)) writeFileSync(p, randomBytes(24).toString("hex") + "\n", { mode: 0o600 });
  return readFileSync(p, "utf8").trim();
}

function authorized(req: IncomingMessage, token: string): boolean {
  const h = String(req.headers.authorization ?? "");
  const given = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function main() {
  if (STDIO) {
    await catalog.ready;
    await buildServer().connect(new StdioServerTransport());
    log("serving on stdio");
    return;
  }
  const token = loadToken();
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/mcp")) { res.writeHead(404).end(); return; }
      if (!authorized(req, token)) { res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized"); return; }
      const sid = req.headers["mcp-session-id"];
      let transport = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (!transport) {
        if (req.method !== "POST" || sid) { res.writeHead(sid ? 404 : 400).end(); return; }
        await catalog.ready;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, transport!); },
          onsessionclosed: (id) => { sessions.delete(id); },
          enableDnsRebindingProtection: true,
          allowedHosts: [`127.0.0.1:${PORT}`, `localhost:${PORT}`],
        });
        transport.onclose = () => { if (transport!.sessionId) sessions.delete(transport!.sessionId); };
        await buildServer().connect(transport);
      }
      await transport.handleRequest(req, res);
    } catch (e: any) {
      log(`request failed: ${e?.stack ?? e}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  http.listen(PORT, "127.0.0.1", () => log(`listening on http://127.0.0.1:${PORT}/mcp (token in ${join(STATE, "token")})`));
  const stop = async () => { http.close(); await catalog.runtime?.close().catch(() => {}); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => { log(String(e?.stack ?? e)); process.exit(1); });
