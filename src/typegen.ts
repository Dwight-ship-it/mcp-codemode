// JSON Schema -> TypeScript declarations for the code API.
// Small on purpose: covers what MCP tool schemas use in practice.

type Schema = Record<string, any> | boolean | undefined;

const MAX_DEPTH = 6;

export function schemaToType(schema: Schema, depth = 0): string {
  if (schema === true || schema === undefined || schema === null) return "unknown";
  if (schema === false) return "never";
  if (depth > MAX_DEPTH) return "unknown";
  const s = schema as Record<string, any>;

  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ") || "never";
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(s[key])) return union(s[key].map((x: Schema) => schemaToType(x, depth + 1)));
  }
  if (Array.isArray(s.allOf)) return s.allOf.map((x: Schema) => schemaToType(x, depth + 1)).join(" & ") || "unknown";

  const type = s.type;
  if (Array.isArray(type)) return union(type.map((t: string) => schemaToType({ ...s, type: t }, depth)));
  switch (type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      const item = schemaToType(s.items, depth + 1);
      return /[ |&]/.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    case "object":
      return objectType(s, depth);
    default:
      if (s.properties) return objectType(s, depth);
      return "unknown";
  }
}

function union(parts: string[]): string {
  const uniq = [...new Set(parts)];
  return uniq.length ? uniq.join(" | ") : "unknown";
}

function objectType(s: Record<string, any>, depth: number): string {
  const props: Record<string, Schema> = s.properties ?? {};
  const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
  const pad = "  ".repeat(depth + 1);
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const doc = typeof prop === "object" && prop?.description ? oneLine(prop.description, 160) : "";
    if (doc) lines.push(`${pad}/** ${doc} */`);
    lines.push(`${pad}${safeKey(name)}${required.has(name) ? "" : "?"}: ${schemaToType(prop, depth + 1)};`);
  }
  const extra = s.additionalProperties;
  if (extra && extra !== false) {
    lines.push(`${pad}[key: string]: ${extra === true ? "unknown" : schemaToType(extra, depth + 1)};`);
  }
  if (!lines.length) return extra === false ? "{}" : "Record<string, unknown>";
  return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}

function safeKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

export function oneLine(text: string, max = 300): string {
  const t = String(text).replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

const RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(" "));

export function sanitizeName(name: string): string {
  let n = name.replace(/[-.\s]+/g, "_").replace(/[^\w$]/g, "");
  if (/^\d/.test(n)) n = "_" + n;
  if (RESERVED.has(n)) n += "_";
  return n || "_";
}

export interface ToolDecl {
  server: string;
  jsName: string;
  description?: string;
  inputSchema?: unknown;
  access: string; // "read" | "write" | "depends"
}

/** One tool as a TypeScript declaration inside its server namespace. */
export function declareTool(t: ToolDecl): string {
  const args = schemaToType((t.inputSchema as Schema) ?? { type: "object" }, 1);
  const doc = t.description ? oneLine(t.description, 400) : "";
  const tag = t.access === "read" ? "" : t.access === "write" ? " [asks the user first]" : " [may ask the user first]";
  const req = (t.inputSchema as any)?.required;
  const optional = !Array.isArray(req) || req.length === 0;
  return `  /** ${doc}${tag} */\n  function ${t.jsName}(args${optional ? "?" : ""}: ${args}): Promise<any>;`;
}
