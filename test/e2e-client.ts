// Manual end-to-end check: connect to a running gateway as an MCP client.
// Usage: node test/e2e-client.ts <port> <tool> '<json args>'
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [port, tool, json] = process.argv.slice(2);
const token = readFileSync(new URL("../.state/token", import.meta.url), "utf8").trim();
const client = new Client({ name: "e2e-test", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
if (tool === "list") {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`== ${t.name}\n${t.description}\n`);
} else {
  const r: any = await client.callTool({ name: tool, arguments: JSON.parse(json ?? "{}") });
  for (const c of r.content) console.log(c.type === "text" ? c.text : `[${c.type} ${c.mimeType} ${c.data?.length} b64 chars]`);
  console.log("isError:", !!r.isError);
}
await client.close();
