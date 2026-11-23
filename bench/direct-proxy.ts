// Benchmark baseline: expose one backend's tools 1:1 over stdio (what a client would see
// connecting to that server directly). Calls the policy would ask for are refused, so a
// benchmark can never change anything.
// Usage: node bench/direct-proxy.ts <backend>
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRuntime } from "mcporter";
import { fileURLToPath } from "node:url";
import { policyFor } from "../src/policy.ts";

const backend = process.argv[2];
const runtime = await createRuntime({ configPath: fileURLToPath(new URL("../config/mcporter.json", import.meta.url)) });
const tools = await runtime.listTools(backend, { includeSchema: true, disableOAuth: true });
const instructions = await runtime.getInstructions?.(backend).catch(() => undefined);
const server = new Server({ name: backend, version: "0" }, { capabilities: { tools: {} }, instructions });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema as any) ?? { type: "object" } })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const v = policyFor(backend).check(req.params.name, req.params.arguments ?? {});
  if (v.ask) return { content: [{ type: "text", text: `Refused in benchmark: ${v.reason}` }], isError: true };
  return (await runtime.callTool(backend, req.params.name, { args: req.params.arguments ?? {}, disableOAuth: true })) as any;
});
await server.connect(new StdioServerTransport());
