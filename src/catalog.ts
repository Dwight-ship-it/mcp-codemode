// Backend servers and their tools, loaded through mcporter.
import { createRuntime, type Runtime } from "mcporter";
import { declareTool, oneLine, sanitizeName } from "./typegen.ts";
import { policyFor } from "./policy.ts";

export interface Tool {
  server: string;        // namespace in code
  name: string;          // original MCP name
  jsName: string;
  description: string;
  inputSchema: unknown;
}

export interface ServerEntry {
  name: string;          // namespace in code (sanitized)
  backend: string;       // mcporter server name
  description: string;
  instructions?: string;
  tools: Map<string, Tool>; // by jsName
  error?: string;
}

export class Catalog {
  runtime!: Runtime;
  servers = new Map<string, ServerEntry>();
  ready: Promise<void>;
  private configPath: string;
  private log: (s: string) => void;

  constructor(configPath: string, log: (s: string) => void) {
    this.configPath = configPath;
    this.log = log;
    this.ready = this.load();
  }

  private async load() {
    this.runtime = await createRuntime({ configPath: this.configPath, clientInfo: { name: "mcp-codemode", version: "0.1.0" } });
    await Promise.all(this.runtime.listServers().map((b) => this.loadServer(b)));
  }

  private retrying = new Map<string, Promise<void>>();
  /** Reload a server that failed earlier, at most once per minute. */
  retry(entry: ServerEntry): Promise<void> {
    const last = (entry as any).failedAt ?? 0;
    if (Date.now() - last < 60_000) return Promise.resolve();
    let p = this.retrying.get(entry.backend);
    if (!p) {
      p = this.loadServer(entry.backend).finally(() => this.retrying.delete(entry.backend));
      this.retrying.set(entry.backend, p);
    }
    return p;
  }

  retryFailed() {
    for (const s of this.servers.values()) if (s.error) void this.retry(s);
  }

  async loadServer(backend: string) {
    const def: any = this.runtime.getDefinition(backend);
    const entry: ServerEntry = { name: sanitizeName(backend), backend, description: def?.description ?? "", tools: new Map() };
    this.servers.set(entry.name, entry);
    try {
      const tools = await this.runtime.listTools(backend, { includeSchema: true, disableOAuth: true, timeoutMs: 60_000 });
      for (const t of tools) {
        const jsName = sanitizeName(t.name);
        entry.tools.set(jsName, { server: entry.name, name: t.name, jsName, description: t.description ?? "", inputSchema: t.inputSchema });
      }
      entry.instructions = await this.runtime.getInstructions?.(backend).catch(() => undefined);
      this.log(`loaded ${backend}: ${entry.tools.size} tools`);
    } catch (e: any) {
      entry.error = oneLine(e?.message ?? String(e), 300);
      (entry as any).failedAt = Date.now();
      this.log(`could not load ${backend}: ${entry.error}`);
    }
  }

  /** One line per server, for the run_code description. */
  summary(): string {
    return [...this.servers.values()]
      .map((s) => `- ${s.name}: ${s.description}${s.error ? ` (unavailable: ${s.error})` : ` (${s.tools.size} tools)`}`)
      .join("\n");
  }

  search(query: string, server?: string, limit = 8, notesShown = new Set<string>(), seen = new Set<Tool>()): string {
    const scope = [...this.servers.values()].filter((s) => !server || s.name === server || s.backend === server);
    if (!scope.length) return `No server named "${server}". Servers:\n${this.summary()}`;
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const all = scope.flatMap((s) => [...s.tools.values()]);

    // Empty query on one server: list every tool name (cheap overview).
    if (!words.length || query.trim() === "*") {
      return scope.map((s) => `${s.name} (${s.tools.size} tools): ${[...s.tools.keys()].join(", ")}`).join("\n\n") +
        "\n\nCall search_tools again with words from the names you need to get their types.";
    }
    const scored = all.map((t) => {
      const name = t.name.toLowerCase(), desc = t.description.toLowerCase();
      let score = 0;
      const joined = words.join("_");
      if (name.replace(/-/g, "_") === joined) score += 30; // "list projects" -> list_projects
      else if (name.replace(/-/g, "_").includes(joined)) score += 8;
      for (const w of words) {
        if (name === w) score += 10;
        else if (name.includes(w)) score += 4;
        if (desc.includes(w)) score += 1;
      }
      return { t, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.t.name.length - b.t.name.length).slice(0, Math.max(1, Math.min(limit, 25)));
    if (!scored.length) return `No tools match "${query}". Try other words, or an empty query with a server to list all names.\n${this.summary()}`;

    const fresh = scored.filter(({ t }) => !seen.has(t)); // declared for an earlier query
    if (!fresh.length) return "// (already shown above)";
    const byServer = new Map<string, Tool[]>();
    for (const { t } of fresh) seen.add(t);
    for (const { t } of fresh) byServer.set(t.server, [...(byServer.get(t.server) ?? []), t]);
    const blocks: string[] = [];
    for (const [name, tools] of byServer) {
      const s = this.servers.get(name)!;
      const p = policyFor(s.backend);
      const notes = s.instructions && !notesShown.has(name) ? `// ${name} notes: ${oneLine(s.instructions, 700)}\n` : "";
      notesShown.add(name);
      const decls = tools.map((t) => declareTool({ ...t, access: p.access(t.name) })).join("\n");
      blocks.push(`${notes}declare namespace ${name} {\n${decls}\n}`);
    }
    return blocks.join("\n\n");
  }

  /** Several searches, one answer: each function declared once, grouped by server. */
  searchMany(queries: string[], server?: string, limit = 6): string {
    if (queries.length === 1) return this.search(queries[0], server, limit);
    const notesShown = new Set<string>();
    const seen = new Set<Tool>();
    const parts = queries.map((q) => `// search: ${q}\n${this.search(q, server, limit, notesShown, seen)}`);
    return parts.join("\n\n");
  }

  namespaces(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const s of this.servers.values()) out[s.name] = [...s.tools.keys()];
    return out;
  }
}
